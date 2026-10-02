// Shared test harness: a fresh ENGRAM_ROOT per test file (node --test runs each file in its own process), a booted
// server on a free port, and small HTTP helpers for the web API and the MCP endpoint.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const ROOT = mkdtempSync(join(tmpdir(), "engram-test-"));
process.env.ENGRAM_ROOT = ROOT;
// No live MCP Registry sync in tests; the catalog test drives it against a local stand-in.
process.env.ENGRAM_REGISTRY_SYNC ??= "0";
const { boot, listen } = await import("../dist/src/server.js");
await boot();
const server = await listen(0, "127.0.0.1");
export const BASE = `http://127.0.0.1:${server.address().port}`;
export const close = () => new Promise((ok) => server.close(() => { rmSync(ROOT, { recursive: true, force: true }); ok(); }));

export async function req(method, path, body, { cookie, bearer, csrf = true, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (csrf && method !== "GET") h["x-engram"] = "1";
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

export async function signIn(password = "correct horse battery staple") {
  const token = readFileSync(join(ROOT, "setup-token"), "utf8").trim();
  const r = await req("POST", "/api/setup", { token, password });
  if (r.status !== 200) throw new Error(`setup failed: ${r.status} ${r.text}`);
  return r.headers.get("set-cookie").split(";")[0];
}

export async function makeAgent(cookie, name, grants, profile = "claude-code") {
  const r = await req("POST", "/api/agents", { name, kind: "mac", profile, grants }, { cookie });
  if (r.status !== 200) throw new Error(`agent failed: ${r.status} ${r.text}`);
  return r.json;
}
export const g = (scope, read, write = "none") => ({ scope, read, write });

let rpcId = 0;
// One JSON-RPC call over Streamable HTTP; the reply may be plain JSON or a one-event SSE stream.
export async function mcp(token, method, params = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const text = await r.text();
  if (r.status !== 200) return { status: r.status, text };
  const data = r.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === rpcId)
    : JSON.parse(text);
  return { status: r.status, msg: data };
}
export async function call(token, name, args) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  if (r.status !== 200) throw new Error(`mcp ${name}: ${r.status} ${r.text}`);
  const res = r.msg.result;
  return { isError: !!res.isError, data: res.isError ? res.content[0].text : JSON.parse(res.content[0].text) };
}

export const gitLog = () => execFileSync("git", ["log", "--format=%s"], { cwd: join(ROOT, "vault") }).toString().trim().split("\n");
export const vaultFile = (rel) => readFileSync(join(ROOT, "vault", rel), "utf8");
