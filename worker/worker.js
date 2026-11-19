/* Worker für das Küchendisplay (Cloudflare Worker)
   GET  /?url=<Rezept-URL>  Rezeptdaten (schema.org/Recipe aus JSON-LD) von Chefkoch/Einfach Backen als JSON
   POST /ask                Sprachfrage (Audio) → Text (Whisper) → Antwort (Workers AI oder Claude)
   Speichert nichts.

   Einstellungen in Cloudflare (Settings → Variables and Secrets / Bindings):
   - Binding AI (Workers AI)          Pflicht für /ask
   - Secret ANTHROPIC_API_KEY         optional: dann antwortet Claude statt des Workers-AI-Modells
   - Variable AI_MODEL / CLAUDE_MODEL optional: anderes Modell */

const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
const SYSTEM_PROMPT = [
  "Du bist die Küchenhilfe auf einem Küchendisplay in einem deutschen Haushalt.",
  "Antworte auf Deutsch, freundlich und knapp: meist zwei bis vier Sätze, die man im Stehen am Herd lesen kann.",
  "Kein Markdown, keine Aufzählungszeichen, keine Überschriften.",
  "Nutze metrische Einheiten und Celsius. Schreibe Zeitangaben als Zahl mit „Minuten“ oder „Stunden“, z. B. „6 Minuten“.",
  "Wenn eine Frage nichts mit Kochen, Backen oder Haushalt zu tun hat, beantworte sie trotzdem kurz."
].join(" ");

const ALLOWED_HOSTS = ["www.chefkoch.de", "chefkoch.de", "www.einfachbacken.de", "einfachbacken.de"];
const ALLOWED_ORIGINS = ["https://kuechendisplay.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];

const UA = "Mozilla/5.0 (Linux; Android 14; SM-P613) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (new URL(request.url).pathname === "/ask") return ask(request, env, origin, cors);
    if (request.method !== "GET") return json({ error: "Nur GET" }, 405, cors);

    let target;
    try { target = new URL(new URL(request.url).searchParams.get("url") || ""); }
    catch { return json({ error: "Parameter url fehlt oder ist ungültig" }, 400, cors); }
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.includes(target.hostname)) {
      return json({ error: "Diese Seite ist nicht freigegeben" }, 403, cors);
    }

    let html;
    try {
      const r = await fetch(target.href, {
        headers: { "user-agent": UA, "accept": "text/html", "accept-language": "de-DE,de;q=0.9" },
        redirect: "follow",
        cf: { cacheTtl: 21600, cacheEverything: true }
      });
      if (!r.ok) return json({ error: "Rezeptseite antwortet mit " + r.status }, 502, cors);
      html = await r.text();
    } catch (e) {
      return json({ error: "Rezeptseite nicht erreichbar" }, 502, cors);
    }

    const recipe = extractRecipe(html, target.href);
    if (!recipe) return json({ error: "Keine Rezeptdaten auf der Seite gefunden" }, 404, cors);
    return json(recipe, 200, { ...cors, "Cache-Control": "public, max-age=3600" });
  }
};

/* ---------- Sprachfrage ---------- */
async function ask(request, env, origin, cors) {
  if (request.method !== "POST") return json({ error: "Nur POST" }, 405, cors);
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "Nicht erlaubt" }, 403, cors);
  if (!env.AI) return json({ error: "Workers-AI-Binding AI fehlt" }, 500, cors);
  const audio = await request.arrayBuffer();
  if (audio.byteLength < 1000) return json({ error: "Keine Aufnahme" }, 400, cors);
  if (audio.byteLength > 4_000_000) return json({ error: "Aufnahme zu lang" }, 413, cors);
  try {
    const question = (await transcribe(env, audio)).trim();
    if (!question) return json({ error: "Nichts verstanden" }, 422, cors);
    const answer = cleanAnswer(await answerQuestion(env, question));
    return json({ question, answer, model: env.ANTHROPIC_API_KEY ? "claude" : "workers-ai" }, 200, cors);
  } catch (e) {
    return json({ error: "Antwort fehlgeschlagen" }, 502, cors);
  }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function transcribe(env, audio) {
  try {
    const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: toBase64(audio), language: "de" });
    if (r && r.text) return r.text;
  } catch {}
  const r = await env.AI.run("@cf/openai/whisper", { audio: [...new Uint8Array(audio)] });
  return (r && r.text) || "";
}

export async function answerQuestion(env, question) {
  if (env.ANTHROPIC_API_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL, max_tokens: 400, system: SYSTEM_PROMPT, messages: [{ role: "user", content: question }] })
    });
    if (!r.ok) throw new Error("Claude " + r.status);
    const d = await r.json();
    return (d.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  }
  const r = await env.AI.run(env.AI_MODEL || DEFAULT_AI_MODEL, {
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: question }],
    max_tokens: 400
  });
  return (r && (r.response || r.result && r.result.response)) || "";
}

export function cleanAnswer(t) {
  return String(t || "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

/* ---------- Rezeptdaten auslesen ---------- */
export function extractRecipe(html, url) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    const data = parseJson(raw);
    const r = data && findRecipe(data);
    if (r) return normalize(r, url);
  }
  return null;
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/[\u0000-\u001F]+/g, " ")); } catch {}
  return null;
}

function isRecipe(o) {
  const t = o && o["@type"];
  return t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
}

function findRecipe(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 6) return null;
  if (Array.isArray(o)) { for (const x of o) { const r = findRecipe(x, depth + 1); if (r) return r; } return null; }
  if (isRecipe(o)) return o;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
    const r = findRecipe(o[k], depth + 1); if (r) return r;
  }
  return null;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", deg: "°", frac12: "½", frac14: "¼", frac34: "¾", ndash: "–", mdash: "—", hellip: "…" };
export function clean(s) {
  if (s == null) return "";
  return String(s)
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+\d*);/gi, (m, n) => ENT[n] ?? m)
    .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").trim();
}

export function isoMinutes(v) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(v || "").trim());
  if (!m) return null;
  const min = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
  return min || null;
}

function imageOf(img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return imageOf(img[img.length > 1 ? 1 : 0]) || imageOf(img[0]);
  return img.url || img.contentUrl || null;
}

function stepsOf(ins) {
  const out = [];
  const add = (text, section) => {
    for (const part of clean(text).split(/\n+/)) {
      const t = part.trim();
      if (t) out.push(section ? { text: t, section } : { text: t });
    }
  };
  const walk = (x, section) => {
    if (!x) return;
    if (typeof x === "string") return add(x, section);
    if (Array.isArray(x)) return x.forEach(y => walk(y, section));
    const t = x["@type"];
    if (t === "HowToSection" || (Array.isArray(t) && t.includes("HowToSection"))) {
      return walk(x.itemListElement, clean(x.name) || section);
    }
    add(x.text || x.description || x.name, section);
  };
  walk(ins);
  // Ein einziger Textblock: in Sätze-Gruppen teilen, damit es lesbare Schritte werden
  if (out.length === 1 && out[0].text.length > 420) {
    const sentences = out[0].text.match(/[^.!?]+[.!?]+(\s|$)/g) || [out[0].text];
    const grouped = [];
    for (let i = 0; i < sentences.length; i += 2) grouped.push({ text: sentences.slice(i, i + 2).join("").trim() });
    return grouped;
  }
  return out;
}

function normalize(r, url) {
  const yieldRaw = Array.isArray(r.recipeYield) ? r.recipeYield[0] : r.recipeYield;
  const author = Array.isArray(r.author) ? r.author[0] : r.author;
  return {
    name: clean(r.name),
    url,
    source: new URL(url).hostname.replace(/^www\./, ""),
    image: imageOf(r.image),
    yield: clean(yieldRaw) || null,
    totalMinutes: isoMinutes(r.totalTime),
    prepMinutes: isoMinutes(r.prepTime),
    cookMinutes: isoMinutes(r.cookTime),
    author: author ? clean(typeof author === "string" ? author : author.name) : null,
    ingredients: (r.recipeIngredient || r.ingredients || []).map(clean).filter(Boolean),
    steps: stepsOf(r.recipeInstructions)
  };
}
