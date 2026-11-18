#!/usr/bin/env node
/* Aktualisiert feed.json: Rezeptlink + Vorschaubild für die Ideen von heute und morgen
   sowie das neueste Video des YouTube-Kanals. Läuft per GitHub Action, ohne Abhängigkeiten (Node ≥ 20).
   Schlägt eine Quelle fehl, bleibt der bisherige Stand erhalten; der Lauf endet nie mit Fehler. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/* Konfiguration und Ideenlogik direkt aus index.html lesen – eine Quelle, kein Doppelpflegen */
const INDEX = await readFile(new URL("../index.html", import.meta.url), "utf8");
const sharedCode = (/<script id="shared">([\s\S]*?)<\/script>/.exec(INDEX) || [])[1];
if (!sharedCode) throw new Error('index.html: <script id="shared"> nicht gefunden');
const sandbox = { self: {} };
vm.runInNewContext(sharedCode, sandbox);
const { CONFIG, ideasFor } = sandbox.self.Kitchen;
const FEED_PATH = fileURLToPath(new URL("../feed.json", import.meta.url));

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "de-DE,de;q=0.9,en;q=0.6",
  "cookie": "CONSENT=YES+cb; SOCS=CAI"
};
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, { json = false } = {}) {
  const r = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return json ? r.json() : r.text();
}

/* ---------- Parser (exportiert für Tests) ---------- */
export const decode = s => s
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, "&");

export function metaContent(html, prop) {
  const p = prop.replace(/[:]/g, "\\:");
  const m = new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*?content=["']([^"']+)["']`, "i").exec(html)
         || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']${p}["']`, "i").exec(html);
  return m ? decode(m[1]).trim() : null;
}

export function chefkochLinks(html) {
  return [...html.matchAll(/(?:https:\/\/www\.chefkoch\.de)?(\/rezepte\/\d+\/[^"'?#\s<>]+\.html)/g)]
    .map(m => "https://www.chefkoch.de" + m[1]);
}

export function ddgLinks(html) {
  const out = [];
  for (const m of html.matchAll(/uddg=([^&"'>]+)/g)) { try { out.push(decodeURIComponent(m[1])); } catch {} }
  for (const m of html.matchAll(/class="result__a"[^>]*href="(https?:[^"]+)"/g)) out.push(decode(m[1]));
  return out;
}

export function bingLinks(html) {
  const out = [];
  for (const m of html.matchAll(/[?&;]u=a1([A-Za-z0-9_-]+)/g)) {
    try { out.push(Buffer.from(m[1], "base64url").toString("utf8")); } catch {}
  }
  for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) out.push(decode(m[1]));
  return out;
}

export function firstVideoId(html) {
  const pats = [
    /"videoRenderer":\{"videoId":"([\w-]{11})"/,
    /"contentId":"([\w-]{11})","contentType":"LOCKUP_CONTENT_TYPE_VIDEO"/,
    /"contentType":"LOCKUP_CONTENT_TYPE_VIDEO"[^{}]*?"contentId":"([\w-]{11})"/,
    /"videoId":"([\w-]{11})"/
  ];
  for (const p of pats) { const m = p.exec(html); if (m) return m[1]; }
  return null;
}

export function channelIdFrom(html) {
  const pats = [/"externalId":"(UC[\w-]{22})"/, /itemprop="identifier" content="(UC[\w-]{22})"/,
                /"browseId":"(UC[\w-]{22})"/, /\/channel\/(UC[\w-]{22})/];
  for (const p of pats) { const m = p.exec(html); if (m) return m[1]; }
  return null;
}

export function parseRss(xml) {
  return xml.split("<entry>").slice(1).map(e => ({
    id: (/<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(e) || [])[1],
    title: decode((/<title>([\s\S]*?)<\/title>/.exec(e) || [, ""])[1]).trim(),
    published: (/<published>([^<]+)<\/published>/.exec(e) || [])[1] || null,
    isShort: /\/shorts\//.test(e)
  })).filter(x => x.id);
}

const clean = u => {
  try { const x = new URL(decode(u)); x.protocol = "https:"; return x.origin + x.pathname; } catch { return null; }
};

/* ---------- Rezepte ---------- */
const SKIP = /^\/(suche|search|tag|tags|autor|autoren|kategorie|themen|newsletter|impressum|datenschutz|kontakt|video|videos)(\/|$)/;
const KINDS = {
  dish: {
    site: "chefkoch.de",
    accept: u => /^https:\/\/www\.chefkoch\.de\/rezepte\/\d+\/[^/]+\.html$/.test(u),
    own: async name => chefkochLinks(await get(CONFIG.chefkochSearch(name))),
    search: CONFIG.chefkochSearch
  },
  bake: {
    site: "einfachbacken.de",
    accept: u => { try { const x = new URL(u); return x.hostname === "www.einfachbacken.de" && x.pathname.length > 2 && !SKIP.test(x.pathname); } catch { return false; } },
    prefer: u => /\/rezepte?\//.test(u),
    search: CONFIG.backenSearch
  }
};

async function findRecipe(kind, name) {
  const k = KINDS[kind];
  const q = `${name} Rezept site:${k.site}`;
  const tries = [];
  if (k.own) tries.push(["Seitensuche", () => k.own(name)]);
  tries.push(["DuckDuckGo", async () => ddgLinks(await get("https://html.duckduckgo.com/html/?kl=de-de&q=" + encodeURIComponent(q)))]);
  tries.push(["Bing", async () => bingLinks(await get("https://www.bing.com/search?setlang=de&cc=DE&q=" + encodeURIComponent(q)))]);
  for (const [label, run] of tries) {
    try {
      let links = [...new Set((await run()).map(clean).filter(Boolean))].filter(k.accept);
      if (k.prefer) links.sort((a, b) => k.prefer(b) - k.prefer(a));
      if (links[0]) { log(`    ${label}: ${links[0]}`); return links[0]; }
      log(`    ${label}: kein Treffer`);
    } catch (e) { log(`    ${label}: fehlgeschlagen (${e.message})`); }
    await sleep(600);
  }
  return null;
}

async function enrich(kind, name) {
  log(`  ${kind}: ${name}`);
  const url = await findRecipe(kind, name);
  let image = null;
  if (url) {
    try {
      const html = await get(url);
      const raw = metaContent(html, "og:image") || metaContent(html, "twitter:image");
      if (raw) image = new URL(raw, url).href;
      log(`    Bild: ${image || "keins gefunden"}`);
    } catch (e) { log(`    Rezeptseite fehlgeschlagen (${e.message})`); }
  }
  return { name, url: url || KINDS[kind].search(name), image };
}

/* ---------- YouTube ---------- */
async function latestVideo(prev) {
  let firstId = null, channelId = null;
  try {
    const html = await get(CONFIG.youtube);
    firstId = firstVideoId(html);
    channelId = channelIdFrom(html);
    log(`  Kanalseite: Video ${firstId || "–"}, Kanal ${channelId || "–"}`);
  } catch (e) { log(`  Kanalseite fehlgeschlagen (${e.message})`); }
  channelId = channelId || CONFIG.youtubeChannelId;

  let entries = [];
  try {
    entries = parseRss(await get("https://www.youtube.com/feeds/videos.xml?channel_id=" + channelId));
    log(`  RSS: ${entries.length} Einträge`);
  } catch (e) { log(`  RSS fehlgeschlagen (${e.message})`); }

  const id = firstId || (entries.find(e => !e.isShort) || entries[0] || {}).id;
  if (!id) throw new Error("kein Video gefunden");
  const entry = entries.find(e => e.id === id);
  let title = entry && entry.title;
  if (!title) {
    try {
      const o = await get("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id), { json: true });
      title = o.title;
    } catch (e) { log(`  oEmbed fehlgeschlagen (${e.message})`); }
  }
  const published = (entry && entry.published) || (prev && prev.id === id ? prev.published : null);
  return {
    id,
    title: title || (prev && prev.id === id ? prev.title : "Neues Video"),
    url: "https://www.youtube.com/watch?v=" + id,
    image: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    published
  };
}

/* ---------- Ablauf ---------- */
function berlinDate(t) {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

async function main() {
  let prev = { days: {}, video: null };
  try { prev = Object.assign(prev, JSON.parse(await readFile(FEED_PATH, "utf8"))); } catch {}

  const days = {};
  const now = Date.now();
  for (const t of [now, now + 864e5]) {
    const { y, m, d } = berlinDate(t);
    const idea = ideasFor(y, m, d);
    const old = (prev.days && prev.days[idea.key]) || {};
    log(`Ideen für ${idea.key}`);
    days[idea.key] = {};
    for (const kind of ["dish", "bake"]) {
      const o = old[kind];
      days[idea.key][kind] = o && o.name === idea[kind] && o.image ? o : await enrich(kind, idea[kind]);
    }
  }

  log("Neuestes Video");
  let video = prev.video;
  try { video = await latestVideo(prev.video); log(`  ${video.id}: ${video.title}`); }
  catch (e) { log(`  fehlgeschlagen (${e.message}), bisheriges Video bleibt`); }

  const next = { days, video };
  if (JSON.stringify(next) === JSON.stringify({ days: prev.days, video: prev.video })) {
    log("Keine Änderung."); return;
  }
  await writeFile(FEED_PATH, JSON.stringify({ updated: new Date().toISOString(), ...next }, null, 2) + "\n");
  log("feed.json aktualisiert.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e); process.exitCode = 0; });
}
