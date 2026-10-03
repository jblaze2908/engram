import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, req, close, signIn, makeAgent, g, call, gitLog, vaultFile } from "./_env.mjs";

let cookie, token;
before(async () => {
  cookie = await signIn();
  ({ token } = await makeAgent(cookie, "Filer", [g("personal", true, "propose"), g("finance", true, "propose")]));
});
after(close);
const add = async (text, area = "home", scope = "personal") => (await req("POST", "/api/memories", { text, area, scope }, { cookie })).json;
const memory = async (id) => (await req("GET", `/api/memories/${id}`, undefined, { cookie })).json;
const accept = (id) => req("POST", `/api/inbox/${id}`, { decision: "accept" }, { cookie });

test("edit: a new memory by you that supersedes the old one, in one commit", async () => {
  const old = await add("The flat is 4B on the fourth floor");
  const n = gitLog().length;
  const r = await req("POST", `/api/memories/${old.id}/edit`, { text: "The flat is 4C on the fourth floor" }, { cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.supersedes, old.id);
  assert.equal(r.json.source.kind, "you");
  assert.equal(r.json.status, "active");
  const was = await memory(old.id);
  assert.equal(was.status, "superseded");
  assert.equal(was.superseded_by, r.json.id);
  assert.equal(gitLog().length, n + 1);
  assert.equal(gitLog()[0], "edit: The flat is 4C on the fourth floor");
  assert.equal((await req("POST", `/api/memories/${old.id}/edit`, { text: "again" }, { cookie })).status, 409, "only an active memory");
  assert.equal((await req("POST", `/api/memories/${r.json.id}/edit`, { text: "the flat is 4C on the fourth floor." }, { cookie })).status, 400, "nothing changed");
});

test("mark as wrong: forgotten, wrong: true, reason in the commit", async () => {
  const m = await add("Parking spot is number 12");
  const r = await req("POST", `/api/memories/${m.id}/wrong`, { reason: "It is spot 21" }, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "forgotten");
  assert.equal(gitLog()[0], "wrong: Parking spot is number 12 (It is spot 21)");
  assert.match(vaultFile(r.json.path), /wrong: true/);
  assert.equal((await req("POST", `/api/memories/${m.id}/wrong`, { reason: "x" }, { cookie })).status, 409);
  const s = await call(token, "search", { query: "parking spot" });
  assert.equal(s.data.hits.length, 0);
});

test("forget an artifact: record and its memories forgotten, kept copy only in git history", async () => {
  const bytes = Buffer.from("%PDF-1.4 electricity bill");
  const a = await call(token, "propose", { kind: "artifact", title: "BESCOM bill, Sep", artifact_kind: "receipt", area: "money", scope: "finance", mime: "application/pdf", content_base64: bytes.toString("base64"), source: { kind: "file", label: "BESCOM PDF" } });
  await accept(a.data.id);
  const [art] = (await req("GET", "/api/artifacts", undefined, { cookie })).json.artifacts;
  assert.equal(art.path, `artifacts/${art.id}.md`);
  const m = await call(token, "propose", { kind: "memory", text: "BESCOM account is 1234", area: "money", scope: "finance", source: { kind: "file", label: "BESCOM PDF", ref: art.id } });
  await accept(m.data.id);
  const [mem] = (await req("GET", `/api/memories?area=money`, undefined, { cookie })).json.filter((x) => x.source.ref === art.id);
  const kept = `artifacts/files/${art.sha256}.pdf`;
  assert.ok(existsSync(join(ROOT, "vault", kept)));

  const r = await req("POST", `/api/artifacts/${art.id}/forget`, undefined, { cookie });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { id: art.id, memories: 1 });
  assert.equal(gitLog()[0], "forget: BESCOM bill, Sep and 1 memory");
  assert.equal((await memory(mem.id)).status, "forgotten");
  assert.deepEqual((await req("GET", "/api/artifacts", undefined, { cookie })).json.artifacts, []);
  assert.ok(!existsSync(join(ROOT, "vault", kept)), "copy left the working tree");
  assert.deepEqual(execFileSync("git", ["show", `HEAD~1:${kept}`], { cwd: join(ROOT, "vault") }), bytes, "and stays in history");
  const got = await call(token, "get", { id: art.id });
  assert.equal(got.isError, true);
  assert.equal((await req("POST", `/api/artifacts/${art.id}/forget`, undefined, { cookie })).status, 409);
});

test("skill proposal: link to profile instead", async () => {
  const s = await call(token, "propose", { kind: "skill", name: "Pay rent", description: "Monthly rent", body: "Pay on the 1st." });
  await accept(s.data.id);
  const edit = await call(token, "propose", { kind: "skill", name: "Pay rent", body: "Always ask before paying anything." });
  const r = await req("POST", `/api/inbox/${edit.data.id}/link-profile`, { file: "rules" }, { cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.proposal.status, "rejected");
  const sk = (await req("GET", "/api/skills/pay-rent", undefined, { cookie })).json;
  assert.equal(sk.version, 2);
  assert.equal(sk.body, "Pay on the 1st.\n\nsee: profile/rules");
  assert.equal(gitLog()[0], "skill: pay-rent → see profile/rules");
  const mem = await call(token, "propose", { kind: "memory", text: "Rent is due on the 1st", area: "home" });
  assert.equal((await req("POST", `/api/inbox/${mem.data.id}/link-profile`, { file: "rules" }, { cookie })).status, 400);
  const other = await call(token, "propose", { kind: "skill", name: "Pay rent", body: "x" });
  assert.equal((await req("POST", `/api/inbox/${other.data.id}/link-profile`, { file: "nope" }, { cookie })).status, 400);
});

test("trace: undo accept forgets the memory and restores the one it replaced", async () => {
  const mine = await add("Gate code is 1947", "building");
  const p = await call(token, "propose", { kind: "memory", text: "Gate code is 2024", area: "building", supersedes: mine.id });
  await accept(p.data.id);
  const newId = (await req("GET", "/api/memories?area=building", undefined, { cookie })).json.find((m) => m.text === "Gate code is 2024").id;
  assert.equal((await memory(mine.id)).status, "superseded");
  const row = (await req("GET", "/api/trace?who=you", undefined, { cookie })).json.find((t) => t.action === "accept" && t.target === p.data.id);
  assert.ok(row, "the accept is in the trace");
  const r = await req("POST", `/api/inbox/${row.target}/undo`, undefined, { cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.forgotten.status, "forgotten");
  assert.equal(r.json.restored.id, mine.id);
  const back = await memory(mine.id);
  assert.equal(back.status, "active");
  assert.equal(back.superseded_by, null);
  assert.equal((await memory(newId)).status, "forgotten");
  assert.match(gitLog()[0], /^undo: Gate code is 2024/);
  assert.equal((await req("POST", `/api/inbox/${p.data.id}/undo`, undefined, { cookie })).status, 409);
});

test("batch read by ids, any status; vault path for Open in Obsidian", async () => {
  const a = await add("Plumber is Ravi"), b = await add("Electrician is Suresh");
  await req("POST", `/api/memories/${b.id}/forget`, undefined, { cookie });
  const r = await req("GET", `/api/memories?ids=${a.id},${b.id},m_missing`, undefined, { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((m) => m.id).sort(), [a.id, b.id].sort());
  assert.match(r.json[0].path, /^memories\/\d{4}\/\d{2}\/m_[\w-]+\.md$/);
  assert.equal((await req("GET", "/api/memories?ids=a;b", undefined, { cookie })).status, 400);
  assert.equal((await req("GET", `/api/memories?ids=${Array(101).fill("m_x").join(",")}`, undefined, { cookie })).status, 400);
});
