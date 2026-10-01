// Everything an agent or you did, one row per call. Targets are ids or short labels, never secrets or full texts.
import type { Scope, TraceRow } from "../shared/types.js";
import { all, run, marks } from "./db.js";
import { now, startOfDay, DAY } from "./config.js";

export type Actor = { id: string | null; name: string };
export const YOU: Actor = { id: null, name: "you" };
type Result = TraceRow["result"];

export function trace(who: Actor, action: string, target: string, result: Result = "ok", scope: Scope | null = null, detail: string | null = null) {
  run("INSERT INTO trace(at,who,agent,action,target,scope,result,detail) VALUES(?,?,?,?,?,?,?,?)",
    now(), who.name, who.id, action, target.slice(0, 200), scope, result, detail ? detail.slice(0, 300) : null);
}

const RESULTS: Result[] = ["ok", "refused", "held", "blocked", "error"];
export function listTrace(f: { who?: string; result?: string; day?: string }): TraceRow[] {
  const where: string[] = [], args: (string | number)[] = [];
  if (f.who) { where.push("(who=? OR agent=?)"); args.push(f.who, f.who); }
  if (f.result && RESULTS.includes(f.result as Result)) { where.push("result=?"); args.push(f.result); }
  if (f.day) {
    const t = startOfDay(new Date(`${f.day}T00:00:00`).getTime());
    where.push("at>=? AND at<?"); args.push(t, t + DAY);
  }
  return all<TraceRow>(`SELECT id,at,who,action,target,scope,result,detail FROM trace ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 500`, ...args);
}

// Agent calls only: your own clicks in the web app aren't traffic.
export const agentCallsSince = (t: number, ids?: string[]) => ids?.length
  ? all<{ agent: string; n: number }>(`SELECT agent, COUNT(*) n FROM trace WHERE at>=? AND agent IN (${marks(ids.length)}) GROUP BY agent`, t, ...ids)
  : all<{ agent: string; n: number }>("SELECT agent, COUNT(*) n FROM trace WHERE at>=? AND agent IS NOT NULL GROUP BY agent", t);
export const pruneTrace = () => run("DELETE FROM trace WHERE at<?", now() - 365 * DAY);
