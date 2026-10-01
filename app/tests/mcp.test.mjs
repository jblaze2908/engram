import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { req, close, signIn, makeAgent, g, mcp, call } from "./_env.mjs";

let cookie, reader, narrow, finance;
before(async () => {
  cookie = await signIn();
  reader = await makeAgent(cookie, "Claude Code", [g("personal", true, "propose")]);
  narrow = reader.token;
  for (const [text, area, scope] of [["Gym membership at Cult renews in June", "health", "personal"], ["Salary lands in the HDFC savings account", "money", "finance"], ["Membership card for the club is in the drawer", "home", "private"]]) {
    const r = await req("POST", "/api/memories", { text, area, scope }, { cookie });
    assert.equal(r.status, 200);
    if (scope === "finance") finance = r.json.id;
  }
});
after(close);

test("401 without a token, with a bad token, and after revoke", async () => {
  assert.equal((await mcp(null, "tools/list")).status, 401);
  assert.equal((await mcp("eg_" + "A".repeat(43), "tools/list")).status, 401);
  const tmp = await makeAgent(cookie, "Throwaway", [g("personal", true)]);
  assert.equal((await mcp(tmp.token, "tools/list")).status, 200);
  assert.equal((await req("POST", `/api/agents/${tmp.agent.id}/revoke`, {}, { cookie })).status, 200);
  assert.equal((await mcp(tmp.token, "tools/list")).status, 401);
});

test("end to end over HTTP: initialize, tools/list, search", async () => {
  const init = await mcp(narrow, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal(init.msg.result.serverInfo.name, "engram");
  const list = await mcp(narrow, "tools/list");
  assert.deepEqual(list.msg.result.tools.map((t) => t.name).sort(), ["get", "profile", "propose", "search"]);
  const s = await call(narrow, "search", { query: "membership" });
  assert.equal(s.isError, false);
  assert.deepEqual(s.data.hits.map((h) => h.title), ["Gym membership at Cult renews in June"], "private is never returned");
  assert.equal(s.data.hits[0].kind, "memory");
  assert.ok("snippet" in s.data.hits[0] && "valid_until" in s.data.hits[0] && "source" in s.data.hits[0]);
});

test("no finance read: finance hits filtered out, get refused and traced", async () => {
  const s = await call(narrow, "search", { query: "savings account salary" });
  assert.equal(s.data.hits.length, 0);
  const got = await call(narrow, "get", { id: finance });
  assert.equal(got.isError, true);
  assert.equal(got.data, "Outside this agent's read grants");
  const trace = (await req("GET", "/api/trace?result=refused", undefined, { cookie })).json;
  const row = trace.find((t) => t.action === "get" && t.target === finance);
  assert.ok(row, "refused read is traced");
  assert.equal(row.who, "Claude Code");
  assert.equal(row.scope, "finance");

  // Granting finance read makes the same record readable, and the read is counted.
  const p = await req("PATCH", `/api/agents/${reader.agent.id}`, { grants: [g("personal", true, "propose"), g("finance", true)] }, { cookie });
  assert.equal(p.status, 200);
  const ok = await call(narrow, "get", { id: finance });
  assert.equal(ok.isError, false);
  assert.equal(ok.data.record.text, "Salary lands in the HDFC savings account");
  assert.equal((await req("GET", `/api/memories/${finance}`, undefined, { cookie })).json.reads, 1);
});

test("private is never grantable", async () => {
  const r = await req("POST", "/api/agents", { name: "Greedy", kind: "other", profile: "codex", grants: [g("private", true)] }, { cookie });
  assert.equal(r.status, 400);
});

test("profile tool returns the compiled profile within grants", async () => {
  const p = await call(narrow, "profile", {});
  assert.equal(p.isError, false);
  assert.equal(p.data.target, "claude-code");
  const ui = (await req("GET", "/api/profile", undefined, { cookie })).json;
  assert.equal(ui.files.length, 6);
  assert.deepEqual(ui.compiled.map((c) => [c.target, c.budget]), [["claude-code", 200], ["codex", 200], ["crew-chief", 200], ["pitcrew-member", 60]]);
});

test("status and context screens build", async () => {
  const s = (await req("GET", "/api/status", undefined, { cookie })).json;
  assert.ok(s.calls_today >= 5);
  assert.ok(s.refused_today >= 1);
  assert.equal(s.calls_by_hour.length, 24);
  const c = (await req("GET", "/api/context", undefined, { cookie })).json;
  assert.equal(c.areas.length, 6);
  assert.equal(c.counts.memories, 3);
  assert.equal((await req("GET", "/api/areas/money", undefined, { cookie })).json.now.length, 1);
  assert.equal((await req("GET", "/api/areas/../etc", undefined, { cookie })).status, 404);
  assert.equal((await req("GET", "/api/artifacts/nope/file", undefined, { cookie })).status, 404);
  assert.deepEqual((await req("GET", "/api/connections", undefined, { cookie })).json, []);
});

test("M6: tools declare output schemas and return structuredContent (client-side Code Mode)", async () => {
  const list = await mcp(narrow, "tools/list");
  for (const t of list.msg.result.tools) assert.ok(t.outputSchema, `${t.name} has an outputSchema`);
  const r = await mcp(narrow, "tools/call", { name: "search", arguments: { query: "membership" } });
  const res = r.msg.result;
  assert.deepEqual(res.structuredContent, JSON.parse(res.content[0].text), "structured and text results agree");
  // D6 measurement input: what one agent's tools/list costs with only Engram's own tools.
  console.log(`# measured tools/list: ${list.msg.result.tools.length} tools, ${Buffer.byteLength(JSON.stringify(list.msg.result.tools))} bytes`);
});
