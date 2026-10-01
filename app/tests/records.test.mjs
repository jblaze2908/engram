import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, BASE, req, close, signIn, makeAgent, g, call, gitLog } from "./_env.mjs";

const { scan } = await import("../dist/src/index.js");
let cookie, token;
before(async () => {
  cookie = await signIn();
  ({ token } = await makeAgent(cookie, "Filer", [g("personal", true, "propose"), g("finance", true, "propose")]));
});
after(close);
const accept = (id) => req("POST", `/api/inbox/${id}`, { decision: "accept" }, { cookie });

test("artifact: kept file served by sha only, never by a client path", async () => {
  const bytes = Buffer.from("%PDF-1.4 receipt");
  const r = await call(token, "propose", { kind: "artifact", title: "Airtel bill, Sep", artifact_kind: "receipt", area: "money", scope: "finance", mime: "application/pdf", content_base64: bytes.toString("base64"), source: { kind: "file", label: "Airtel bill PDF" } });
  assert.equal(r.data.status, "open");
  assert.equal((await accept(r.data.id)).status, 200);
  assert.match(gitLog()[0], /^artifact: Airtel bill, Sep/);
  const [a] = (await req("GET", "/api/artifacts", undefined, { cookie })).json;
  assert.equal(a.kept, true);
  assert.equal(a.size, bytes.length);
  const f = await fetch(BASE + a.url, { headers: { cookie } });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get("content-type"), "application/pdf");
  assert.match(f.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), bytes);
  for (const bad of ["..%2F..%2Fmaster.key", "%2E%2E", "a%00b"]) assert.equal((await req("GET", `/api/artifacts/${bad}/file`, undefined, { cookie })).status, 404, bad);
  assert.equal((await req("GET", `/api/artifacts/${a.id}/file`)).status, 401, "needs a session");
});

test("entity and skill proposals land in the vault", async () => {
  const e = await call(token, "propose", { kind: "entity", name: "Dr Rao", entity_kind: "person", summary: "Dentist", area: "health" });
  await accept(e.data.id);
  const people = (await req("GET", "/api/entities?kind=person", undefined, { cookie })).json;
  assert.equal(people[0].name, "Dr Rao");
  const s = await call(token, "propose", { kind: "skill", name: "File a receipt", description: "Where receipts go", body: "Save to Money, then log an episode." });
  await accept(s.data.id);
  const sk = (await req("GET", "/api/skills/file-a-receipt", undefined, { cookie })).json;
  assert.equal(sk.version, 1);
  const s2 = await call(token, "propose", { kind: "skill", name: "File a receipt", body: "Save to Money." });
  await accept(s2.data.id);
  assert.equal((await req("GET", "/api/skills/file-a-receipt", undefined, { cookie })).json.version, 2);
  const hit = await call(token, "search", { query: "where receipts", kind: "skill" });
  assert.equal(hit.data.hits[0].id, "skill:file-a-receipt");
});

test("profile lint: duplicate lines across files and the line budget", async () => {
  writeFileSync(join(ROOT, "vault/profile/rules.md"), "---\nscope: personal\n---\n- Never send email without asking\n");
  writeFileSync(join(ROOT, "vault/profile/working-style.md"), "---\nscope: personal\n---\n" + Array.from({ length: 70 }, (_, i) => `- line ${i} about how I work`).join("\n") + "\n- never send email without asking\n");
  scan();
  const { compiled } = (await req("GET", "/api/profile", undefined, { cookie })).json;
  const member = compiled.find((c) => c.target === "pitcrew-member");
  assert.ok(member.lines > 60);
  assert.ok(member.lint.some((l) => l.message.includes("budget is 60")));
  assert.ok(member.lint.some((l) => l.file === "working-style" && l.message === "Repeats rules.md line 1"));
  assert.equal(compiled.find((c) => c.target === "claude-code").lint.filter((l) => l.message.includes("budget")).length, 0);
  const p = await call(token, "profile", {});
  assert.match(p.data.text, /^## working-style/m);
});
