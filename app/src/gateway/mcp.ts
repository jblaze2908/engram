// What an agent sees of the gateway on /mcp: each granted, unblocked upstream tool under its exposed name (names.ts),
// proxied with Engram's credentials through the approval gate. Registered per MCP request from one indexed query.
import type { McpServer } from "@modelcontextprotocol/server";
import type { Agent } from "../../shared/types.js";
import { now } from "../config.js";
import { trace, type Actor } from "../trace.js";
import { ftsQuery } from "../search.js";
import { grantedTools, forwardedHints, type ToolRow } from "./store.js";
import { exposedName, byExposed } from "./names.js";
import { invoke, fail } from "./invoke.js";
import { gate, hold, taint } from "./gate.js";

const PER_MINUTE = 30;
export const trimmed = (d: string) => { const first = d.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " "); return first.length > 240 ? `${first.slice(0, 239)}…` : first; };

// Arguments are traced as shape only (key and type/length), never values: they can hold anything the agent read.
export function redact(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return "number";
  if (typeof v === "string") return `string(${v.length})`;
  if (Array.isArray(v)) return depth > 1 ? `array(${v.length})` : v.slice(0, 5).map((x) => redact(x, depth + 1));
  if (typeof v === "object") return depth > 1 ? "object" : Object.fromEntries(Object.entries(v as object).slice(0, 20).map(([k, x]) => [k.slice(0, 40), redact(x, depth + 1)]));
  return typeof v;
}

// Sliding one-minute window per agent, in memory: a restart forgets it, which is fine for a rate cap.
const calls = new Map<string, number[]>();
function overLimit(agent: string) {
  const t = now(), w = (calls.get(agent) || []).filter((x) => t - x < 60_000);
  if (w.length >= PER_MINUTE) { calls.set(agent, w); return true; }
  w.push(t); calls.set(agent, w);
  return false;
}

// The upstream server validates its own arguments and output; Engram only advertises the schemas it reported.
const passthrough = (schema: Record<string, unknown>) => ({
  "~standard": {
    version: 1 as const, vendor: "engram",
    validate: (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? { value: v } : { issues: [{ message: "Must be an object" }] }),
    jsonSchema: { input: () => schema, output: () => schema },
  },
});
const parsed = (s: string | null) => { try { return s ? JSON.parse(s) as Record<string, unknown> : null; } catch { return null; } };

type Granted = ToolRow & { untrusted: number; conn_name: string };

async function proxy(agent: Agent, who: Actor, t: Granted, args: Record<string, unknown>, typed: boolean) {
  const name = exposedName(t.conn_id, t.name), shape = redact(args), short = JSON.stringify(shape).slice(0, 300);
  if (overLimit(agent.id)) { trace(who, "tool", name, "refused", null, `over ${PER_MINUTE} calls a minute`); return fail(`Rate limit: ${PER_MINUTE} upstream calls a minute. Wait and try again.`); }
  const v = gate(agent.id, t);
  if (v.action === "block") { trace(who, "tool", name, "refused", null, `${short} · blocked by policy`); return fail(`${t.conn_id}/${t.name} is blocked in Engram; it can't be called.`); }
  if (v.action === "ask") {
    const id = hold(agent, who, t, args, shape, v.reasons);
    if (!id) return fail("Too many calls are already waiting for approval. Try again after they're decided.");
    // A tool with an outputSchema must return matching structuredContent unless isError, so the wait is reported as one there.
    return { content: [{ type: "text" as const, text: `Waiting for your approval (call ${id}). Call get('call:${id}') later for the result.` }], ...(typed ? { isError: true } : {}) };
  }
  const r = await invoke(t, args);
  if (t.untrusted && r.reached) taint(agent.id);
  trace(who, "tool", name, r.result, null, r.note ? `${short} · ${r.note}` : short);
  return r.out;
}

export function registerUpstream(s: McpServer, agent: Agent, who: Actor) {
  for (const [name, t] of byExposed(grantedTools(agent.id))) {
    const input = parsed(t.schema) ?? { type: "object" }, output = parsed(t.output_schema);
    s.registerTool(name, {
      description: `${t.conn_name}: ${trimmed(t.description)}`, inputSchema: passthrough(input) as any,
      ...(output ? { outputSchema: passthrough(output) as any } : {}), annotations: forwardedHints(t),
    }, ((a: Record<string, unknown>) => proxy(agent, who, t, a, !!output)) as any);
  }
}

/** search(kind "tool"): granted tools ranked by how many query words their name or description contain. */
export function toolHits(agent: Agent, query: string, limit = 10) {
  if (!ftsQuery(query)) return [];
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);
  return grantedTools(agent.id)
    .map((t) => {
      const hay = `${t.name.replace(/[_.-]/g, " ")} ${t.description}`.toLowerCase();
      return { t, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ t }) => ({
      kind: "tool" as const, id: exposedName(t.conn_id, t.name), title: t.name, snippet: trimmed(t.description), area: "", scope: "personal" as const,
      source: { kind: "other" as const, label: t.untrusted ? `${t.conn_name} (untrusted)` : t.conn_name }, valid_until: null,
    }));
}
