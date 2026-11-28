#!/usr/bin/env node
// Merge a daily research file into a map's data file — item by item, quarantining whatever fails.
// Usage: node scripts/merge-update.mjs [data/incoming/ukraine.json] [--dry-run] [--no-links]
//
// Rules (see UPDATE_PROMPT.md and data/SCHEMA.md):
//  - Events are merged by id. New ids are added; a matching id replaces the old event. Nothing is ever deleted.
//  - An existing event's date cannot change. New events must be dated within the last MAX_AGE_DAYS days.
//  - Stats are merged by exact label. Lanes (Middle East shipping lanes) are merged by id; their points and colour never change. Sources are added to the registry; an existing source id cannot change url.
//  - New events (and events whose position changes) need a `place` that exists in the GeoNames place list,
//    and the marker must be near it: city 15 km, approx 40 km, oblast 200 km (scripts/lib/places.mjs).
//  - At most MAX_NEW new events and MAX_UPDATED updated events per run; anything over the cap is quarantined, not merged.
//  - PARTIAL MERGE: each incoming item is applied tentatively and the merged-so-far file is validated.
//    An item that introduces a validation error, fails the place check, breaks a rule above, or cites a new
//    source whose link is dead (404/410/no such host) is QUARANTINED — skipped and listed in UPDATE_LOG.md —
//    while the valid items still merge. Only structural failures (unreadable incoming file, unknown map) and
//    a run where every item is quarantined reject the whole update, leaving data/ untouched.
//  - On success: data file rewritten, meta.lastUpdated bumped, UPDATE_LOG.md appended, incoming file deleted. Exit 0.
//  - On total failure: data file untouched, reason appended to UPDATE_LOG.md, exit 1.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate, checkLinks } from "./lib/validate-core.mjs";
import { checkPlace } from "./lib/places.mjs";

const MAX_NEW = 40, MAX_UPDATED = 30, MAX_AGE_DAYS = 10, MAX_NOTES = 10;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run"), LINKS = !args.includes("--no-links");
const inFile = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(ROOT, "data/incoming/ukraine.json"));
const LOG = path.join(ROOT, "UPDATE_LOG.md");

function torontoStamp(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(d).map((x) => [x.type, x.value]));
  const off = (p.timeZoneName || "GMT-05:00").replace("GMT", "") || "+00:00";
  return { iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`, human: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} Toronto`, day: `${p.year}-${p.month}-${p.day}` };
}
const now = torontoStamp();

function log(lines) {
  if (DRY) { console.log(lines.join("\n")); return; }
  const head = "# Data update log\n\nNewest first. Written by scripts/merge-update.mjs on every daily run.\n\n";
  const old = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").replace(head, "") : "";
  fs.writeFileSync(LOG, head + lines.join("\n") + "\n\n" + old);
}
let cfg = null;
function fail(reasons, warnings = []) {
  log([`## ${now.human} — ${cfg ? cfg.name + " — " : ""}FAILED (data not changed)`, ...reasons.slice(0, 40).map((r) => `- ${r}`), ...(reasons.length > 40 ? [`- …and ${reasons.length - 40} more`] : []), ...warnings.slice(0, 10).map((w) => `- warning: ${w}`)]);
  console.error("UPDATE REJECTED — data/ unchanged:\n" + reasons.map((r) => "  - " + r).join("\n"));
  process.exit(1);
}

let inc;
try { inc = JSON.parse(fs.readFileSync(inFile, "utf8")); }
catch (ex) { fail([`incoming file ${path.relative(ROOT, inFile)} missing or not valid JSON: ${ex.message}`]); }
const maps = JSON.parse(fs.readFileSync(path.join(ROOT, "web/maps.json"), "utf8")).maps;
cfg = maps.find((m) => m.id === inc.map) || null;
if (!cfg) fail([`incoming "map" must be one of ${maps.map((m) => m.id).join(", ")}`]);
if (!Array.isArray(inc.events)) fail(['incoming "events" must be a list (it can be empty)']);
const dataFile = path.join(ROOT, cfg.data);
const cur = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const next = structuredClone(cur);

// Quarantine: items that were skipped, with the reason. Everything else merges.
const quarantine = [];
const q = (kind, id, reason) => { let r = String(reason); const pre = `${kind} "${id}": `; if (r.startsWith(pre)) r = r.slice(pre.length); quarantine.push({ kind, id, reason: r.slice(0, 300) }); };
const qLines = () => quarantine.map((x) => `${x.kind} "${x.id}": ${x.reason}`);

// Validation baseline: errors already present in the current data are never blamed on incoming items.
const baseErrSet = new Set(validate(cur, cfg, { today: now.day }).errors);
const newErrors = (errs) => errs.filter((e) => !baseErrSet.has(e));
const checkNext = () => newErrors(validate(next, cfg, { today: now.day }).errors);

const inEvents = Array.isArray(inc.events) ? inc.events : [];
const inStats = Array.isArray(inc.stats) ? inc.stats : [];
const inSources = Array.isArray(inc.sources) ? inc.sources : [];
const inLanes = Array.isArray(inc.lanes) ? inc.lanes : [];

// Sources: explicit registry additions first, then any new ids used inline by events and lanes.
// A source id that already exists with a different url is not added; items citing it fail their
// tentative validation below (url differs from the registry) and are quarantined individually.
const reg = new Map(next.sources.map((s) => [s.id, s]));
const newSourceUrls = [];
function addSource(s, where) {
  if (!s || !s.id) return;
  const old = reg.get(s.id);
  if (old) return;
  const entry = { id: s.id, title: s.title, url: s.url };
  reg.set(s.id, entry); next.sources.push(entry); newSourceUrls.push(s.url);
}
inSources.forEach((s) => addSource(s));
inEvents.forEach((e) => (e && Array.isArray(e.sources) ? e.sources : []).forEach((s) => addSource(s)));
inLanes.forEach((l) => (l && Array.isArray(l.sources) ? l.sources : []).forEach((s) => addSource(s)));

// Events — one at a time: rule checks, tentative apply, validate, roll back on any new error.
const byId = new Map(next.events.map((e, i) => [e.id, i]));
const added = [], updated = [];
const minDate = new Date(Date.parse(now.day + "T00:00:00Z") - MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
const seen = new Set();
for (const e of inEvents) {
  if (!e || typeof e.id !== "string") { q("event", "(no id)", "an incoming event has no id"); continue; }
  if (seen.has(e.id)) { q("event", e.id, "appears twice in the incoming file"); continue; }
  seen.add(e.id);
  const idx = byId.has(e.id) ? byId.get(e.id) : -1;
  const old = idx >= 0 ? next.events[idx] : null;
  if (old) {
    if (old.date !== e.date) { q("event", e.id, `cannot change the date of an existing event (${old.date} → ${e.date})`); continue; }
    if (JSON.stringify(old) === JSON.stringify(e)) continue;
  } else if (typeof e.date === "string" && e.date < minDate) { q("event", e.id, `dated ${e.date}, older than ${MAX_AGE_DAYS} days — only recent events can be added`); continue; }
  const posChanged = !old || ["lat", "lon", "place", "coordPrecision"].some((k) => JSON.stringify(old[k]) !== JSON.stringify(e[k]));
  if (posChanged) { const pe = checkPlace(e, cfg.id); if (pe) { q("event", e.id, pe); continue; } }
  if (!old && added.length >= MAX_NEW) { q("event", e.id, `over the ${MAX_NEW} new-events-per-run cap`); continue; }
  if (old && updated.length >= MAX_UPDATED) { q("event", e.id, `over the ${MAX_UPDATED} updated-events-per-run cap`); continue; }
  const changed = old ? [...new Set([...Object.keys(old), ...Object.keys(e)])].filter((k) => JSON.stringify(old[k]) !== JSON.stringify(e[k])) : [];
  if (old) next.events[idx] = e; else { next.events.push(e); byId.set(e.id, next.events.length - 1); }
  const errs = checkNext();
  if (errs.length) {
    if (old) next.events[idx] = old; else { next.events.pop(); byId.delete(e.id); }
    q("event", e.id, errs.slice(0, 2).join("; "));
    continue;
  }
  if (old) updated.push({ e, changed, oldStatus: old.status, old }); else added.push(e);
}

// Stats (by label) — same tentative pattern.
const statIdx = new Map(next.stats.map((f, i) => [f.label, i]));
const appliedStats = [];
for (const f of inStats) {
  if (!f || typeof f.label !== "string") { q("stat", "(no label)", "an incoming stat has no label"); continue; }
  const idx = statIdx.has(f.label) ? statIdx.get(f.label) : -1;
  const old = idx >= 0 ? next.stats[idx] : null;
  if (old && JSON.stringify(old) === JSON.stringify(f)) continue;
  if (idx >= 0) next.stats[idx] = f; else { next.stats.push(f); statIdx.set(f.label, next.stats.length - 1); }
  const errs = checkNext();
  if (errs.length) {
    if (idx >= 0) next.stats[idx] = old; else { next.stats.pop(); statIdx.delete(f.label); }
    q("stat", f.label, errs.slice(0, 2).join("; "));
    continue;
  }
  appliedStats.push({ f, old });
}

// Lanes (by id). Status, text, sources and claims can change; the drawn line (points, colour) cannot.
// The incoming lane is overlaid on the existing one: a field it omits is inherited, so a partial
// lane update cannot fail validation over a field it never tried to change (the Nov 25-28 quarantines).
const appliedLanes = [];
if (inLanes.length) {
  next.lanes = next.lanes || [];
  for (const l of inLanes) {
    const i = next.lanes.findIndex((x) => x.id === (l && l.id));
    if (i < 0) { q("lane", (l && l.id) || "(no id)", "lane does not exist; new lanes are added by hand, not by the daily update"); continue; }
    const old = next.lanes[i];
    const merged = { ...old, ...l, points: old.points, color: old.color };
    if (JSON.stringify(merged) === JSON.stringify(old)) continue;
    next.lanes[i] = merged;
    const errs = checkNext();
    if (errs.length) { next.lanes[i] = old; q("lane", l.id, errs.slice(0, 2).join("; ")); continue; }
    appliedLanes.push({ l: merged, old });
  }
}

// Dead-link check on NEW source urls: quarantine just the applied items that cite a dead source.
const warnings = [];
if (LINKS && newSourceUrls.length) {
  const l = await checkLinks(newSourceUrls);
  warnings.push(...l.warnings);
  const deadUrls = new Set();
  for (const err of l.errors) { const m = err.match(/^link (\S+)/); if (m) deadUrls.add(m[1]); else warnings.push(err); }
  if (deadUrls.size) {
    const urlById = new Map(next.sources.map((s) => [s.id, s.url]));
    const badIds = new Set(next.sources.filter((s) => deadUrls.has(s.url)).map((s) => s.id));
    const deadReason = (ids) => "new source link is dead: " + ids.filter((id) => badIds.has(id)).map((id) => urlById.get(id)).join(", ");
    for (let i = added.length - 1; i >= 0; i--) {
      const e = added[i];
      if (e.sources.some((s) => badIds.has(s.id))) { const j = next.events.findIndex((x) => x.id === e.id); if (j >= 0) next.events.splice(j, 1); added.splice(i, 1); q("event", e.id, deadReason(e.sources.map((s) => s.id))); }
    }
    for (let i = updated.length - 1; i >= 0; i--) {
      const u = updated[i];
      if (u.e.sources.some((s) => badIds.has(s.id))) { const j = next.events.findIndex((x) => x.id === u.e.id); if (j >= 0) next.events[j] = u.old; updated.splice(i, 1); q("event", u.e.id, deadReason(u.e.sources.map((s) => s.id))); }
    }
    for (let i = appliedStats.length - 1; i >= 0; i--) {
      const a = appliedStats[i], ids = [...(a.f.sources || []), ...((a.f.rows || []).map((r) => r.source)), a.f.ukraine && a.f.ukraine.source, a.f.russia && a.f.russia.source].filter(Boolean);
      if (ids.some((id) => badIds.has(id))) { const j = next.stats.findIndex((x) => x.label === a.f.label); if (j >= 0) { if (a.old) next.stats[j] = a.old; else next.stats.splice(j, 1); } appliedStats.splice(i, 1); q("stat", a.f.label, deadReason(ids)); }
    }
    for (let i = appliedLanes.length - 1; i >= 0; i--) {
      const a = appliedLanes[i];
      if ((a.l.sources || []).some((s) => badIds.has(s.id))) { const j = next.lanes.findIndex((x) => x.id === a.l.id); if (j >= 0) next.lanes[j] = a.old; appliedLanes.splice(i, 1); q("lane", a.l.id, deadReason(a.l.sources.map((s) => s.id))); }
    }
  }
}

const statsAdded = appliedStats.filter((a) => !a.old).length, statsUpdated = appliedStats.length - statsAdded;
const lanesUpdated = appliedLanes.length;
const changedAnything = added.length || updated.length || appliedStats.length || lanesUpdated;

// Every item defective = the old all-or-nothing failure: data stays untouched.
if (!changedAnything && quarantine.length) fail(qLines());

// Meta
next.events.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
next.meta.lastUpdated = now.iso;
const start = (cur.meta.coverage || "").slice(0, 10) || next.events[0].date;
const end = next.events.reduce((m, e) => (typeof e.date === "string" && e.date > m ? e.date : m), "");
next.meta.coverage = `${start} to ${end}`;
if (Array.isArray(inc.notes) && inc.notes.length) next.meta.notes = inc.notes.slice(0, MAX_NOTES);

// Final safety net: the merged file must introduce no validation errors at all.
const v = validate(next, cfg, { today: now.day });
const finalErrs = newErrors(v.errors);
if (finalErrs.length) fail(finalErrs);
warnings.push(...v.warnings.filter((w) => !cur.sources.some((s) => w.includes(`"${s.id}"`))));

const lines = [`## ${now.human} — ${cfg.name} — OK${quarantine.length ? ` (partial — ${quarantine.length} quarantined)` : ""}${changedAnything ? "" : " (no new information)"}`];
if (added.length) lines.push(`- Added ${added.length} event(s):`, ...added.map((e) => `  - \`${e.id}\` ${e.date} [${e.status}] ${e.title}`));
if (updated.length) lines.push(`- Updated ${updated.length} event(s):`, ...updated.map((u) => `  - \`${u.e.id}\` changed ${u.changed.join(", ")}${u.oldStatus !== u.e.status ? ` (status ${u.oldStatus} → ${u.e.status})` : ""}`));
if (statsAdded || statsUpdated) lines.push(`- Stats: ${statsUpdated} updated, ${statsAdded} added`);
if (lanesUpdated) lines.push(`- Lanes: ${lanesUpdated} updated`);
if (quarantine.length) lines.push(`- Quarantined ${quarantine.length} item(s) — NOT merged:`, ...qLines().map((r) => `  - ${r}`));
if (newSourceUrls.length) lines.push(`- ${newSourceUrls.length} new source link(s)`);
lines.push(`- Totals: ${next.events.length} events, ${next.stats.length} stats, ${next.sources.length} sources; coverage ${next.meta.coverage}`);
warnings.slice(0, 15).forEach((w) => lines.push(`- warning: ${w}`));

if (!DRY) {
  fs.writeFileSync(dataFile, JSON.stringify(next, null, 1) + "\n");
  fs.rmSync(inFile, { force: true });
}
log(lines);
console.log(lines.join("\n"));
