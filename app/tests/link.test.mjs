import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { req, close, signIn, makeAgent, g, call, gitLog, vaultFile } from "./_env.mjs";

const { run } = await import("../dist/src/db.js");

let cookie, link, other, mailer;
before(async () => {
  cookie = await signIn();
  const r = await req("POST", "/api/link", {}, { cookie });
  assert.equal(r.status, 200);
  link = r.json;
  other = await makeAgent(cookie, "Claude Code", [g("personal", true, "propose")]);
  mailer = await makeAgent(cookie, "Mail reader", [g("personal", true, "propose"), g("finance", true, "propose")]);
});
after(close);

const L = (method, path, body, token = link.token) => req(method, path, body, { bearer: token, csrf: false });

test("the link agent is one per install and shows as a Pitcrew agent", async () => {
  assert.equal(link.agent.link, true);
  assert.equal(link.agent.kind, "pitcrew");
  assert.equal((await req("POST", "/api/link", {}, { cookie })).status, 409);
  assert.equal((await req("GET", "/api/status", undefined, { cookie })).json.pitcrew_linked, false, "not linked until the token is used");
});

test("link routes refuse a missing, bad or non-link token", async () => {
  assert.equal((await req("GET", "/link/inbox")).status, 401);
  assert.equal((await L("GET", "/link/inbox", undefined, "eg_" + "x".repeat(43))).status, 401);
  const r = await L("GET", "/link/inbox", undefined, other.token);
  assert.equal(r.status, 403);
  assert.equal((await L("POST", "/link/members", { pitcrew_id: "bills", name: "Bills" }, other.token)).status, 403);
  const trace = (await req("GET", "/api/trace?result=refused", undefined, { cookie })).json;
  assert.ok(trace.some((t) => t.action === "link" && t.who === "Claude Code" && t.detail === "not a link token"));
  assert.equal((await req("GET", "/link/inbox", undefined, { bearer: link.token, headers: { origin: "https://evil.example" } })).status, 403);
});

test("the mirrored inbox never includes private scope; a decision via the link closes it and is traced", async () => {
  const held = await call(mailer.token, "propose", { kind: "memory", text: "Rent is due on the 5th", area: "home", source: { kind: "email", label: "Re: rent", ref: "msg-9" } });
  run("INSERT INTO proposals(id,kind,agent,title,scope,area,data,source,reasons,held,status,created_at) VALUES('p_private','memory','x','A private thing','private','home','{}','{}','[]',0,'open',?)", Date.now());
  const inbox = await L("GET", "/link/inbox");
  assert.equal(inbox.status, 200);
  assert.ok(typeof inbox.json.at === "number");
  assert.ok(inbox.json.proposals.some((p) => p.id === held.data.id && p.held && p.reasons[0] === "Email content is never trusted on its own"));
  assert.ok(!inbox.json.proposals.some((p) => p.scope === "private"));
  assert.equal((await L("POST", "/link/inbox/p_private", { decision: "accept" })).status, 404, "private can't be decided from Pitcrew");

  const d = await L("POST", `/link/inbox/${held.data.id}`, { decision: "accept" });
  assert.equal(d.status, 200);
  assert.equal(d.json.status, "accepted");
  assert.equal((await L("POST", `/link/inbox/${held.data.id}`, { decision: "accept" })).status, 409);
  assert.ok(!(await req("GET", "/api/inbox", undefined, { cookie })).json.some((p) => p.id === held.data.id), "closed in Engram too");
  const trace = (await req("GET", "/api/trace", undefined, { cookie })).json;
  assert.ok(trace.some((t) => t.action === "accept" && t.target === held.data.id && t.who === "you (in Pitcrew)"));
  assert.equal((await req("GET", "/api/status", undefined, { cookie })).json.pitcrew_linked, true);
});

test("members: create with defaults, Crew Chief profile, rotate keeps the agent and kills the old token", async () => {
  const a = await L("POST", "/link/members", { pitcrew_id: "bills", name: "Bills", hue: "c3", area: "money" });
  assert.equal(a.status, 200);
  assert.match(a.json.token, /^eg_[\w-]{43}$/);
  assert.equal(a.json.agent.kind, "pitcrew");
  assert.equal(a.json.agent.profile, "pitcrew-member");
  assert.equal(a.json.agent.hue, "c3");
  assert.deepEqual(a.json.agent.grants.find((x) => x.scope === "personal"), { scope: "personal", read: true, write: "propose" });
  assert.ok(a.json.agent.grants.filter((x) => x.scope !== "personal").every((x) => !x.read && x.write === "none"));

  const chief = await L("POST", "/link/members", { pitcrew_id: "chief", name: "Crew Chief" });
  assert.equal(chief.json.agent.profile, "crew-chief");

  const b = await L("POST", "/link/members", { pitcrew_id: "bills", name: "Bills", hue: "c4", area: "money" });
  assert.equal(b.json.agent.id, a.json.agent.id);
  assert.notEqual(b.json.token, a.json.token);
  assert.equal(b.json.agent.hue, "c4");
  assert.equal((await call(b.json.token, "search", { query: "rent" })).isError, false);
  const { mcp } = await import("./_env.mjs");
  assert.equal((await mcp(a.json.token, "tools/list")).status, 401, "the old token stops working");
  const agents = (await req("GET", "/api/agents", undefined, { cookie })).json;
  assert.equal(agents.filter((x) => x.name === "Bills").length, 1);

  assert.equal((await L("POST", "/link/members", { pitcrew_id: "x", name: "X", area: "nowhere" })).status, 400);
  await req("POST", `/api/agents/${chief.json.agent.id}/revoke`, {}, { cookie });
  assert.equal((await L("POST", "/link/members", { pitcrew_id: "chief", name: "Crew Chief" })).status, 409, "a member you revoked stays revoked");
});

test("import memories: accepted directly, labelled, area from the member, deduped", async () => {
  const before = gitLog().length;
  const t = Date.UTC(2026, 5, 10, 8);
  const r = await L("POST", "/link/import/memories", { pitcrew_id: "bills", items: [
    { text: "Electricity is billed on the 3rd", created_at: t }, { text: "electricity is billed on the 3rd." }, { text: "Airtel autopay is on" },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, 2);
  assert.equal(r.json.duplicates, 1);
  assert.equal(r.json.ids.length, 3);
  assert.equal(r.json.ids[0], r.json.ids[1]);
  assert.equal(gitLog().length, before + 1, "one commit for the batch");
  assert.equal(gitLog()[0], "import: 2 memories from pitcrew:Bills");
  const m = (await req("GET", `/api/memories/${r.json.ids[0]}`, undefined, { cookie })).json;
  assert.equal(m.status, "active");
  assert.equal(m.trust, "trusted");
  assert.equal(m.area, "money");
  assert.equal(m.scope, "personal");
  assert.deepEqual([m.source.kind, m.source.label], ["agent", "pitcrew:Bills"]);
  assert.equal(m.created_at, t);
  assert.match(vaultFile(`memories/2026/06/${m.id}.md`), /label: pitcrew:Bills/);

  const again = await L("POST", "/link/import/memories", { pitcrew_id: "bills", items: [{ text: "Airtel autopay is on" }] });
  assert.deepEqual([again.json.accepted, again.json.duplicates, again.json.ids[0]], [0, 1, r.json.ids[2]]);
  assert.equal((await L("POST", "/link/import/memories", { pitcrew_id: "nobody", items: [{ text: "x" }] })).status, 404);
  assert.equal((await L("POST", "/link/import/memories", { pitcrew_id: "bills", items: [] })).status, 400);
});

test("import artifacts: kept copy, deduped by content", async () => {
  const content_base64 = Buffer.from("%PDF-1.4 receipt").toString("base64");
  const r = await L("POST", "/link/import/artifacts", { pitcrew_id: "bills", title: "Airtel bill, Sep", kind: "receipt", mime: "application/pdf", content_base64, created_at: Date.UTC(2026, 8, 28) });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "accepted");
  const a = (await req("GET", `/api/artifacts/${r.json.id}`, undefined, { cookie })).json;
  assert.equal(a.kept, true);
  assert.equal(a.area, "money");
  assert.equal(a.source.label, "pitcrew:Bills");
  const file = await req("GET", a.url, undefined, { cookie });
  assert.equal(file.text, "%PDF-1.4 receipt");
  const dup = await L("POST", "/link/import/artifacts", { pitcrew_id: "bills", title: "Same bill", kind: "receipt", mime: "application/pdf", content_base64 });
  assert.equal(dup.json.id, r.json.id);
});

test("link digest and member sync bundle", async () => {
  const d = await L("GET", "/link/digest");
  assert.equal(d.status, 200);
  assert.match(d.json.week, /^\d{4}-W\d{2}$/);
  assert.ok(Array.isArray(d.json.journal));
  const s = await L("GET", "/link/sync?pitcrew_id=bills");
  assert.equal(s.status, 200);
  assert.equal(s.json.agent, "Bills");
  assert.equal(s.json.profile.target, "pitcrew-member");
  assert.equal((await L("GET", "/link/sync?pitcrew_id=nobody")).status, 404);
  assert.equal((await L("GET", "/link/nope")).status, 404);
});
