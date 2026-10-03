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
  assert.match(a.url, /^https:\/\/artifacts\.example\.com\/[\w-]{22}$/);
  const file = await req("GET", `/api/artifacts/${a.id}/file`, undefined, { cookie });
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
  assert.deepEqual(s.json.connections, [], "no tool grants yet, so no connection names");
  assert.equal((await L("GET", "/link/sync?pitcrew_id=nobody")).status, 404);
  assert.equal((await L("GET", "/link/nope")).status, 404);
});

// ---------- link v2: home scope, connections at hire, a member's own memories, journal ----------

function addConnection(id, tools) {
  run("INSERT INTO connections(id,name,url,auth,untrusted,state,created_at) VALUES(?,?,?,?,0,'ok',?)", id, id.toUpperCase(), `https://${id}.example/mcp`, "bearer", Date.now());
  for (const [name, inferred, policy] of tools)
    run("INSERT INTO conn_tools(conn_id,name,description,schema,pinned_text,pinned_hash,current_text,current_hash,inferred,seen_at,policy) VALUES(?,?,'','{}','','h','','h',?,?,?)", id, name, inferred, Date.now(), policy ?? null);
}

test("members: home scope sets area and grants; connections grant read tools once, on creation", async () => {
  addConnection("gh", [["list_issues", "read"], ["get_repo", "read", "block"], ["create_issue", "write"]]);
  const h = await L("POST", "/link/members", { pitcrew_id: "health", name: "Health", scope: "health", connections: ["gh", "nope"] });
  assert.equal(h.status, 200);
  const grants = Object.fromEntries(h.json.agent.grants.map((x) => [x.scope, [x.read, x.write]]));
  assert.deepEqual(grants, { personal: [true, "propose"], finance: [false, "none"], health: [true, "propose"], household: [false, "none"] });
  assert.deepEqual(h.json.agent.tools, ["gh/list_issues"], "read tools only, never blocked or write tools");
  const s = await L("GET", "/link/sync?pitcrew_id=health");
  assert.equal(s.json.scope, "health");
  assert.deepEqual(s.json.connections, [{ id: "gh", name: "GH" }]);

  const again = await L("POST", "/link/members", { pitcrew_id: "health", name: "Health", scope: "health", connections: [] });
  assert.deepEqual(again.json.agent.tools, ["gh/list_issues"], "a rotate never changes tool grants");
  const bills = await L("POST", "/link/members", { pitcrew_id: "bills", name: "Bills", area: "money", scope: "finance", connections: ["gh"] });
  assert.deepEqual(bills.json.agent.grants.find((x) => x.scope === "finance"), { scope: "finance", read: true, write: "propose" }, "a scope change adds its grant");
  assert.deepEqual(bills.json.agent.tools, [], "connections only apply on creation");
  await L("POST", "/link/members", { pitcrew_id: "bills", name: "Bills", area: "money" });
  assert.equal((await L("GET", "/link/memories?pitcrew_id=bills")).json.scope, "personal");
  assert.equal((await L("POST", "/link/members", { pitcrew_id: "x", name: "X", scope: "private" })).status, 400);

  const c = await L("GET", "/link/connections");
  assert.deepEqual(c.json.connections.find((x) => x.id === "gh"), { id: "gh", name: "GH", status: "ok", detail: "Fine", read: 2, write: 1 });
});

test("memories: clean turn accepted, own list and sync, dupes, supersede own only, untrusted held", async () => {
  const a = await L("POST", "/link/memories", { pitcrew_id: "health", text: "Allergic to penicillin", ref: "thread:t1" });
  assert.deepEqual([a.status, a.json.status, a.json.reasons], [200, "accepted", []]);
  const m = (await req("GET", `/api/memories/${a.json.id}`, undefined, { cookie })).json;
  assert.deepEqual([m.scope, m.area, m.source.kind, m.source.label, m.source.ref, m.trust], ["health", "health", "agent", "pitcrew:Health", "thread:t1", "trusted"]);
  assert.equal((await L("POST", "/link/memories", { pitcrew_id: "health", text: "allergic to penicillin." })).json.id, a.json.id, "an exact restatement is the same memory");

  const list = await L("GET", "/link/memories?pitcrew_id=health");
  assert.deepEqual(list.json.memories.map((x) => [x.id, x.text, x.scope, x.area, x.source]), [[a.json.id, "Allergic to penicillin", "health", "health", "pitcrew:Health"]]);
  assert.ok(typeof list.json.memories[0].created_at === "number");
  assert.deepEqual((await L("GET", "/link/sync?pitcrew_id=health")).json.memories, [{ id: a.json.id, text: "Allergic to penicillin" }]);
  assert.ok(!(await L("GET", "/link/memories?pitcrew_id=bills")).json.memories.some((x) => x.id === a.json.id), "another member never sees it");

  const b = await L("POST", "/link/memories", { pitcrew_id: "health", text: "Allergic to penicillin and amoxicillin", supersedes: a.json.id });
  assert.equal(b.json.status, "accepted");
  assert.equal((await req("GET", `/api/memories/${a.json.id}`, undefined, { cookie })).json.status, "superseded");
  assert.equal((await req("GET", `/api/memories/${b.json.id}`, undefined, { cookie })).json.supersedes, a.json.id);
  const fare = await L("POST", "/link/memories", { pitcrew_id: "health", text: "Clinic offers 20% off blood tests this month", valid_until: "2026-10-31" });
  assert.equal((await req("GET", `/api/memories/${fare.json.id}`, undefined, { cookie })).json.valid_until, "2026-10-31");
  assert.equal((await L("POST", "/link/memories", { pitcrew_id: "health", text: "Bad date", valid_until: "next week" })).status, 400);
  const theirs = (await L("POST", "/link/import/memories", { pitcrew_id: "bills", items: [{ text: "Water bill is quarterly" }] })).json.ids[0];
  assert.equal((await L("POST", "/link/memories", { pitcrew_id: "health", text: "x", supersedes: theirs })).status, 400, "only its own memories");
  assert.equal((await L("POST", "/link/memories", { pitcrew_id: "health", text: "y", supersedes: a.json.id })).status, 400, "only active ones");

  const u = await L("POST", "/link/memories", { pitcrew_id: "health", text: "Dr Rao moved clinics", untrusted: true });
  assert.equal(u.json.status, "held");
  assert.ok(u.json.reasons.includes("Saved during a Pitcrew turn that read untrusted content"));
  const inbox = (await L("GET", "/link/inbox")).json.proposals.find((p) => p.id === u.json.id);
  assert.deepEqual([inbox.held, inbox.scope], [true, "health"]);

  const d = await L("POST", "/link/memories", { pitcrew_id: "health", text: "Blood group is O+", by: "driver" });
  const dm = (await req("GET", `/api/memories/${d.json.id}`, undefined, { cookie })).json;
  assert.deepEqual([dm.source.kind, dm.source.label], ["you", "Added in Pitcrew"]);
  assert.ok((await L("GET", "/link/memories?pitcrew_id=health")).json.memories.some((x) => x.id === d.json.id), "yours, filed under the member");
  const over = await L("POST", "/link/memories", { pitcrew_id: "health", text: "Blood group is B+", supersedes: d.json.id });
  assert.equal(over.json.status, "held", "a member rewriting what you added waits for you");
  assert.equal((await L("POST", "/link/memories", { pitcrew_id: "nobody", text: "z" })).status, 404);
  assert.equal((await L("POST", "/link/memories", { pitcrew_id: "health", text: " " })).status, 400);
});

test("forget: own memories only", async () => {
  const mine = (await L("GET", "/link/memories?pitcrew_id=health")).json.memories[0].id;
  const theirs = (await L("GET", "/link/memories?pitcrew_id=bills")).json.memories[0].id;
  assert.equal((await L("POST", `/link/memories/${theirs}/forget`, { pitcrew_id: "health" })).status, 404);
  const r = await L("POST", `/link/memories/${mine}/forget`, { pitcrew_id: "health" });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal((await req("GET", `/api/memories/${mine}`, undefined, { cookie })).json.status, "forgotten");
  assert.ok(!(await L("GET", "/link/memories?pitcrew_id=health")).json.memories.some((x) => x.id === mine));
  const trace = (await req("GET", "/api/trace", undefined, { cookie })).json;
  assert.ok(trace.some((t) => t.action === "forget" && t.target === mine && t.who === "Pitcrew"));
});

test("episodes and imports land in the member's home scope and area", async () => {
  const at = Date.UTC(2026, 8, 30, 6);
  const e = await L("POST", "/link/episodes", { pitcrew_id: "health", text: "Booked a blood test for Friday", at, outputs: [{ kind: "thread", ref: "t1", label: "Blood test" }] });
  assert.deepEqual([e.status, e.json.status], [200, "accepted"]);
  assert.match(e.json.id, /^j/);
  assert.equal(gitLog()[0], "journal: Booked a blood test for Friday");
  assert.match(vaultFile(`journal/2026/09/30/${e.json.id}.md`), /scope: health/);
  const { one } = await import("../dist/src/db.js");
  assert.equal(one("SELECT scope FROM docs WHERE id=?", e.json.id).scope, "health", "a Health member's session isn't Personal");
  const future = await L("POST", "/link/episodes", { pitcrew_id: "health", text: "Clock skew", at: Date.now() + 365 * 86400000 });
  assert.equal(future.status, 200);
  assert.equal((await L("POST", "/link/episodes", { pitcrew_id: "health", text: "" })).status, 400);

  const im = await L("POST", "/link/import/memories", { pitcrew_id: "health", items: [{ text: "Takes vitamin D weekly" }] });
  const m = (await req("GET", `/api/memories/${im.json.ids[0]}`, undefined, { cookie })).json;
  assert.deepEqual([m.scope, m.area], ["health", "health"]);
  const art = await L("POST", "/link/import/artifacts", { pitcrew_id: "health", title: "Lab report", kind: "report", mime: "application/pdf", content_base64: Buffer.from("%PDF lab").toString("base64") });
  assert.equal((await req("GET", `/api/artifacts/${art.json.id}`, undefined, { cookie })).json.scope, "health");
});

test("link artifacts: what members published, with link state; other agents' files and forgotten ones stay out", async () => {
  const content_base64 = Buffer.from("# Goa\n").toString("base64");
  const p = await L("POST", "/link/artifacts", { pitcrew_id: "bills", title: "Goa plan", filename: "goa.md", content_base64, public: true, ref: "pitcrew:thread:th_goa" });
  assert.deepEqual([p.status, p.json.status], [200, "share_pending"]);
  const theirs = await call(other.token, "publish", { title: "Not from Pitcrew", filename: "x.md", text: "x" });
  const list = async () => (await L("GET", "/link/artifacts")).json.artifacts;
  const goa = (await list()).find((a) => a.id === p.json.id);
  assert.deepEqual([goa.title, goa.pitcrew_id, goa.version, goa.share_pending, goa.public_url, goa.ref, goa.url], ["Goa plan", "bills", 1, true, null, "pitcrew:thread:th_goa", p.json.url]);
  assert.ok(!(await list()).some((a) => a.id === theirs.data.id), "only Pitcrew members' artifacts");
  const share = (await req("GET", "/api/inbox", undefined, { cookie })).json.find((x) => x.kind === "share" && x.data.artifact_id === p.json.id);
  await req("POST", `/api/inbox/${share.id}`, { decision: "accept" }, { cookie });
  const shared = (await list()).find((a) => a.id === p.json.id);
  assert.deepEqual([shared.share_pending, shared.public_url], [false, shared.url], "public at its one link");
  await req("POST", `/api/artifacts/${p.json.id}/forget`, {}, { cookie });
  assert.ok(!(await list()).some((a) => a.id === p.json.id), "forgotten artifacts drop out");
  assert.equal((await req("GET", "/link/artifacts", undefined, { bearer: other.token, csrf: false })).status, 403, "the link token only");
});

test("link artifacts: search, member, status, kind and imported filters; pages by cursor; counts cover everything", async () => {
  const pub = (pitcrew_id, title, filename, content, extra = {}) =>
    L("POST", "/link/artifacts", { pitcrew_id, title, filename, content_base64: Buffer.from(content).toString("base64"), ref: `pitcrew:thread:th_${title.length}`, ...extra });
  const md = (await pub("bills", "Electricity tariff notes", "tariff.md", "# Tariff\nSlab rates for Bescom")).json;
  const pdf = (await pub("bills", "Rent agreement", "rent.pdf", "%PDF-1.4 rent")).json;
  const png = (await pub("health", "Blood report scan", "scan.png", "\x89PNG fake")).json;
  const wait = (await pub("health", "Diet plan", "diet.html", "<h1>Diet</h1>", { public: true })).json;
  const list = async (qs = "") => (await L("GET", `/link/artifacts${qs}`)).json;
  const ids = async (qs) => (await list(qs)).artifacts.map((a) => a.id);

  const all = await list();
  assert.ok(all.counts.imported >= 1, "the receipt imported earlier counts as imported");
  assert.ok(!all.artifacts.some((a) => a.ref === null), "imported files stay out unless asked for");
  assert.ok((await list("?imported=1")).artifacts.every((a) => a.ref === null));
  assert.equal(all.counts.waiting, all.artifacts.filter((a) => a.share_pending).length);

  assert.deepEqual(await ids("?q=bescom"), [md.id], "text artifacts match on their contents");
  assert.deepEqual(await ids("?q=rent"), [pdf.id]);
  assert.deepEqual(await ids("?q=%22%22"), [], "a query with no words matches nothing");
  assert.ok((await ids("?member=health")).includes(png.id) && !(await ids("?member=health")).includes(md.id));
  assert.deepEqual(await ids("?member=nobody"), []);
  assert.ok((await ids("?status=waiting")).includes(wait.id) && !(await ids("?status=private")).includes(wait.id));
  assert.ok((await ids("?status=private")).includes(md.id));
  assert.ok((await ids("?kind=pdf")).every((id) => id === pdf.id) && (await ids("?kind=pdf")).includes(pdf.id));
  assert.ok((await ids("?kind=image")).includes(png.id) && (await ids("?kind=page")).includes(md.id) && (await ids("?kind=page")).includes(wait.id));

  const p1 = await list("?limit=2");
  assert.equal(p1.artifacts.length, 2); assert.match(p1.next, /^\d+:art_/);
  const p2 = await list(`?limit=2&cursor=${encodeURIComponent(p1.next)}`);
  assert.equal(p2.artifacts.filter((a) => p1.artifacts.some((b) => b.id === a.id)).length, 0, "pages don't repeat");
  let seen = [], next = null;
  do { const p = await list(`?limit=3${next ? `&cursor=${encodeURIComponent(next)}` : ""}`); seen.push(...p.artifacts.map((a) => a.id)); next = p.next; } while (next);
  assert.deepEqual(seen, all.artifacts.map((a) => a.id), "walking the pages gives the whole list, newest first");

  for (const bad of ["?status=maybe", "?kind=exe", "?limit=500", "?cursor=x", "?member=../x"]) assert.equal((await L("GET", `/link/artifacts${bad}`)).status, 400, bad);
});

test("household: only members granted it read household facts; the toggle keeps the token", async () => {
  const fact = await req("POST", "/api/memories", { text: "Flat 4B, Indiranagar is home", area: "home", scope: "household" }, { cookie });
  assert.equal(fact.status, 200, fact.text);
  const plain = await L("POST", "/link/members", { pitcrew_id: "errands", name: "Errands" });
  const hh = await L("POST", "/link/members", { pitcrew_id: "courier", name: "Courier", household: true });
  const finds = async (token) => (await call(token, "search", { query: "Indiranagar home" })).data.hits.some((h) => h.id === fact.json.id);
  assert.equal(await finds(plain.json.token), false, "no household grant by default");
  assert.equal(await finds(hh.json.token), true);
  assert.equal((await L("GET", "/link/sync?pitcrew_id=courier")).json.household, true);
  assert.equal((await call(hh.json.token, "propose", { kind: "memory", text: "The gate code changed", scope: "household" })).isError, true, "read only");

  const off = await L("POST", "/link/members/courier/household", { household: false });
  assert.deepEqual(off.json, { household: false });
  assert.equal(await finds(hh.json.token), false, "same token, grant gone");
  assert.deepEqual((await L("POST", "/link/members/errands/household", { household: true })).json, { household: true });
  assert.equal(await finds(plain.json.token), true, "the toggle never rotates the token");
  assert.equal((await L("POST", "/link/members/nobody/household", { household: true })).status, 404);
});
