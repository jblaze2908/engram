// Gateway state in SQLite: connections, the tools each one reported (with the pinned description), per-agent tool
// grants, and the OAuth states in flight. A tool whose current text differs from its pinned text is blocked.
import { createHash } from "node:crypto";
import type { Connection, ConnectionAuth, ConnectionDetail, ConnectionTool, Decision, Proposal, ToolGrant, ToolPolicy } from "../../shared/types.js";
import { now, uid, httpErr } from "../config.js";
import { db, one, all, run, tx } from "../db.js";
import { trace, type Actor } from "../trace.js";

db.exec(`
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, auth TEXT NOT NULL CHECK (auth IN ('oauth','bearer','none')),
  untrusted INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new', error TEXT,
  created_at INTEGER NOT NULL, connected_at INTEGER, refreshed_at INTEGER);
CREATE TABLE IF NOT EXISTS conn_tools (
  conn_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, schema TEXT NOT NULL,
  pinned_text TEXT NOT NULL, pinned_hash TEXT NOT NULL, current_text TEXT NOT NULL, current_hash TEXT NOT NULL,
  inferred TEXT NOT NULL, override TEXT, seen_at INTEGER NOT NULL, PRIMARY KEY (conn_id, name));
CREATE TABLE IF NOT EXISTS agent_tools (agent_id TEXT NOT NULL, conn_id TEXT NOT NULL, tool TEXT NOT NULL, PRIMARY KEY (agent_id, conn_id, tool));
CREATE INDEX IF NOT EXISTS agent_tools_conn ON agent_tools(conn_id, tool);
-- One row per authorization redirect in flight: state is stored hashed and bound to the browser session that began it.
CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, conn_id TEXT NOT NULL, session_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
`);
// Batch 2 columns on an existing install: upstream annotations and outputSchema as reported, your per-tool policy.
const toolCols = new Set(all<{ name: string }>("PRAGMA table_info(conn_tools)").map((r) => r.name));
for (const c of ["annotations", "output_schema", "policy"]) if (!toolCols.has(c)) db.exec(`ALTER TABLE conn_tools ADD COLUMN ${c} TEXT`);

export const ENGRAM: Actor = { id: null, name: "engram" };
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// 12 chars keeps mcp__engram__<conn>__ short enough that most tool names fit the 64-char client limit unshortened.
export const CONN_ID = /^[a-z0-9][a-z0-9-]{0,11}$/;
/** Secret flagging a connection whose sign-in you paste back: an https callback, or "1" for LOOPBACK (upstream.ts); disconnect drops it. */
export const PASTE_BACK = (id: string) => `conn:${id}:loopback`;
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export type ConnRow = { id: string; name: string; url: string; auth: ConnectionAuth; untrusted: number; state: "new" | "ok" | "auth" | "error"; error: string | null; created_at: number; connected_at: number | null; refreshed_at: number | null };
export type ToolRow = { conn_id: string; name: string; description: string; schema: string; pinned_text: string; pinned_hash: string; current_text: string; current_hash: string; inferred: "read" | "write"; override: "read" | "write" | null;
  annotations: string | null; output_schema: string | null; policy: ToolPolicy | null };

export const connRow = (id: string) => one<ConnRow>("SELECT * FROM connections WHERE id=?", id);
export const connRows = () => all<ConnRow>("SELECT * FROM connections ORDER BY created_at");
export const toolRows = (conn: string) => all<ToolRow>("SELECT * FROM conn_tools WHERE conn_id=? ORDER BY name", conn);
export const setState = (id: string, state: ConnRow["state"], error: string | null = null) => run("UPDATE connections SET state=?, error=? WHERE id=?", state, error, id);
export const kindOf = (t: Pick<ToolRow, "inferred" | "override">) => t.override || t.inferred;
export const policyOf = (t: Pick<ToolRow, "inferred" | "override" | "policy">): ToolPolicy => t.policy || (kindOf(t) === "write" ? "ask" : "allow");

// ---------- kinds ----------

const WRITES = new Set(["create", "update", "delete", "remove", "send", "merge", "pay", "write", "edit", "post", "put", "patch", "push", "reply", "forward", "trash", "move", "transfer", "set", "add", "close", "archive", "upload", "insert", "modify", "submit"]);
/** read unless the name or the annotations say it writes. Annotations are the server's word, so they can only add caution. */
export function inferKind(name: string, ann?: { readOnlyHint?: boolean; destructiveHint?: boolean }): "read" | "write" {
  const words = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => WRITES.has(w)) || ann?.readOnlyHint === false || ann?.destructiveHint === true ? "write" : "read";
}

type Props = { properties?: Record<string, { description?: string }> };
/** What gets pinned: the description plus each parameter's (and output field's) description, since any can carry an injected instruction. */
export function pinText(t: { description?: string; inputSchema?: Props; outputSchema?: Props }) {
  const described = (s: Props | undefined, pre: string) => Object.entries(s?.properties || {}).filter(([, p]) => typeof p?.description === "string" && p.description)
    .map(([k, p]) => `- ${pre}${k}: ${p.description}`);
  return [(t.description || "").trim(), ...described(t.inputSchema, ""), ...described(t.outputSchema, "output.")].filter(Boolean).join("\n").slice(0, 8000);
}

// Only the boolean hints travel: a title is free text the pin doesn't cover.
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
export type Hints = Partial<Record<(typeof HINTS)[number], boolean>>;
const hintsOf = (a: unknown): Hints | null => {
  if (!a || typeof a !== "object") return null;
  const h = Object.fromEntries(HINTS.filter((k) => typeof (a as Hints)[k] === "boolean").map((k) => [k, (a as Hints)[k]]));
  return Object.keys(h).length ? h : null;
};
/** What clients see: the upstream's hints, except Engram's write kind always says it may change and destroy things. */
export function forwardedHints(t: Pick<ToolRow, "annotations" | "inferred" | "override">): Hints | undefined {
  const h: Hints = t.annotations ? JSON.parse(t.annotations) : {};
  if (kindOf(t) === "write") Object.assign(h, { readOnlyHint: false, destructiveHint: true });
  return Object.keys(h).length ? h : undefined;
}
const outputSchemaOf = (o: unknown) => (o && typeof o === "object" && (o as { type?: unknown }).type === "object" ? JSON.stringify(o).slice(0, 100_000) : null);

// ---------- grants ----------

export const toolGrants = (agent: string): ToolGrant[] => all<{ g: string }>("SELECT conn_id || '/' || tool g FROM agent_tools WHERE agent_id=? ORDER BY g", agent).map((r) => r.g);

export function setToolGrants(agent: string, grants: string[]) {
  const pairs = [...new Set(grants)].map((g) => {
    const [c, t] = g.split("/");
    if (!c || !t || !CONN_ID.test(c) || !TOOL_NAME.test(t) || !one("SELECT 1 FROM conn_tools WHERE conn_id=? AND name=?", c, t)) throw httpErr(400, `Unknown tool: ${g.slice(0, 100)}`);
    return [c, t];
  });
  tx(() => {
    run("DELETE FROM agent_tools WHERE agent_id=?", agent);
    for (const [c, t] of pairs) run("INSERT INTO agent_tools(agent_id,conn_id,tool) VALUES(?,?,?)", agent, c, t);
  });
}

/** The upstream tools an agent may see now: granted, from a working connection, and not blocked. One query per MCP request. */
export const grantedTools = (agent: string) => all<ToolRow & { untrusted: number; conn_name: string }>(
  `SELECT t.*, c.untrusted, c.name conn_name FROM agent_tools g JOIN conn_tools t ON t.conn_id=g.conn_id AND t.name=g.tool JOIN connections c ON c.id=t.conn_id
   WHERE g.agent_id=? AND c.state='ok' AND t.current_hash=t.pinned_hash ORDER BY t.conn_id, t.name`, agent);

// ---------- screens ----------

function summary(c: ConnRow, tools: ToolRow[]): Pick<Connection, "status" | "detail"> {
  const changed = tools.filter((t) => t.current_hash !== t.pinned_hash).length;
  if (c.state === "auth") return { status: "signal", detail: c.error || "Needs you to sign in" };
  if (c.state === "error") return { status: "signal", detail: c.error || "Can't reach it" };
  if (changed) return { status: "signal", detail: `${changed} ${changed === 1 ? "description" : "descriptions"} changed` };
  if (c.state === "new") return { status: "warn", detail: "Not connected yet" };
  return { status: "ok", detail: "Fine" };
}

function grantsByTool(conn: string) {
  const m = new Map<string, string[]>();
  for (const r of all<{ tool: string; agent_id: string }>("SELECT g.tool, g.agent_id FROM agent_tools g JOIN agents a ON a.id=g.agent_id WHERE g.conn_id=? AND a.revoked=0", conn))
    m.set(r.tool, [...(m.get(r.tool) || []), r.agent_id]);
  return m;
}

const tool = (t: ToolRow, agents: string[]): ConnectionTool => ({ name: t.name, kind: kindOf(t), policy: policyOf(t), description: t.description, agents, pinned: true, changed: t.current_hash !== t.pinned_hash });

export function listConnections(): Connection[] {
  return connRows().map((c) => {
    const tools = toolRows(c.id), g = grantsByTool(c.id);
    return { id: c.id, name: c.name, ...summary(c, tools), tools: tools.map((t) => tool(t, g.get(t.name) || [])) };
  });
}

export function connectionDetail(id: string): ConnectionDetail {
  const c = connRow(id);
  if (!c) throw httpErr(404, "No such connection");
  const tools = toolRows(id), g = grantsByTool(id);
  return {
    id: c.id, name: c.name, ...summary(c, tools), url: c.url, auth: c.auth, untrusted: !!c.untrusted,
    paste_back: !!one("SELECT 1 FROM secrets WHERE name=?", PASTE_BACK(id)),
    connected_at: c.connected_at, refreshed_at: c.refreshed_at, tools: tools.map((t) => tool(t, g.get(t.name) || [])),
    changes: tools.filter((t) => t.current_hash !== t.pinned_hash).map((t) => ({ tool: t.name, approved: t.pinned_text, now: t.current_text })),
    memories: one<{ n: number }>("SELECT COUNT(*) n FROM docs d, json_each(d.data,'$.connections') c WHERE d.kind='memory' AND d.status='active' AND c.value=?", id)!.n,
  };
}

// ---------- tools/list reconciliation ----------

type Listed = { name: string; description?: string; inputSchema?: Record<string, any>; outputSchema?: Record<string, any>; annotations?: Hints };

/** First sight pins; a changed text blocks the tool for every agent and opens one tool_change proposal per new text. */
export function reconcile(conn: ConnRow, listed: Listed[]) {
  const t = now(), seen = new Set<string>(), changed: string[] = [];
  tx(() => {
    for (const l of listed.slice(0, 300)) {
      if (!TOOL_NAME.test(l.name) || seen.has(l.name)) continue;
      seen.add(l.name);
      const text = pinText(l), hash = sha256(text), desc = (l.description || "").slice(0, 4000);
      const schema = JSON.stringify(l.inputSchema && typeof l.inputSchema === "object" ? l.inputSchema : { type: "object" }).slice(0, 100_000);
      const ann = hintsOf(l.annotations), hints = ann ? JSON.stringify(ann) : null, out = outputSchemaOf(l.outputSchema);
      const old = one<ToolRow>("SELECT * FROM conn_tools WHERE conn_id=? AND name=?", conn.id, l.name);
      if (!old) {
        run("INSERT INTO conn_tools(conn_id,name,description,schema,pinned_text,pinned_hash,current_text,current_hash,inferred,annotations,output_schema,seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          conn.id, l.name, desc, schema, text, hash, text, hash, inferKind(l.name, ann ?? undefined), hints, out, t);
        continue;
      }
      run("UPDATE conn_tools SET description=?, schema=?, current_text=?, current_hash=?, inferred=?, annotations=?, output_schema=?, seen_at=? WHERE conn_id=? AND name=?",
        desc, schema, text, hash, inferKind(l.name, ann ?? undefined), hints, out, t, conn.id, l.name);
      if (hash === old.pinned_hash) { closeChanges(conn.id, l.name, null); continue; }
      // Same new text as last time: already proposed (or you chose Keep blocked); don't ask again.
      if (hash === old.current_hash) continue;
      closeChanges(conn.id, l.name, null);
      openToolChange(conn, l.name, old.pinned_text, text, hash, t);
      changed.push(l.name);
    }
    for (const r of all<{ name: string }>("SELECT name FROM conn_tools WHERE conn_id=?", conn.id)) if (!seen.has(r.name)) {
      run("DELETE FROM conn_tools WHERE conn_id=? AND name=?", conn.id, r.name);
      closeChanges(conn.id, r.name, null);
    }
  });
  for (const n of changed) trace(ENGRAM, "tool.changed", `${conn.id}/${n}`, "blocked", null, "description changed; blocked for every agent");
  return { tools: seen.size, changed };
}

// except = the proposal being decided; every other open change for that tool is now moot.
function closeChanges(conn: string, tool: string, except: string | null) {
  run("UPDATE proposals SET status='rejected', decided_at=? WHERE kind='tool_change' AND status='open' AND json_extract(data,'$.connection')=? AND json_extract(data,'$.tool')=? AND id IS NOT ?", now(), conn, tool, except);
}

function openToolChange(conn: ConnRow, tool: string, approved: string, text: string, hash: string, t: number) {
  const data = { connection: conn.id, connection_name: conn.name, tool, approved, now: text, hash };
  const source = { kind: "other", label: `${conn.name} tools/list`, agent: null, ref: null, at: t };
  run("INSERT INTO proposals(id,kind,agent,title,scope,area,data,norm,source,source_ref,reasons,held,replaces,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    uid("p"), "tool_change", null, `${conn.name}: ${tool} description changed`, "personal", "", JSON.stringify(data), null, JSON.stringify(source), null,
    JSON.stringify(["A tool description changed after you approved it", "It is blocked for every agent until you decide"]), 1, null, "open", t);
}

/** Approve = re-pin the text you looked at. If it changed again since, refuse: you'd be approving words you never saw. */
export function approveTool(conn: string, toolName: string, who: Actor, hash?: string, proposal: string | null = null) {
  const t = one<ToolRow>("SELECT * FROM conn_tools WHERE conn_id=? AND name=?", conn, toolName);
  if (!t) throw httpErr(404, "No such tool");
  if (hash && t.current_hash !== hash) throw httpErr(409, "It changed again since; look at the newest text");
  run("UPDATE conn_tools SET pinned_text=current_text, pinned_hash=current_hash WHERE conn_id=? AND name=?", conn, toolName);
  closeChanges(conn, toolName, proposal);
  trace(who, "tool.approve", `${conn}/${toolName}`, "ok", null, "re-pinned");
}

export function keepBlocked(conn: string, toolName: string, who: Actor) {
  if (!one("SELECT 1 FROM conn_tools WHERE conn_id=? AND name=?", conn, toolName)) throw httpErr(404, "No such tool");
  closeChanges(conn, toolName, null);
  trace(who, "tool.keep_blocked", `${conn}/${toolName}`, "blocked");
}

/** The inbox's decision on a tool_change proposal (called from proposals.decide). */
export function decideToolChange(p: Proposal, decision: Decision, who: Actor) {
  const d = p.data as { connection: string; tool: string; hash: string };
  if (decision === "accept") approveTool(d.connection, d.tool, who, d.hash, p.id);
  else trace(who, "tool.keep_blocked", `${d.connection}/${d.tool}`, "blocked");
  run("UPDATE proposals SET status=?, decided_at=? WHERE id=?", decision === "accept" ? "accepted" : "rejected", now(), p.id);
}

/** Moves a connection to a new id in one transaction: its row, tools, grants, sign-in states, calls, secrets and open
 *  proposals. Memories live in the vault (proposals.rekeyConnectionMemories); trace keeps the old id as history. */
export function rekeyConnection(from: string, to: string) {
  if (!CONN_ID.test(to)) throw httpErr(400, "Use 1-12 lowercase letters, numbers or dashes, starting with a letter or number");
  if (connRow(to)) throw httpErr(409, "A connection with that id exists");
  if (one("SELECT 1 FROM tool_calls WHERE conn_id=? AND status IN ('waiting','running')", from)) throw httpErr(409, "Finish or reject its waiting calls first");
  tx(() => {
    for (const t of ["conn_tools", "agent_tools", "oauth_states", "tool_calls"]) run(`UPDATE ${t} SET conn_id=? WHERE conn_id=?`, to, from);
    run("UPDATE connections SET id=? WHERE id=?", to, from);
    // CONN_ID allows no LIKE wildcards, so the prefix match is exact.
    run("UPDATE secrets SET name=? || substr(name, ?) WHERE name LIKE ?", `conn:${to}:`, `conn:${from}:`.length + 1, `conn:${from}:%`);
    run("UPDATE proposals SET data=json_set(data,'$.connection',?) WHERE json_extract(data,'$.connection')=?", to, from);
  });
}

export function deleteConnection(id: string) {
  tx(() => {
    for (const t of ["conn_tools WHERE conn_id=?", "agent_tools WHERE conn_id=?", "oauth_states WHERE conn_id=?", "connections WHERE id=?"]) run(`DELETE FROM ${t}`, id);
    run("UPDATE proposals SET status='rejected', decided_at=? WHERE kind='tool_change' AND status='open' AND json_extract(data,'$.connection')=?", now(), id);
  });
}
