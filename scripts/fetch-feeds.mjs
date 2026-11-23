#!/usr/bin/env node
// Pull headlines from open RSS/Atom feeds, plus each party's official channels (public Telegram
// channel previews and official press-release pages), into data/<map>-feed.json. No dependencies.
// Headlines are auto-pulled and shown as UNVERIFIED in the app's Feed tab.
// Items from official channels carry `official: "<party>"`: they are that party's own claim.
// Usage: node scripts/fetch-feeds.mjs [ukraine|middle-east]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS = {
  ukraine: {
    keywords: /ukrain|russia|kyiv|kremlin|zelensk|putin|crimea|donetsk|kharkiv|black sea|moscow/i,
    feeds: [
      { name: "Kyiv Independent", url: "https://kyivindependent.com/news-archive/rss/", filter: false },
      { name: "Ukrinform", url: "https://www.ukrinform.net/rss/block-lastnews", filter: false },
      { name: "Ukrainska Pravda", url: "https://www.pravda.com.ua/eng/rss/", filter: false },
      { name: "The Guardian (Ukraine)", url: "https://www.theguardian.com/world/ukraine/rss", filter: false },
      { name: "BBC News Europe", url: "https://feeds.bbci.co.uk/news/world/europe/rss.xml", filter: true },
      { name: "UN News Europe", url: "https://news.un.org/feed/subscribe/en/news/region/europe/feed/rss.xml", filter: true },
      { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", filter: true },
      { name: "UK Ministry of Defence (GOV.UK)", url: "https://www.gov.uk/government/organisations/ministry-of-defence.atom", filter: true },
      // Official channels: each party's own claims.
      { name: "General Staff of Ukraine (Telegram)", party: "Ukraine", type: "telegram", channel: "GeneralStaffZSU", filter: false },
      { name: "Russian Defence Ministry (Telegram)", party: "Russia", type: "telegram", channel: "mod_russia", filter: false },
    ],
  },
  "middle-east": {
    keywords: /israel|gaza|palestin|west bank|hamas|hezbollah|lebanon|syria|iran|tehran|iraq|yemen|houthi|hormuz|red sea|saudi|gulf|qatar|jordan|egypt|middle east|idf|irgc/i,
    feeds: [
      { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", filter: true },
      { name: "BBC News Middle East", url: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml", filter: false },
      { name: "UN News Middle East", url: "https://news.un.org/feed/subscribe/en/news/region/middle-east/feed/rss.xml", filter: false },
      { name: "The Guardian (Middle East)", url: "https://www.theguardian.com/world/middleeast/rss", filter: false },
      { name: "France 24 Middle East", url: "https://www.france24.com/en/middle-east/rss", filter: false },
      { name: "Al-Monitor", url: "https://www.al-monitor.com/rss", filter: false },
      { name: "Middle East Eye", url: "https://www.middleeasteye.net/rss", filter: false },
      { name: "UK Ministry of Defence (GOV.UK)", url: "https://www.gov.uk/government/organisations/ministry-of-defence.atom", filter: true },
      // Official channels: each party's own claims. Handles checked 2026-11-20; if one dies, its status shows ok:false.
      { name: "IDF (Telegram)", party: "Israel (IDF)", type: "telegram", channel: "idfofficial", filter: false },
      { name: "State of Israel / PMO (Telegram)", party: "Israel (government)", type: "telegram", channel: "StateofIsraelOfficial", filter: false },
      { name: "US CENTCOM press releases", party: "United States (CENTCOM)", url: "https://www.dvidshub.net/rss/unit/72?type=news", filter: false },
      { name: "Gaza Ministry of Health (Telegram)", party: "Gaza (Ministry of Health)", type: "telegram", channel: "MOHMediaGaza", filter: false },
      { name: "Houthi military spokesman (Telegram)", party: "Houthis (Yemeni Armed Forces)", type: "telegram", channel: "army21ye", filter: false },
      { name: "Tasnim English (Telegram)", party: "Iran (IRGC-affiliated Tasnim)", type: "telegram", channel: "Tasnimnews_en", filter: true },
      { name: "IRNA English (Telegram)", party: "Iran (state agency IRNA)", type: "telegram", channel: "Irna_en", filter: true },
    ],
  },
};
const OFFICIAL_KEEP_HOURS = 72, OFFICIAL_MAX = 120;

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? decode(m[1]) : null; };
const toIso = (s) => { if (!s) return null; const t = Date.parse(s); return isNaN(t) ? null : new Date(t).toISOString(); };

async function get(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept-Language": "en" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return buf.toString("utf8");
  } finally { clearTimeout(t); }
}

// Public Telegram channel preview (https://t.me/s/<channel>): the latest ~20 posts, each cited as https://t.me/<channel>/<n>.
async function fetchTelegram(f, kw) {
  const html = await get(`https://t.me/s/${f.channel}`), out = [];
  const parts = html.split(/(?=<div class="tgme_widget_message_wrap)/);
  for (const p of parts) {
    const id = p.match(/data-post="([^"]+\/\d+)"/); if (!id) continue;
    const txt = p.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = txt ? decode(txt[1].replace(/<br\s*\/?>/gi, " ")) : "";
    if (!text || (f.filter && !kw.test(text))) continue;
    const when = p.match(/<time[^>]*datetime="([^"]+)"/);
    out.push({ headline: text.length > 280 ? text.slice(0, 277).replace(/\s+\S*$/, "") + "…" : text, source: f.name, official: f.party, link: `https://t.me/${id[1]}`, date: toIso(when && when[1]) });
  }
  if (!out.length && !/tgme_widget_message/.test(html)) throw new Error("no posts found (channel moved or preview disabled?)");
  return out.slice(-25).reverse();
}

// An official press-release listing page: collect links matching linkPattern; the title is the link text or the URL slug.
async function fetchHtmlList(f) {
  const html = await get(f.url), base = new URL(f.url), out = [], seen = new Set();
  const re = new RegExp(`<a[^>]+href="((?:https?://[^/"]+)?${f.linkPattern})"[^>]*>([\\s\\S]*?)</a>`, "gi");
  for (const m of html.matchAll(re)) {
    const link = new URL(m[1].replace(/&amp;/g, "&"), base).href; if (seen.has(link)) continue;
    let title = decode(m[2]);
    if (title.length < 12) title = decodeURIComponent(link.replace(/\/$/, "").split("/").pop()).replace(/[-_]+/g, " ");
    seen.add(link); out.push({ headline: title, source: f.name, official: f.party, link, date: null });
  }
  if (!out.length) throw new Error("no press-release links found (page layout changed?)");
  return out.slice(0, 15);
}

async function fetchFeed(f, kw) {
  if (f.type === "telegram") return fetchTelegram(f, kw);
  if (f.type === "html") return fetchHtmlList(f);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(f.url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (world-conflicts-map feed bot)" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    // Some feeds (UN News, Middle East Eye) send gzip without saying so; unpack it ourselves.
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const xml = buf.toString("utf8"), out = [];
    for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) out.push([tag(m[0], "title"), tag(m[0], "link"), tag(m[0], "pubDate") || tag(m[0], "dc:date")]);
    for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) { const l = m[0].match(/<link[^>]*href="([^"]+)"/i); out.push([tag(m[0], "title"), l && l[1].replace(/&amp;/g, "&"), tag(m[0], "updated") || tag(m[0], "published")]); }
    return out.filter(([t, l]) => t && l && (!f.filter || kw.test(t))).slice(0, 25).map(([t, l, d]) => ({ headline: t, source: f.name, link: l.trim(), date: toIso(d) }));
  } finally { clearTimeout(t); }
}

const mapId = process.argv[2] || "ukraine";
const cfg = FEEDS[mapId];
if (!cfg) { console.error(`unknown map "${mapId}"; one of ${Object.keys(FEEDS).join(", ")}`); process.exit(1); }
const OUT = path.join(ROOT, `data/${mapId}-feed.json`);
const entries = [], status = [];
for (const f of cfg.feeds) {
  try { const got = await fetchFeed(f, cfg.keywords); entries.push(...got); status.push({ source: f.name, ok: true, count: got.length }); }
  catch (ex) { status.push({ source: f.name, ok: false, error: String(ex.message || ex).slice(0, 120) }); console.warn("WARN", f.name, ex.message); }
}
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const oldItems = Array.isArray(old.items) ? old.items : [];
const byDate = (a, b) => (b.date || "").localeCompare(a.date || "");
const seen = new Set(), news = entries.filter((e) => !e.official && !seen.has(e.link) && seen.add(e.link)).sort(byDate).slice(0, 150);
// Official channels only show their latest posts, so keep earlier ones from the previous pull for OFFICIAL_KEEP_HOURS.
const oldOfficial = new Map(oldItems.filter((e) => e.official).map((e) => [e.link, e]));
const nowIso = new Date().toISOString(), cutoff = new Date(Date.now() - OFFICIAL_KEEP_HOURS * 3600e3).toISOString();
const offSeen = new Set(), official = [...entries.filter((e) => e.official), ...oldOfficial.values()]
  .map((e) => (e.date ? e : { ...e, date: (oldOfficial.get(e.link) || {}).date || nowIso }))
  .filter((e) => e.date >= cutoff && !offSeen.has(e.link) && offSeen.add(e.link)).sort(byDate).slice(0, OFFICIAL_MAX);
const items = [...news, ...official].sort(byDate);
if (!items.length) { console.log("no headlines fetched; keeping old feed"); process.exit(0); }
if (JSON.stringify(old.items) === JSON.stringify(items)) { console.log("feed unchanged"); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify({ meta: { lastUpdated: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"), note: "Auto-pulled headlines. Unverified until reviewed.", feeds: status }, items }, null, 1) + "\n");
console.log(`wrote ${items.length} headlines to ${path.relative(ROOT, OUT)}`);
