import assert from "node:assert";
import * as u from "./update.mjs";
assert.equal(u.metaContent(`<meta property="og:image" content="https://img.x/a.jpg?w=1&amp;h=2">`,"og:image"),"https://img.x/a.jpg?w=1&h=2");
assert.equal(u.metaContent(`<meta content="https://b.jpg" property="og:image" />`,"og:image"),"https://b.jpg");
assert.deepEqual(u.chefkochLinks(`<a href="/rezepte/123456789/Pilzrisotto.html">x</a><a href="https://www.chefkoch.de/rezepte/2/Foo-Bar.html?x=1">`),
  ["https://www.chefkoch.de/rezepte/123456789/Pilzrisotto.html","https://www.chefkoch.de/rezepte/2/Foo-Bar.html"]);
assert.deepEqual(u.ddgLinks(`<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.einfachbacken.de%2Frezepte%2Fzupfkuchen&amp;rut=x">`),
  ["https://www.einfachbacken.de/rezepte/zupfkuchen"]);
const b64 = Buffer.from("https://www.einfachbacken.de/rezepte/apfelkuchen").toString("base64url");
assert.ok(u.bingLinks(`<a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${b64}&amp;ntb=1">`).includes("https://www.einfachbacken.de/rezepte/apfelkuchen"));
assert.equal(u.firstVideoId(`..."richItemRenderer":{"content":{"videoRenderer":{"videoId":"abcdEFGH_-1","thumbnail"`),"abcdEFGH_-1");
assert.equal(u.firstVideoId(`{"lockupViewModel":{"contentImage":{},"contentId":"ZZZZZZZZZZZ","contentType":"LOCKUP_CONTENT_TYPE_VIDEO"}}`),"ZZZZZZZZZZZ");
assert.equal(u.channelIdFrom(`"externalId":"UC-QOcOL01vuShdAk01YzDmw"`),"UC-QOcOL01vuShdAk01YzDmw");
const rss = `<feed><entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>Kürbis &amp; Co – Test</title><published>2026-11-18T05:00:00+00:00</published></entry></feed>`;
assert.deepEqual(u.parseRss(rss)[0],{id:"aaaaaaaaaaa",title:"Kürbis & Co – Test",published:"2026-11-18T05:00:00+00:00",isShort:false});
console.log("Parser-Tests OK");
