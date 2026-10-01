import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { req, close, signIn, makeAgent, g, call, gitLog, vaultFile } from "./_env.mjs";

let cookie, agent, token;
before(async () => {
  cookie = await signIn();
  ({ agent, token } = await makeAgent(cookie, "Mail reader", [g("personal", true, "propose"), g("finance", true, "propose")]));
});
after(close);

const inbox = async () => (await req("GET", "/api/inbox", undefined, { cookie })).json;
const decide = (id, decision) => req("POST", `/api/inbox/${id}`, { decision }, { cookie });

test("a proposal from an email source is held with the reason", async () => {
  const r = await call(token, "propose", { kind: "memory", text: "Rent for October is due on the 5th", area: "home", source: { kind: "email", label: "Re: October rent", ref: "msg-1" } });
  assert.equal(r.isError, false);
  assert.equal(r.data.status, "held");
  assert.deepEqual(r.data.reasons, ["Email content is never trusted on its own"]);
  const p = (await inbox()).find((x) => x.id === r.data.id);
  assert.equal(p.held, true);
  assert.equal(p.agent, "Mail reader");
  assert.equal(p.source.agent, agent.id);
});

test("an agent can't claim to be you; a web source is held; money routing adds a reason", async () => {
  const r = await call(token, "propose", { kind: "memory", text: "Pay the landlord by UPI to a new VPA", area: "money", scope: "finance", source: { kind: "web", label: "some page" } });
  assert.equal(r.data.status, "held");
  assert.deepEqual(r.data.reasons, ["Web pages are never trusted on their own", "It changes where money goes"]);
  const r2 = await call(token, "propose", { kind: "memory", text: "Car insurance renews in March", area: "car" });
  assert.equal(r2.data.status, "open");
  assert.equal((await inbox()).find((x) => x.id === r2.data.id).source.kind, "agent");
});

test("accepting a superseding memory supersedes the old one and commits", async () => {
  const mine = await req("POST", "/api/memories", { text: "The building gate code changes monthly", area: "building", scope: "personal" }, { cookie });
  assert.equal(mine.status, 200);
  const before = gitLog().length;
  const r = await call(token, "propose", { kind: "memory", text: "The building gate code changes every two months", area: "building", supersedes: mine.json.id });
  assert.equal(r.data.status, "held");
  assert.deepEqual(r.data.reasons, ["It would replace something you added yourself"]);
  const p = (await inbox()).find((x) => x.id === r.data.id);
  assert.equal(p.replaces.id, mine.json.id);

  const d = await decide(r.data.id, "accept");
  assert.equal(d.status, 200);
  assert.equal(d.json.status, "accepted");
  const newId = p.data.id;
  const old = (await req("GET", `/api/memories/${mine.json.id}`, undefined, { cookie })).json;
  assert.equal(old.status, "superseded");
  assert.equal(old.superseded_by, newId);
  const fresh = (await req("GET", `/api/memories/${newId}`, undefined, { cookie })).json;
  assert.equal(fresh.status, "active");
  assert.equal(fresh.supersedes, mine.json.id);
  const log = gitLog();
  assert.equal(log.length, before + 1, "one commit for the accept");
  assert.equal(log[0], "memory: The building gate code changes every two months");
  assert.match(vaultFile(`memories/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, "0")}/${mine.json.id}.md`), /status: superseded/);
  assert.equal((await decide(r.data.id, "accept")).status, 409, "a decided proposal can't be decided again");

  const prov = (await req("GET", `/api/memories/${newId}/provenance`, undefined, { cookie })).json;
  assert.ok(prov.steps.some((s) => s.text === "Proposed by Mail reader"));
});

test("reject_and_forget_source forgets every memory from that source", async () => {
  const src = { kind: "email", label: "Statement from bank", ref: "msg-42" };
  for (const text of ["Savings account interest is 3%", "The branch moved to MG Road"]) {
    const r = await call(token, "propose", { kind: "memory", text, area: "money", scope: "finance", source: src });
    assert.equal((await decide(r.data.id, "accept")).status, 200);
  }
  const accepted = (await req("GET", "/api/memories?area=money", undefined, { cookie })).json.filter((m) => m.source.ref === "msg-42");
  assert.equal(accepted.length, 2);
  assert.ok(accepted.every((m) => m.trust === "untrusted"));

  const third = await call(token, "propose", { kind: "memory", text: "The bank waives the fee for you", area: "money", scope: "finance", source: src });
  const d = await decide(third.data.id, "reject_and_forget_source");
  assert.equal(d.json.status, "rejected");
  for (const m of accepted) assert.equal((await req("GET", `/api/memories/${m.id}`, undefined, { cookie })).json.status, "forgotten");
  assert.match(gitLog()[0], /^forget: 2 from Statement from bank/);
  assert.equal((await req("GET", "/api/memories?area=money", undefined, { cookie })).json.filter((m) => m.source.ref === "msg-42").length, 0);
  const trace = (await req("GET", "/api/trace?result=ok", undefined, { cookie })).json;
  assert.ok(trace.some((t) => t.action === "forget" && t.target === "msg-42"));
});

test("dedupe returns the existing memory; recalled memories can't be proposed back", async () => {
  const mine = await req("POST", "/api/memories", { text: "Dentist is Dr Rao in Indiranagar", area: "health", scope: "personal" }, { cookie });
  const dup = await call(token, "propose", { kind: "memory", text: "dentist is Dr Rao in Indiranagar.", area: "health" });
  assert.deepEqual(dup.data, { status: "accepted", id: mine.json.id, reasons: [] });

  const s = await call(token, "search", { query: "dentist" });
  assert.ok(s.data.hits.some((h) => h.id === mine.json.id));
  const again = await call(token, "propose", { kind: "memory", text: "Dentist is Dr Rao in Indiranagar", area: "home" });
  assert.equal(again.isError, true);
  assert.match(again.data, /recalled memories are never proposed back/);
  const trace = (await req("GET", "/api/trace?result=blocked", undefined, { cookie })).json;
  assert.ok(trace.some((t) => t.action === "propose" && t.who === "Mail reader"));
});

test("episodes from an agent are accepted directly", async () => {
  const r = await call(token, "propose", { kind: "episode", text: "Filed the electricity bill", area: "home" });
  assert.equal(r.data.status, "accepted");
  assert.match(gitLog()[0], /^journal: Filed the electricity bill/);
  const j = (await req("GET", "/api/journal", undefined, { cookie })).json;
  assert.ok(j.entries.some((e) => e.id === r.data.id && e.who === "Mail reader"));
});
