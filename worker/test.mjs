import assert from "node:assert";
import worker, { extractRecipe, isoMinutes, clean, cleanAnswer } from "./worker.js";

const page = `<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Recipe","name":"Pilzrisotto &amp; Parmesan","image":["https://img.x/1x1.jpg","https://img.x/4x3.jpg"],
"recipeYield":"4 Portionen","totalTime":"P0DT0H45M","prepTime":"PT15M","author":{"name":"Koch"},
"recipeIngredient":["300 g Risottoreis","1 Zwiebel(n)","&frac12; Bund Petersilie"],
"recipeInstructions":[{"@type":"HowToSection","name":"Risotto","itemListElement":[{"@type":"HowToStep","text":"Zwiebel w&uuml;rfeln.<br>In Butter 5 Minuten anschwitzen."},{"@type":"HowToStep","text":"Reis zugeben und 18-20 Min. garen."}]}]}]}</script></html>`;
const r = extractRecipe(page, "https://www.chefkoch.de/rezepte/1/Pilzrisotto.html");
assert.equal(r.name, "Pilzrisotto & Parmesan");
assert.equal(r.image, "https://img.x/4x3.jpg");
assert.equal(r.totalMinutes, 45);
assert.deepEqual(r.ingredients, ["300 g Risottoreis", "1 Zwiebel(n)", "½ Bund Petersilie"]);
assert.equal(r.steps.length, 3);
assert.deepEqual(r.steps[1], { text: "In Butter 5 Minuten anschwitzen.", section: "Risotto" });
assert.equal(isoMinutes("PT1H30M"), 90);
assert.equal(clean("A &amp; B<br/>C"), "A & B\nC");

// Chefkoch-Stil: ein langer Textblock
const long = "Erst dies tun. " + "Dann das machen und lange warten. ".repeat(20);
const r2 = extractRecipe(`<script type="application/ld+json">{"@type":"Recipe","name":"X","recipeInstructions":${JSON.stringify(long)}}</script>`, "https://www.chefkoch.de/rezepte/2/X.html");
assert.ok(r2.steps.length > 5);

// Worker: erlaubte/verbotene Hosts und CORS
globalThis.fetch = async () => new Response(page, { status: 200 });
const res = await worker.fetch(new Request("https://w.dev/?url=" + encodeURIComponent("https://www.chefkoch.de/rezepte/1/P.html"), { headers: { Origin: "https://kuechendisplay.github.io" } }));
assert.equal(res.status, 200);
assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://kuechendisplay.github.io");
assert.equal((await res.json()).steps.length, 3);
const bad = await worker.fetch(new Request("https://w.dev/?url=" + encodeURIComponent("https://evil.example/")));
assert.equal(bad.status, 403);
const noData = (globalThis.fetch = async () => new Response("<html></html>"), await worker.fetch(new Request("https://w.dev/?url=" + encodeURIComponent("https://www.einfachbacken.de/rezepte/x"))));
assert.equal(noData.status, 404);
// Sprachfrage mit simuliertem Workers AI
const calls = [];
const env = { AI: { run: async (model, input) => {
  calls.push(model);
  if (model.includes("whisper")) return { text: " Wie lange kocht ein Ei wachsweich? " };
  return { response: "**Ei:** Ins kochende Wasser geben und 6 Minuten kochen.\n- danach abschrecken" };
} } };
const audio = new Uint8Array(5000).fill(7);
const askRes = await worker.fetch(new Request("https://w.dev/ask", { method: "POST", body: audio, headers: { Origin: "https://kuechendisplay.github.io", "Content-Type": "audio/webm" } }), env);
assert.equal(askRes.status, 200);
const a = await askRes.json();
assert.equal(a.question, "Wie lange kocht ein Ei wachsweich?");
assert.equal(a.answer, "Ei: Ins kochende Wasser geben und 6 Minuten kochen.\ndanach abschrecken");
assert.equal(a.model, "workers-ai");
assert.ok(calls[0].includes("whisper-large-v3-turbo"));
const forbidden = await worker.fetch(new Request("https://w.dev/ask", { method: "POST", body: audio, headers: { Origin: "https://evil.example" } }), env);
assert.equal(forbidden.status, 403);
const noAi = await worker.fetch(new Request("https://w.dev/ask", { method: "POST", body: audio, headers: { Origin: "https://kuechendisplay.github.io" } }), {});
assert.equal(noAi.status, 500);
console.log("Worker-Tests OK");
