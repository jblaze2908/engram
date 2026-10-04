// What agents asked for when reading: search filters (agent, kind, date) that never reach past grants, provenance on
// every hit, and get returning long text in pages instead of cutting it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { ROOT, req, close, signIn, makeAgent, g, call } from "./_env.mjs";
const { scan } = await import("../dist/src/index.js");

let cookie, scout, ledger, narrow, mdArt, finArt;
const accept = async (id) => assert.equal((await req("POST", `/api/inbox/${id}`, { decision: "accept" }, { cookie })).status, 200);
const proposeAccepted = async (token, args) => {
  const r = await call(token, "propose", { kind: "memory", ...args });
  assert.equal(r.isError, false, r.data);
  if (r.data.status !== "accepted") await accept(r.data.id);
};
const hitsFor = async (token, args) => { const r = await call(token, "search", args); assert.equal(r.isError, false, r.data); return r.data.hits; };
const vaultMemory = (rel, fm, text) => { mkdirSync(join(ROOT, "vault", rel, ".."), { recursive: true }); writeFileSync(join(ROOT, "vault", rel), `---\n${stringify(fm)}---\n${text}\n`); };

before(async () => {
  cookie = await signIn();
  scout = await makeAgent(cookie, "Scout", [g("personal", true, "propose")]);
  ledger = await makeAgent(cookie, "Ledger", [g("personal", true, "propose"), g("finance", true, "propose")]);
  narrow = await makeAgent(cookie, "Narrow", [g("personal", true)]);
  assert.equal((await req("POST", "/api/memories", { text: "Bicycle tyres take 60 psi", area: "home", scope: "personal" }, { cookie })).status, 200);
  await proposeAccepted(scout.token, { text: "Bicycle chain was oiled at Decathlon", area: "home", source: { kind: "agent", label: "Service receipt" } });
  await proposeAccepted(ledger.token, { text: "Bicycle loan EMI is paid from savings", area: "money", scope: "finance" });
  await proposeAccepted(scout.token, { text: "Bicycle recall notice for the 2024 frame", area: "home", source: { kind: "web", label: "Maker's site", ref: "https://example.com/recall" } });
  const md = await call(scout.token, "publish", { title: "Bicycle service notes", filename: "service.md", text: "# Service\nBicycle brakes adjusted." });
  assert.equal(md.isError, false, md.data);
  mdArt = md.data.id;
  await proposeAccepted(scout.token, { text: "Bicycle brakes were adjusted in September", area: "home", source: { kind: "file", label: "Service notes", ref: mdArt } });
  const fin = await call(ledger.token, "publish", { title: "Bicycle loan statement", filename: "loan.md", text: "Loan statement", scope: "finance", area: "money" });
  assert.equal(fin.isError, false, fin.data);
  finArt = fin.data.id;
  await proposeAccepted(ledger.token, { text: "Bicycle loan closes next year", area: "home", source: { kind: "file", label: "Loan statement", ref: finArt } });
  assert.equal((await call(scout.token, "propose", { kind: "episode", text: "Bicycle: compared three repair shops and booked one", area: "home" })).isError, false);
  // Dated records straight into the vault: the write path stamps now(), and the date filters need a past.
  vaultMemory("memories/2026/01/m_jan.md", { id: "m_jan", area: "home", scope: "personal", source: { kind: "agent", label: "Scout", agent: scout.agent.id }, created_at: Date.parse("2026-01-15T06:00:00Z"), accepted_at: Date.parse("2026-01-15T06:00:00Z") }, "Bicycle bell replaced in January");
  vaultMemory("memories/2026/03/m_mar.md", { id: "m_mar", area: "home", scope: "personal", source: { kind: "agent", label: "Scout", agent: scout.agent.id }, created_at: Date.parse("2026-03-10T06:00:00Z") }, "Bicycle lights bought in March");
  // A private record naming Scout as its author: no filter may surface it.
  vaultMemory("memories/2026/02/m_priv.md", { id: "m_priv", area: "home", scope: "private", source: { kind: "agent", label: "Scout", agent: scout.agent.id }, created_at: Date.parse("2026-02-01T06:00:00Z") }, "Bicycle lock combination is kept in the drawer");
  scan();
});
after(close);

test("search: agent filter by name or id, episodes by who, never past read grants", async () => {
  const byName = (await hitsFor(narrow.token, { query: "bicycle", agent: "scout", limit: 50 })).map((h) => h.id);
  const byId = (await hitsFor(narrow.token, { query: "bicycle", agent: scout.agent.id, limit: 50 })).map((h) => h.id);
  assert.deepEqual(byName.sort(), byId.sort(), "name (any case) and id find the same records");
  const kinds = (await hitsFor(narrow.token, { query: "bicycle", agent: "Scout", limit: 50 })).map((h) => h.kind);
  assert.ok(kinds.includes("episode") && kinds.includes("artifact") && kinds.includes("memory"), kinds.join());
  assert.ok(!byName.includes("m_priv"), "a private record is never returned, filter or not");
  assert.ok(byName.includes("m_jan") && byName.includes("m_mar"));

  // Ledger wrote a finance memory and artifact; Narrow can't read finance, so the filter only shows Ledger's personal one.
  const nl = await hitsFor(narrow.token, { query: "bicycle loan", agent: "Ledger", limit: 50 });
  assert.deepEqual(nl.map((h) => h.scope), ["personal"]);
  const ll = await hitsFor(ledger.token, { query: "bicycle loan", agent: "Ledger", limit: 50 });
  assert.ok(ll.some((h) => h.scope === "finance"), "the same filter with finance read sees them");

  assert.deepEqual(await hitsFor(narrow.token, { query: "bicycle", agent: "Nobody" }), []);
});

test("search: kind and date filters", async () => {
  const eps = await hitsFor(narrow.token, { query: "bicycle", kind: "episode" });
  assert.deepEqual(eps.map((h) => h.kind), ["episode"]);
  const early = (await hitsFor(narrow.token, { query: "bicycle", before: "2026-02-01", limit: 50 })).map((h) => h.id);
  assert.deepEqual(early, ["m_jan"]);
  const spring = (await hitsFor(narrow.token, { query: "bicycle", after: "2026-02-01", before: "2026-04-01T00:00:00Z", limit: 50 })).map((h) => h.id);
  assert.deepEqual(spring, ["m_mar"], "m_priv is in range but private");
  const recent = await hitsFor(narrow.token, { query: "bicycle", after: "2026-04-01", limit: 50 });
  assert.ok(recent.length >= 5 && !recent.some((h) => h.id === "m_jan" || h.id === "m_mar"));
  const bad = await call(narrow.token, "search", { query: "bicycle", after: "2026-13-45" });
  assert.equal(bad.isError, true);
  assert.equal((await call(narrow.token, "search", { query: "bicycle", after: "last week" })).isError, true);
});

test("search: each hit says where it came from and how far to trust it", async () => {
  const hits = await hitsFor(narrow.token, { query: "bicycle", limit: 50 });
  const by = (t) => hits.find((h) => h.title.startsWith(t)).provenance;
  assert.deepEqual({ ...by("Bicycle tyres"), created_at: null, updated_at: null }, { trust: "user", by: "you", review: "accepted", created_at: null, updated_at: null, open: null });
  const chain = by("Bicycle chain");
  assert.equal(chain.trust, "agent");
  assert.equal(chain.by, "Scout");
  assert.equal(chain.review, "accepted");
  assert.ok(!Number.isNaN(Date.parse(chain.created_at)) && !Number.isNaN(Date.parse(chain.updated_at)));
  const recall = hits.find((h) => h.title.startsWith("Bicycle recall"));
  assert.equal(recall.provenance.trust, "untrusted", "web content stays marked untrusted after acceptance");
  assert.deepEqual(recall.provenance.open, { url: "https://example.com/recall" });
  assert.deepEqual(by("Bicycle brakes were").open, { id: mdArt });
  assert.equal(by("Bicycle bell").review, "accepted");
  assert.equal(by("Bicycle lights").review, "not_reviewed");
  assert.equal(by("Bicycle bell").created_at, "2026-01-15T06:00:00.000Z");
  const ep = hits.find((h) => h.kind === "episode").provenance;
  assert.deepEqual([ep.trust, ep.by, ep.review], ["agent", "Scout", "not_reviewed"]);
  const art = hits.find((h) => h.id === mdArt).provenance;
  assert.deepEqual([art.trust, art.by, art.review], ["agent", "Scout", null]);
  // The loan memory's source is a finance artifact: Narrow sees the ref but gets no way to open it; Ledger does.
  const loan = hits.find((h) => h.title.startsWith("Bicycle loan closes"));
  assert.equal(loan.provenance.open, null);
  const loanL = (await hitsFor(ledger.token, { query: "bicycle loan closes" })).find((h) => h.title.startsWith("Bicycle loan closes"));
  assert.deepEqual(loanL.provenance.open, { id: finArt });
  assert.ok(Buffer.byteLength(JSON.stringify(hits)) < 50 * 1500, "hits stay small");
});

test("get: full text in pages with next_offset, never silently cut", async () => {
  const long = Array.from({ length: 280 }, (_, i) => `Step ${i}: checked the bicycle part ${i} and wrote it down.`).join("\n");
  assert.ok(long.length > 12000 && long.length < 20000 && long.length > 4000);
  const ep = await call(scout.token, "propose", { kind: "episode", text: long, area: "home" });
  assert.equal(ep.isError, false, "an episode longer than a memory's 4000 characters is kept whole");
  const whole = await call(narrow.token, "get", { id: ep.data.id });
  assert.equal(whole.data.record.text, long);
  assert.deepEqual(whole.data.page, { field: "text", offset: 0, limit: 20000, total: long.length, next_offset: null });
  assert.equal(whole.data.provenance.by, "Scout");

  let got = "", offset = 0, calls = 0;
  for (;;) {
    const r = await call(narrow.token, "get", { id: ep.data.id, offset, limit: 5000 });
    assert.equal(r.isError, false);
    got += r.data.record.text;
    calls++;
    if (r.data.page.next_offset == null) break;
    assert.equal(r.data.page.next_offset, offset + 5000);
    offset = r.data.page.next_offset;
  }
  assert.equal(got, long);
  assert.equal(calls, Math.ceil(long.length / 5000));
  const past = await call(narrow.token, "get", { id: ep.data.id, offset: long.length + 10 });
  assert.equal(past.data.record.text, "");
  assert.equal(past.data.page.next_offset, null);

  const emoji = await call(scout.token, "propose", { kind: "episode", text: "aaaa😀b", area: "home" });
  const cut = await call(narrow.token, "get", { id: emoji.data.id, limit: 5 });
  assert.deepEqual([cut.data.record.text, cut.data.page.next_offset], ["aaaa", 4], "a page never ends inside a surrogate pair");

  assert.equal((await call(scout.token, "propose", { kind: "memory", text: "x".repeat(4001) })).isError, true, "a memory is still one claim");
  assert.equal((await call(scout.token, "propose", { kind: "episode", text: "x".repeat(20001) })).isError, true);
});

test("get: a text artifact comes with its text; refusals hold whatever the paging", async () => {
  const a = await call(narrow.token, "get", { id: mdArt, limit: 9 });
  assert.equal(a.data.kind, "artifact");
  assert.equal(a.data.record.text, "# Service");
  assert.equal(a.data.page.total, "# Service\nBicycle brakes adjusted.".length);
  assert.equal(a.data.page.next_offset, 9);
  const refused = await call(narrow.token, "get", { id: finArt, offset: 0, limit: 10 });
  assert.equal(refused.isError, true);
  assert.equal(refused.data, "Outside this agent's read grants");
  assert.equal((await call(narrow.token, "get", { id: "m_priv" })).isError, true);
  // Untrusted stays marked on get too.
  const recall = (await hitsFor(narrow.token, { query: "recall notice" }))[0];
  const r = await call(narrow.token, "get", { id: recall.id });
  assert.equal(r.data.record.trust, "untrusted");
  assert.equal(r.data.provenance.trust, "untrusted");
});
