import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { req, close, signIn } from "./_env.mjs";
import { mockUpstream } from "./_upstream.mjs";

process.env.ENGRAM_DEV_ALLOW_LOCAL = "1";

let cookie, reg, up, oa, open, hits = [], down = false;
const remote = (url, headers) => [{ type: "streamable-http", url, ...(headers ? { headers } : {}) }];
const entry = (name, remotes, status = "active") => ({ server: { name, description: `${name} server`, version: "1.0.0", remotes }, _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest: true } } });

before(async () => {
  cookie = await signIn();
  up = await mockUpstream({ auth: "bearer" });
  oa = await mockUpstream({ auth: "oauth", scopes: ["repo", "read:user"] });
  open = await mockUpstream({ auth: "none" });
  // A local stand-in for registry.modelcontextprotocol.io: GET /v0.1/servers?search=…
  reg = createServer((rq, rs) => {
    const u = new URL(rq.url, "http://x");
    hits.push(u.pathname + u.search);
    if (down) { rs.writeHead(500); return rs.end(); }
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({ servers: [
      entry("io.example/gitnotes", remote(up.url)),
      entry("io.example/gitkeys", remote("https://keys.example.com/mcp", [{ name: "Authorization", isRequired: true, isSecret: true }])),
      entry("io.example/git-sse", [{ type: "sse", url: "https://sse.example.com/sse" }]),
      entry("io.example/git-apikey", remote("https://apikey.example.com/mcp", [{ name: "X-API-Key", isRequired: true }])),
      entry("io.example/git-tenant", remote("https://{tenant}.example.com/mcp")),
      entry("io.example/git-plain", remote("http://plain.example.com/mcp")),
      entry("io.github/github", remote("https://api.githubcopilot.com/mcp/")),
      entry("io.example/git-gone", remote("https://gone.example.com/mcp"), "deleted"),
    ], metadata: { count: 8 } }));
  });
  await new Promise((ok) => reg.listen(0, "127.0.0.1", ok));
  process.env.ENGRAM_REGISTRY_URL = `http://127.0.0.1:${reg.address().port}`;
});
after(async () => { for (const m of [up, oa, open]) await m.close(); reg.close(); await close(); });

const search = async (q) => { const r = await req("GET", `/api/catalog?q=${encodeURIComponent(q)}`, undefined, { cookie }); assert.equal(r.status, 200, r.text); return r.json; };

test("no query: the curated list only, nothing fetched", async () => {
  const list = await search("");
  assert.ok(list.length >= 12 && list.length <= 20, `${list.length} curated entries`);
  assert.ok(list.every((e) => e.source === "curated" && /^https:\/\//.test(e.url) && /^https:\/\//.test(e.docs) && e.id.length <= 12));
  assert.ok(list.filter((e) => e.auth === "bearer").every((e) => /^https:\/\//.test(e.tokenHelp)), "a token entry says where to make one");
  assert.equal(list.find((e) => e.id === "gmail").untrusted, true);
  assert.deepEqual(hits, []);
});

test("a query merges curated matches first with registry streamable-http remotes, cached for a day", async () => {
  const list = await search("git");
  assert.equal(list[0].source, "curated");
  assert.equal(list[0].id, "github");
  const r = list.filter((e) => e.source === "registry");
  assert.deepEqual(r.map((e) => e.name), ["io.example/gitnotes", "io.example/gitkeys"], "sse, custom headers, templated, plain http, curated duplicates and deleted are left out");
  assert.equal(r[1].auth, "bearer");
  assert.ok(r.every((e) => e.untrusted && e.dcr === null));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^\/v0\.1\/servers\?search=git&limit=30&version=latest$/);
  await search("git");
  await search("  GIT ");
  assert.equal(hits.length, 1, "served from the cache");

  assert.equal((await req("POST", "/api/connections", { name: "Git notes", url: up.url, auth: "bearer", token: "pat-123" }, { cookie })).status, 200);
  const again = await search("git");
  assert.equal(again.find((e) => e.name === "io.example/gitnotes").connected, true);
  assert.equal(again.find((e) => e.name === "io.example/gitkeys").connected, false);
  assert.equal(hits.length, 1);
});

test("a registry outage leaves the curated results", async () => {
  down = true;
  const list = await search("notion");
  assert.deepEqual(list.map((e) => e.id), ["notion"]);
  down = false;
});

test("probe tells OAuth (with DCR and scopes) from a token from no sign-in", async () => {
  const p = (url) => req("POST", "/api/catalog/probe", { url }, { cookie });
  assert.deepEqual((await p(oa.url)).json, { auth: "oauth", dcr: true, scopes: ["repo", "read:user"] });
  assert.deepEqual((await p(up.url)).json, { auth: "bearer", dcr: null, scopes: [] });
  assert.deepEqual((await p(open.url)).json, { auth: "none", dcr: null, scopes: [] });
  assert.equal((await p("https://10.0.0.1/mcp")).status, 400, "the SSRF guard applies");
  assert.equal((await req("POST", "/api/catalog/probe", { url: oa.url })).status, 401, "needs a session");
  assert.equal((await req("GET", "/api/catalog?q=x")).status, 401);
});
