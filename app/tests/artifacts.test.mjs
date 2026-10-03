// Artifacts: one file in, a private page out. Publishing over MCP, the link and the web app; versions and ownership;
// public links through the inbox; the open flow; and the separate artifacts server with its per-type headers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { req, close, signIn, makeAgent, g, call, ROOT, BASE } from "./_env.mjs";

const { createArtifactsServer, HTML_CSP } = await import("../dist/src/artifacts/server.js");
const { mintToken, checkToken } = await import("../dist/src/artifacts/shared.js");

let cookie, writer, reader, link, srv, ART;
before(async () => {
  cookie = await signIn();
  writer = await makeAgent(cookie, "Claude Code", [g("personal", true, "propose")]);
  reader = await makeAgent(cookie, "Reader", [g("personal", true)]);
  link = (await req("POST", "/api/link", {}, { cookie })).json;
  await L("POST", "/link/members", { pitcrew_id: "bills", name: "Bills", scope: "finance" });
  await L("POST", "/link/members", { pitcrew_id: "chief", name: "Crew Chief" });
  srv = createArtifactsServer({ files: join(ROOT, "vault/artifacts/files"), serve: join(ROOT, "artifacts-serve"), engramHost: "engram.test" });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  ART = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { srv.close(); await close(); });

const L = (method, path, body) => req(method, path, body, { bearer: link.token, csrf: false });
const get = (path, headers = {}) => fetch(ART + path, { redirect: "manual", headers });
const manifest = () => JSON.parse(readFileSync(join(ROOT, "artifacts-serve/manifest.json"), "utf8"));
const key = () => readFileSync(join(ROOT, "artifacts-serve/view.key"));
const view = (id) => `v=${mintToken(key(), id, Date.now() + 3600000)}`;
const b64 = (s) => Buffer.from(s).toString("base64");

test("publish over MCP: private by default, versions only by the agent that published, needs a propose grant", async () => {
  const r = await call(writer.token, "publish", { title: "Goa plan", filename: "goa.md", text: "# Goa\n\nFour nights, 12–16 Dec." });
  assert.equal(r.isError, false);
  assert.deepEqual([r.data.version, r.data.status, r.data.public_url], [1, "published", null]);
  assert.match(r.data.url, /^https:\/\/artifacts\.example\.com\/a\/art_[\w-]+$/);
  const v2 = await call(writer.token, "publish", { id: r.data.id, title: "Goa plan", filename: "goa.md", text: "# Goa\n\nFive nights now." });
  assert.equal(v2.data.version, 2); assert.equal(v2.data.url, r.data.url, "same link for every version");
  assert.equal((await call(writer.token, "publish", { id: r.data.id, title: "Goa plan", filename: "goa.md", text: "# Goa\n\nFive nights now." })).data.version, 2, "same bytes, same version");
  const theirs = await call(reader.token, "publish", { id: r.data.id, title: "x", filename: "x.md", text: "hijack" });
  assert.equal(theirs.isError, true); assert.match(theirs.data, /Only the agent that published/);
  assert.match((await call(reader.token, "publish", { title: "x", filename: "x.md", text: "no grant" })).data, /No propose grant for personal/);
  assert.match((await call(writer.token, "publish", { title: "x", filename: "x.md" })).data, /as text or content_base64/);
  const a = (await req("GET", `/api/artifacts/${r.data.id}`, undefined, { cookie })).json;
  assert.deepEqual(a.versions.map((v) => [v.v, v.ext, v.mime]), [[1, "md", "text/markdown"], [2, "md", "text/markdown"]]);
  assert.equal(a.description, "");
  assert.deepEqual(manifest().artifacts[r.data.id].versions.map((v) => v.v), [1, 2]);
  const hit = (await call(writer.token, "search", { query: "Five nights", kind: "artifact" })).data.hits[0];
  assert.equal(hit.id, r.data.id, "the text of a markdown artifact is searchable");
  assert.equal(hit.url, r.data.url); assert.equal(hit.public_url, null);
});

test("a public link: an agent asks through the inbox; you make and revoke it; a new share is a new slug", async () => {
  const r = await call(writer.token, "publish", { title: "Bills dashboard", filename: "bills.html", text: "<h1>Bills</h1>", public: true });
  assert.deepEqual([r.data.status, r.data.public_url], ["share_pending", null]);
  const inbox = (await req("GET", "/api/inbox", undefined, { cookie })).json.filter((p) => p.kind === "share");
  assert.equal(inbox.length, 1);
  assert.deepEqual([inbox[0].title, inbox[0].held, inbox[0].reasons], ["Make public: Bills dashboard", true, ["Anyone with the link can open it"]]);
  assert.equal((await call(writer.token, "publish", { id: r.data.id, title: "Bills dashboard", filename: "bills.html", text: "<h1>Bills v2</h1>", public: true })).data.status, "share_pending");
  assert.equal((await req("GET", "/api/inbox", undefined, { cookie })).json.filter((p) => p.kind === "share").length, 1, "one request per artifact");
  assert.equal(Object.keys(manifest().shares).length, 0, "nothing public before you agree");
  const decided = await req("POST", `/api/inbox/${inbox[0].id}`, { decision: "accept" }, { cookie });
  assert.equal(decided.status, 200);
  const a = (await req("GET", `/api/artifacts/${r.data.id}`, undefined, { cookie })).json;
  assert.equal(decided.json.public_url, a.public_url, "accepting a share answers with its link");
  const slug = a.public_url.split("/s/")[1];
  assert.match(slug, /^[\w-]{22}$/);
  assert.deepEqual(manifest().shares, { [slug]: r.data.id });
  assert.equal((await call(writer.token, "publish", { id: r.data.id, title: "Bills dashboard", filename: "bills.html", text: "<h1>Bills v3</h1>" })).data.public_url, a.public_url);
  const pub = await get(`/s/${slug}`);
  assert.equal(pub.status, 200); assert.equal(await pub.text(), "<h1>Bills v3</h1>");
  assert.equal(pub.headers.get("cache-control"), "public, max-age=60");
  assert.equal((await get(`/s/${slug}?v=1`).then((x) => x.text())), "<h1>Bills</h1>");
  assert.equal((await req("DELETE", `/api/artifacts/${r.data.id}/share`, undefined, { cookie })).status, 200);
  assert.deepEqual(manifest().shares, {}); assert.equal((await get(`/s/${slug}`)).status, 404, "revoked");
  const again = (await req("POST", `/api/artifacts/${r.data.id}/share`, undefined, { cookie })).json.public_url;
  assert.notEqual(again, a.public_url);
  assert.equal((await get(`/s/${slug}`)).status, 404, "the old slug never comes back");
  assert.ok(!readFileSync(join(ROOT, "vault", `artifacts/${r.data.id}.md`), "utf8").includes(again.split("/s/")[1]), "slugs never enter the vault");
  // A rejected request leaves it private.
  const r2 = await call(writer.token, "publish", { title: "Draft", filename: "draft.txt", text: "hello", public: true });
  const p2 = (await req("GET", "/api/inbox", undefined, { cookie })).json.find((p) => p.kind === "share");
  await req("POST", `/api/inbox/${p2.id}`, { decision: "reject" }, { cookie });
  assert.equal((await req("GET", `/api/artifacts/${r2.data.id}`, undefined, { cookie })).json.public_url, null);
});

test("opening a private artifact: your session mints a view token; the artifacts host trades it for a cookie on that path", async () => {
  const { data } = await call(writer.token, "publish", { title: "Notes", filename: "notes.md", text: "Hello <script>alert(1)</script> **world**" });
  const id = data.id;
  const anon = await req("GET", `/artifacts/${id}/open`);
  assert.equal(anon.status, 200); assert.match(anon.text, /http-equiv="refresh" content="0;url=\/artifacts\/[\w-]+\/open\?r=1"/);
  const r1 = await fetch(`${BASE}/artifacts/${id}/open?r=1`, { redirect: "manual" });
  assert.equal(r1.status, 302); assert.equal(r1.headers.get("location"), `/?next=${encodeURIComponent(`/artifacts/${id}/open`)}`);
  const signed = await fetch(`${BASE}/artifacts/${id}/open?v=1`, { redirect: "manual", headers: { cookie } });
  assert.equal(signed.status, 302);
  const loc = new URL(signed.headers.get("location"));
  assert.equal(loc.origin, "https://artifacts.example.com"); assert.equal(loc.pathname, `/a/${id}`); assert.equal(loc.searchParams.get("v"), "1");
  const t = loc.searchParams.get("t");
  assert.ok(checkToken(key(), t, id)); assert.equal(checkToken(key(), t, "art_other"), null, "bound to the artifact");

  const bare = await get(`/a/${id}`);
  assert.equal(bare.status, 302); assert.equal(bare.headers.get("location"), `https://engram.test/artifacts/${id}/open`);
  const trade = await get(`/a/${id}?t=${t}&v=1`);
  assert.equal(trade.status, 302); assert.equal(trade.headers.get("location"), `/a/${id}?v=1`);
  const c = trade.headers.get("set-cookie");
  assert.match(c, new RegExp(`^v=[^;]+; Path=/a/${id}; Max-Age=\\d+; HttpOnly; Secure; SameSite=Lax$`));
  const page = await get(`/a/${id}`, { cookie: c.split(";")[0] });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  const html = await page.text();
  assert.match(html, /Hello &lt;script&gt;alert\(1\)&lt;\/script&gt; <strong>world<\/strong>/, "raw HTML in markdown is shown, never run");
  assert.match(page.headers.get("content-security-policy"), /^default-src 'none'; style-src 'unsafe-inline'; img-src data:/);
  assert.equal((await get(`/a/${id}?t=garbage`)).status, 302);
  const expired = mintToken(key(), id, Date.now() - 1000);
  assert.equal((await get(`/a/${id}`, { cookie: `v=${expired}` })).status, 302, "expired");
  const tooLong = mintToken(key(), id, Date.now() + 13 * 3600000);
  assert.equal((await get(`/a/${id}`, { cookie: `v=${tooLong}` })).status, 302, "no token outlives 12 h");
  assert.equal((await get(`/a/${id}`, { cookie: view("art_someoneelse") })).status, 302);
  assert.equal((await get(`/a/${id}?v=9`, { cookie: view(id) })).status, 404);
  const dl = await get(`/a/${id}?download=1`, { cookie: view(id) });
  assert.match(dl.headers.get("content-disposition"), /^attachment; filename="Notes\.md"/);
});

test("each file type gets its own headers; anything unknown is a download", async () => {
  const pub = async (filename, content, extra = {}) => (await call(writer.token, "publish", { title: filename.split(".")[0], filename, content_base64: b64(content), ...extra })).data.id;
  const cases = [
    ["page.html", "<p>hi</p>", "text/html; charset=utf-8", HTML_CSP],
    ["doc.pdf", "%PDF-1.4", "application/pdf", null],
    ["pic.png", "\x89PNG", "image/png", /^sandbox; default-src 'none'; img-src 'self' data:/],
    ["logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml", /^sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:$/],
    ["data.csv", "a,b\n1,2", "text/plain; charset=utf-8", /^sandbox; default-src 'none'$/],
    ["code.js", "alert(1)", "text/plain; charset=utf-8", /^sandbox/],
    ["bundle.zip", "PK", "application/octet-stream", /sandbox/],
    ["noext", "???", "application/octet-stream", /sandbox/],
  ];
  for (const [filename, content, type, csp] of cases) {
    const id = await pub(filename, content), r = await get(`/a/${id}`, { cookie: view(id) });
    assert.equal(r.status, 200, filename);
    assert.equal(r.headers.get("content-type"), type, filename);
    if (csp === null) assert.equal(r.headers.get("content-security-policy"), null, `${filename}: no sandbox, it breaks the PDF viewer`);
    else if (typeof csp === "string") assert.equal(r.headers.get("content-security-policy"), csp, filename);
    else assert.match(r.headers.get("content-security-policy"), csp, filename);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    if (type === "application/octet-stream") assert.match(r.headers.get("content-disposition"), /^attachment/, filename);
  }
  assert.match(HTML_CSP, /connect-src 'none'/); assert.match(HTML_CSP, /img-src data: blob:;/); assert.match(HTML_CSP, /^sandbox allow-scripts/);
  assert.ok(!/allow-same-origin/.test(HTML_CSP), "pages run in an opaque origin");
  assert.equal((await get("/healthz")).status, 200);
  for (const p of ["/", "/a/", "/a/x/y", "/s/short", "/../etc/passwd", "/a/..%2F..%2Fview.key"]) assert.ok([302, 404].includes((await get(p)).status), p);
  assert.equal((await fetch(`${ART}/a/x`, { method: "POST" })).status, 405);
  assert.equal((await call(writer.token, "publish", { title: "big", filename: "big.bin", content_base64: Buffer.alloc((10 << 20) + 1).toString("base64") })).isError, true);
});

test("Pitcrew publishes through the link as its member, in the member's scope; forgetting stops serving", async () => {
  const r = await L("POST", "/link/artifacts", { pitcrew_id: "bills", title: "October receipt", filename: "receipt-oct.pdf", content_base64: b64("%PDF-1.4 oct"), ref: "pitcrew:thread:th_1" });
  assert.equal(r.status, 200); assert.deepEqual([r.json.version, r.json.status], [1, "published"]);
  const a = (await req("GET", `/api/artifacts/${r.json.id}`, undefined, { cookie })).json;
  assert.deepEqual([a.scope, a.area, a.source.label, a.source.ref], ["finance", "money", "pitcrew:Bills", "pitcrew:thread:th_1"]);
  const chief = await L("POST", "/link/artifacts", { pitcrew_id: "chief", id: r.json.id, title: "x", filename: "x.pdf", content_base64: b64("x") });
  assert.equal(chief.status, 403, "another member can't version it");
  const v2 = await L("POST", "/link/artifacts", { pitcrew_id: "bills", id: r.json.id, title: "October receipt", filename: "receipt-oct.pdf", content_base64: b64("%PDF-1.4 oct, corrected") });
  assert.equal(v2.json.version, 2);
  // The one-shot move still works and dedupes by any version's content.
  const dup = await L("POST", "/link/import/artifacts", { pitcrew_id: "bills", title: "receipt-oct.pdf", kind: "receipt", mime: "application/pdf", content_base64: b64("%PDF-1.4 oct") });
  assert.equal(dup.json.id, r.json.id);

  await req("POST", `/api/artifacts/${r.json.id}/share`, undefined, { cookie });
  const slug = (await req("GET", `/api/artifacts/${r.json.id}`, undefined, { cookie })).json.public_url.split("/s/")[1];
  assert.equal((await get(`/s/${slug}`)).status, 200);
  assert.equal((await req("POST", `/api/artifacts/${r.json.id}/forget`, undefined, { cookie })).status, 200);
  assert.equal(manifest().artifacts[r.json.id], undefined);
  assert.equal((await get(`/s/${slug}`)).status, 404, "a forgotten file is never served, public or not");
  assert.equal((await get(`/a/${r.json.id}`, { cookie: view(r.json.id) })).status, 404);
  assert.equal((await req("GET", `/artifacts/${r.json.id}/open`, undefined, { cookie })).status, 404);
});

test("upload from the web app; the manifest holds only what the server needs", async () => {
  const up = await req("POST", "/api/artifacts", { title: "Passport scan", filename: "passport.png", content_base64: b64("\x89PNG passport"), scope: "private" }, { cookie });
  assert.equal(up.status, 200);
  const a = (await req("GET", `/api/artifacts/${up.json.id}`, undefined, { cookie })).json;
  assert.deepEqual([a.scope, a.source.kind, a.source.label], ["private", "you", "Uploaded in Engram"]);
  assert.equal((await req("POST", "/api/artifacts", { title: "x", filename: "x.txt", content_base64: b64("x") })).status, 401, "needs a session");
  const m = manifest();
  assert.deepEqual(Object.keys(m).sort(), ["artifacts", "shares"]);
  for (const x of Object.values(m.artifacts)) {
    assert.deepEqual(Object.keys(x).sort(), ["title", "versions"]);
    for (const v of x.versions) assert.deepEqual(Object.keys(v).sort(), ["ext", "mime", "sha256", "v"]);
  }
  assert.equal(key().length, 32);
  assert.ok(existsSync(join(ROOT, "artifacts-serve/view.key")));
});

test("web list: search titles and contents, filter by publisher, link, kind, type, scope and area, page by cursor", async () => {
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const mine = await req("POST", "/api/artifacts", { title: "Zephyr lease scan", filename: "lease.pdf", content_base64: b64("%PDF zephyr"), scope: "household" }, { cookie });
  assert.equal(mine.status, 200, mine.text);
  await call(writer.token, "publish", { title: "Quarterly notes", filename: "notes.md", text: "The zephyrine budget line moved to Q4." });
  for (let i = 0; i < 5; i++) await call(writer.token, "publish", { title: `Paging probe ${i}`, filename: `p${i}.txt`, text: `probe ${i}` });
  const A = async (qs) => (await req("GET", `/api/artifacts${qs}`, undefined, { cookie })).json;

  const all = await A("");
  assert.ok(all.counts.all >= 7);
  assert.ok(all.publishers.some((p) => p.key === "you" && p.label === "You"));
  assert.ok(all.publishers.some((p) => p.key === writer.agent.id && p.label === "Claude Code"));

  assert.deepEqual((await A("?q=zephyrine")).artifacts.map((a) => a.title), ["Quarterly notes"], "file contents are searched");
  assert.deepEqual((await A("?q=zephyr%20lease")).artifacts.map((a) => a.title), ["Zephyr lease scan"]);
  assert.ok((await A("?by=you")).artifacts.every((a) => a.source.kind === "you"));
  assert.ok((await A(`?by=${writer.agent.id}&type=page`)).artifacts.every((a) => a.source.agent === writer.agent.id));
  assert.deepEqual((await A("?scope=household")).artifacts.map((a) => a.title), ["Zephyr lease scan"]);
  assert.deepEqual((await A("?type=pdf&scope=household")).total, 1);
  assert.equal((await A("?status=public&q=zephyr")).total, 0);
  assert.equal((await req("GET", "/api/artifacts?status=nope", undefined, { cookie })).status, 400);

  const p1 = await A("?q=probe&limit=2");
  assert.equal(p1.total, 5);
  assert.equal(p1.artifacts.length, 2);
  const p2 = await A(`?q=probe&limit=2&cursor=${encodeURIComponent(p1.next)}`);
  const p3 = await A(`?q=probe&limit=2&cursor=${encodeURIComponent(p2.next)}`);
  const titles = [...p1.artifacts, ...p2.artifacts, ...p3.artifacts].map((a) => a.title);
  assert.equal(new Set(titles).size, 5, "no repeats across pages");
  assert.equal(p3.next, null);
});
