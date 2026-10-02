// The one MCP endpoint: stateless Streamable HTTP, bearer-authenticated (eg_ agent tokens or OAuth access tokens), four
// tools. Every call is traced and every read is cut to the caller's read grants; asking for a record outside them is
// refused and traced, never answered.
import { McpServer, OAuthError, OAuthErrorCode, bearerAuthChallengeResponse, createMcpHandler } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { z } from "zod";
import type { Agent, Scope } from "../shared/types.js";
import { SCOPES } from "../shared/types.js";
import { HOST, now, type HttpError } from "./config.js";
import { run } from "./db.js";
import { authenticate, readScopes } from "./agents.js";
import { trace, type Actor } from "./trace.js";
import { search, SEARCHABLE } from "./search.js";
import { propose } from "./proposals.js";
import { compile, entityView } from "./views.js";
import * as S from "./store.js";
import { registerUpstream, toolHits } from "./gateway/mcp.js";
import { instructions } from "./instructions.js";
import { verifyAccess } from "./oauth/store.js";
import { RESOURCE_METADATA_URL } from "./routes/oauth.js";
import { callRecord, taintFrom } from "./gateway/gate.js";

// structuredContent lets client-side Code Mode (Pi, programmatic tool calling) get typed values; content keeps plain clients working.
const text = (v: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], structuredContent: v });
const fail = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });
const errMsg = (e: unknown) => { const err = e as HttpError; if (!err.status || err.status >= 500) console.error("mcp tool failed:", err.message); return err.status && err.status < 500 ? err.message : "Engram couldn't do that"; };

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Search = z.object({
  query: z.string().min(1).max(500), kind: z.enum([...SEARCHABLE, "tool"]).optional(), area: slug.optional(), project: slug.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const Get = z.object({ id: z.string().min(1).max(120) });
const Hit = z.object({ kind: z.string(), id: z.string(), title: z.string(), snippet: z.string().optional(), area: z.string().optional(), scope: z.string().optional(), valid_until: z.string().nullish() }).passthrough();
const SearchOut = z.object({ hits: z.array(Hit) });
const GetOut = z.object({ kind: z.string(), record: z.unknown() });
const ProposeOut = z.object({ status: z.string(), id: z.string().nullable().optional(), reasons: z.array(z.string()) }).passthrough();
const ProfileOut = z.object({ target: z.string(), text: z.string(), lines: z.number() });
const Propose = z.object({
  kind: z.enum(["memory", "entity", "artifact", "skill", "episode"]),
  text: z.string().max(4000).optional().describe("memory or episode: the claim, or what happened"),
  title: z.string().max(200).optional(), name: z.string().max(120).optional(), summary: z.string().max(1000).optional(),
  description: z.string().max(300).optional(), body: z.string().max(20000).optional(),
  area: slug.optional(), project: slug.nullable().optional(), scope: z.enum(SCOPES as [Scope, ...Scope[]]).optional(),
  entity_kind: z.enum(["person", "place", "account", "document", "thing"]).optional(),
  artifact_kind: z.enum(["receipt", "statement", "report", "screenshot", "plan", "document"]).optional(),
  entities: z.array(z.string().max(60)).max(20).optional(), valid_from: date.nullable().optional(), valid_until: date.nullable().optional(),
  supersedes: z.string().max(60).nullable().optional().describe("id of the memory this corrects"),
  source: z.object({
    kind: z.enum(["agent", "email", "web", "file", "calendar", "other"]), label: z.string().max(200).optional(),
    ref: z.string().max(300).optional().describe("message id, URL or artifact id it came from"), at: z.number().int().optional(),
  }).optional(),
  content_base64: z.string().max(8_400_000).optional(), mime: z.string().max(100).optional(),
  outputs: z.array(z.object({ kind: z.string().max(40), ref: z.string().max(200), label: z.string().max(200) })).max(20).optional(),
});

function recordReads(agent: Agent, ids: string[]) {
  const t = now();
  for (const id of ids) run("INSERT INTO reads(memory_id,agent,n,last_at) VALUES(?,?,1,?) ON CONFLICT(memory_id,agent) DO UPDATE SET n=n+1, last_at=excluded.last_at", id, agent.id, t);
}

function getRecord(agent: Agent, who: Actor, scopes: Scope[], id: string) {
  const doc = S.docById(id);
  if (!doc || doc.kind === "area" || doc.kind === "project" || doc.status === "forgotten") { trace(who, "get", id, "error", null, "not found"); return fail("Not found"); }
  if (!scopes.includes(doc.scope)) { trace(who, "get", id, "refused", doc.scope, "outside read grants"); return fail("Outside this agent's read grants"); }
  let rec: unknown, read: string[] = [];
  if (doc.kind === "memory") { rec = S.memoryById(id); read = [id]; }
  else if (doc.kind === "entity") { const v = entityView(id, scopes)!; rec = v; read = v.memories.map((m) => m.id); }
  else if (doc.kind === "artifact") rec = S.artifacts([doc])[0];
  else if (doc.kind === "skill") rec = S.skills([doc.title])[0];
  else rec = S.docData(doc);
  recordReads(agent, read);
  taintFrom(agent.id, [rec]);
  trace(who, "get", id, "ok", doc.scope);
  return text({ kind: doc.kind, record: rec });
}

// A gated upstream call's status and, once run, its result (kept 1 h). Only the agent that made it can read it.
function getCall(agent: Agent, who: Actor, id: string) {
  const rec = callRecord(agent, id.slice(5));
  trace(who, "get", id, rec ? "ok" : "error", null, rec ? String(rec.status) : "not found");
  return rec ? text({ kind: "call", record: rec }) : fail("No such call, or its result has expired");
}

function server(agent: Agent) {
  const who: Actor = { id: agent.id, name: agent.name }, scopes = readScopes(agent);
  const s = new McpServer({ name: "engram", version: "0.1.0" }, { instructions: instructions(agent, scopes) });
  s.registerTool("search", { description: "Search what Engram knows that you may read: memories, people and things, files, journal, profile, skills (kind \"skill\"; load one with get) and the upstream tools you may call (kind \"tool\").", inputSchema: Search, outputSchema: SearchOut }, (a) => {
    const { hits, withheld } = a.kind === "tool" ? { hits: [], withheld: 0 } : search({ ...a, kind: a.kind as Exclude<typeof a.kind, "tool">, scopes });
    recordReads(agent, hits.filter((h) => h.kind === "memory").map((h) => h.id));
    taintFrom(agent.id, hits);
    if (!a.kind || a.kind === "tool") (hits as unknown[]).push(...toolHits(agent, a.query, a.limit ?? 10));
    trace(who, "search", a.query.slice(0, 80), "ok", null, `${hits.length} hits${withheld ? `, ${withheld} withheld` : ""}`);
    return text({ hits });
  });
  s.registerTool("get", { description: "Get one record by id, as returned by search.", inputSchema: Get, outputSchema: GetOut }, (a) => a.id.startsWith("call:") ? getCall(agent, who, a.id) : getRecord(agent, who, scopes, a.id));
  s.registerTool("propose", { description: "Propose a memory, entity, artifact or skill for review, or log an episode (what you did). Say where it came from in source.", inputSchema: Propose, outputSchema: ProposeOut }, async (a) => {
    try { return text(await propose(agent, a) as unknown as Record<string, unknown>); } catch (e) { return fail(errMsg(e)); }
  });
  s.registerTool("profile", { description: "How the user works: the compiled profile for you, within your grants.", inputSchema: z.object({}), outputSchema: ProfileOut }, () => {
    const p = compile(agent.profile, scopes);
    trace(who, "profile", agent.profile, "ok", null, `${p.lines} lines`);
    return text({ target: p.target, text: p.text, lines: p.lines });
  });
  registerUpstream(s, agent, who);
  return s;
}

const handler = createMcpHandler((ctx) => server(ctx.authInfo!.extra!.agent as Agent), {
  maxRequestBodySize: 9 << 20, onerror: (e) => console.error("mcp:", e.message),
});

// Bearer tokens can't be sent by a browser on its own, but a page script could still try; refuse foreign Origins outright.
export async function mcpRoute(c: Context) {
  const origin = c.req.header("origin");
  if (origin && !sameHost(origin, c.req.header("host"))) return c.json({ error: "Cross-site request refused" }, 403);
  const header = c.req.header("authorization");
  const agent = authenticate(header) ?? verifyAccess(header);
  if (!agent) {
    if (header) trace({ id: null, name: "unknown" }, "mcp", "auth", "refused", null, "bad, expired or revoked token");
    // resource_metadata points OAuth clients (ChatGPT, claude.ai) at discovery (RFC 9728); eg_ token clients ignore it.
    return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, "Missing or invalid token"), { resourceMetadataUrl: RESOURCE_METADATA_URL });
  }
  return handler.fetch(c.req.raw, { authInfo: { token: "", clientId: agent.id, scopes: readScopes(agent), extra: { agent } } });
}
function sameHost(origin: string, host: string | undefined) {
  try { const h = new URL(origin).host; return h === host || h === HOST; } catch { return false; }
}
