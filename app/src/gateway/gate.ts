// The approval gate: each upstream tool runs, waits for you (a tool_call proposal), or is refused. Arguments and
// results are stored encrypted like connection secrets; the proposal itself carries only their shape.
import type { Agent, Decision } from "../../shared/types.js";
import { UNTRUSTED } from "../../shared/types.js";
import { now, uid, httpErr } from "../config.js";
import { db, one, all, run, tx } from "../db.js";
import { getAgent } from "../agents.js";
import { trace, type Actor } from "../trace.js";
import { proposed } from "../notify.js";
import { getJson, putJson, dropSecret } from "./secrets.js";
import { kindOf, policyOf, type ToolRow } from "./store.js";
import { exposedName } from "./names.js";
import { invoke, fail, type Callable } from "./invoke.js";

db.exec(`
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, proposal TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, conn_id TEXT NOT NULL, tool TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting','running','done','error','rejected')), created_at INTEGER NOT NULL, done_at INTEGER);
CREATE INDEX IF NOT EXISTS tool_calls_agent ON tool_calls(agent_id, status);
CREATE INDEX IF NOT EXISTS tool_calls_done ON tool_calls(done_at);
-- When an agent last received untrusted content: one row per agent, overwritten.
CREATE TABLE IF NOT EXISTS agent_taint (agent_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
`);

const TAINT_MS = 10 * 60_000;
const KEEP_MS = 3600_000;
const MAX_WAITING = 20;
const argsKey = (id: string) => `call:${id}:args`;
const resultKey = (id: string) => `call:${id}:result`;
type CallRow = { id: string; proposal: string; agent_id: string; conn_id: string; tool: string; status: "waiting" | "running" | "done" | "error" | "rejected"; created_at: number; done_at: number | null };
type Gated = Callable & Pick<ToolRow, "inferred" | "override" | "policy">;

// ---------- taint ----------

export const taint = (agent: string) => run("INSERT INTO agent_taint(agent_id,at) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET at=excluded.at", agent, now());
export const tainted = (agent: string) => !!one("SELECT 1 FROM agent_taint WHERE agent_id=? AND at>?", agent, now() - TAINT_MS);
const untrustedRec = (r: any): boolean => !!r && typeof r === "object" &&
  (r.trust === "untrusted" || UNTRUSTED.includes(r.source?.kind) || (Array.isArray(r.memories) && r.memories.some(untrustedRec)));
/** Engram records an agent just received (search hits, a get): any from email or the web taints it. */
export function taintFrom(agent: string, recs: unknown[]) { if (recs.some(untrustedRec)) taint(agent); }

// ---------- the decision ----------

export type Verdict = { action: "run" } | { action: "ask"; reasons: string[] } | { action: "block" };
/** Reads keep their policy; a write that would run asks instead while the agent is tainted. */
export function gate(agent: string, t: Gated): Verdict {
  const p = policyOf(t), write = kindOf(t) === "write";
  if (p === "block") return { action: "block" };
  if (p === "ask") return { action: "ask", reasons: [write ? "Write tools wait for your approval" : "You set this tool to ask first"] };
  if (write && tainted(agent)) return { action: "ask", reasons: ["This agent read untrusted content in the last 10 minutes", "Its write tools wait for your approval until then"] };
  return { action: "run" };
}

/** An ask: store the arguments encrypted, open a held tool_call proposal, tell the agent how to collect the result. */
export function hold(agent: Agent, who: Actor, t: Gated, args: Record<string, unknown>, shape: unknown, reasons: string[]) {
  const name = exposedName(t.conn_id, t.name);
  if (one<{ n: number }>("SELECT COUNT(*) n FROM tool_calls WHERE agent_id=? AND status='waiting'", agent.id)!.n >= MAX_WAITING) {
    trace(who, "tool", name, "refused", null, `over ${MAX_WAITING} calls waiting`);
    return null;
  }
  const id = uid("c"), pid = uid("p"), at = now();
  const data = { call: id, connection: t.conn_id, connection_name: t.conn_name, tool: t.name, kind: kindOf(t), args: shape };
  const source = { kind: "agent", label: agent.name, agent: agent.id, ref: null, at };
  tx(() => {
    putJson(argsKey(id), args);
    run("INSERT INTO proposals(id,kind,agent,title,scope,area,data,norm,source,source_ref,reasons,held,replaces,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      pid, "tool_call", agent.id, `${agent.name} wants to run ${t.conn_id}/${t.name}`.slice(0, 200), "personal", "", JSON.stringify(data), null, JSON.stringify(source), null, JSON.stringify(reasons), 1, null, "open", at);
    run("INSERT INTO tool_calls(id,proposal,agent_id,conn_id,tool,status,created_at) VALUES(?,?,?,?,?,?,?)", id, pid, agent.id, t.conn_id, t.name, "waiting", at);
  });
  trace(who, "tool", name, "held", null, `${JSON.stringify(shape).slice(0, 240)} · call ${id}`);
  proposed();
  return id;
}

// ---------- your decision ----------

/** Approve runs it once: the proposal's move off 'open' is the lock, so a second approval gets 409 and runs nothing. */
export async function decideToolCall(pid: string, decision: Decision, who: Actor) {
  const c = one<CallRow>("SELECT * FROM tool_calls WHERE proposal=?", pid);
  if (!c) throw httpErr(404, "No such call");
  const t = now(), accept = decision === "accept";
  const moved = tx(() => {
    if (!run("UPDATE proposals SET status=?, decided_at=? WHERE id=? AND status='open'", accept ? "accepted" : "rejected", t, pid).changes) return false;
    run("UPDATE tool_calls SET status=?, done_at=? WHERE id=?", accept ? "running" : "rejected", accept ? null : t, c.id);
    return true;
  });
  if (!moved) throw httpErr(409, "Already decided");
  trace(who, accept ? "tool_call.approve" : "tool_call.reject", `${c.conn_id}/${c.tool}`, "ok", null, `call ${c.id}`);
  if (accept) await runApproved(c);
}

async function runApproved(c: CallRow) {
  const args = getJson<Record<string, unknown>>(argsKey(c.id)) ?? {}, a = getAgent(c.agent_id);
  const who: Actor = { id: c.agent_id, name: a?.name ?? c.agent_id }, name = exposedName(c.conn_id, c.tool);
  // Checked again now: the grant, the pin or your policy may have changed while it waited.
  const row = one<Gated & { revoked: number }>(
    `SELECT t.*, c.untrusted, c.name conn_name, a.revoked FROM agent_tools g JOIN conn_tools t ON t.conn_id=g.conn_id AND t.name=g.tool
     JOIN connections c ON c.id=t.conn_id JOIN agents a ON a.id=g.agent_id
     WHERE g.agent_id=? AND g.conn_id=? AND g.tool=? AND t.current_hash=t.pinned_hash`, c.agent_id, c.conn_id, c.tool);
  let out: Record<string, any>, ok = false;
  if (!row || row.revoked || policyOf(row) === "block") {
    out = fail("Not run: the agent's grant, the tool or its policy changed while it waited");
    trace(who, "tool", name, "refused", null, `approved call ${c.id} · no longer allowed`);
  } else {
    const r = await invoke(row, args);
    out = r.out; ok = r.result === "ok";
    trace(who, "tool", name, r.result, null, `approved call ${c.id}${r.note ? ` · ${r.note}` : ""}`);
  }
  putJson(resultKey(c.id), { out, untrusted: !!row?.untrusted });
  run("UPDATE tool_calls SET status=?, done_at=? WHERE id=?", ok ? "done" : "error", now(), c.id);
}

/** get("call:<id>") for the agent that made it. An untrusted result taints the agent like a direct call would. */
export function callRecord(agent: Agent, id: string) {
  pruneCalls();
  const c = one<CallRow>("SELECT * FROM tool_calls WHERE id=? AND agent_id=?", id, agent.id);
  if (!c) return null;
  const rec: Record<string, unknown> = { call: c.id, tool: `${c.conn_id}/${c.tool}`, status: c.status };
  if (c.status === "done" || c.status === "error") {
    const r = getJson<{ out: Record<string, unknown>; untrusted: boolean }>(resultKey(c.id));
    if (r) { rec.result = r.out; if (r.untrusted) taint(agent.id); }
  }
  return rec;
}

/** The inbox detail's full arguments: cookie-authed only, never in the proposal, the link mirror or a notification. */
export function callArgs(pid: string) {
  const c = one<CallRow>("SELECT * FROM tool_calls WHERE proposal=?", pid);
  if (!c) throw httpErr(404, "No such call");
  return { call: c.id, status: c.status, args: getJson<Record<string, unknown>>(argsKey(c.id)) ?? null };
}

/** Results (and the arguments) are dropped an hour after the call finished. Runs on each get and on the gateway timer. */
export function pruneCalls(t = now()) {
  const old = all<{ id: string }>("SELECT id FROM tool_calls WHERE done_at IS NOT NULL AND done_at<?", t - KEEP_MS);
  for (const r of old) { dropSecret(argsKey(r.id)); dropSecret(resultKey(r.id)); }
  if (old.length) run("DELETE FROM tool_calls WHERE done_at IS NOT NULL AND done_at<?", t - KEEP_MS);
}

/** A removed connection takes its waiting calls with it. */
export function dropCalls(conn: string) {
  const t = now();
  tx(() => {
    for (const c of all<CallRow>("SELECT * FROM tool_calls WHERE conn_id=? AND status='waiting'", conn)) {
      run("UPDATE proposals SET status='rejected', decided_at=? WHERE id=? AND status='open'", t, c.proposal);
      run("UPDATE tool_calls SET status='rejected', done_at=? WHERE id=?", t, c.id);
      dropSecret(argsKey(c.id));
    }
  });
}
