// The one MCP endpoint: stateless Streamable HTTP, bearer-authenticated (eg_ agent tokens or OAuth access tokens), four
// tools. Every call is traced and every read is cut to the caller's read grants; asking for a record outside them is
// refused and traced, never answered.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { McpServer, OAuthError, OAuthErrorCode, bearerAuthChallengeResponse, createMcpHandler } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { z } from "zod";
import type { Agent, Scope } from "../shared/types.js";
import { SCOPES } from "../shared/types.js";
import { HOST, VAULT, now, type HttpError } from "./config.js";
import { run } from "./db.js";
import { authenticate, readScopes } from "./agents.js";
import { trace, type Actor } from "./trace.js";
import { search, SEARCHABLE, agentNames, provenanceOf, readableIds } from "./search.js";
import { MAX_FILE, TEXT } from "./artifacts/shared.js";
import { propose, EPISODE_MAX, MEMORY_MAX } from "./proposals.js";
import { publish } from "./artifacts/app.js";
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
const when = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/);
// A bare date is midnight on the server's clock (set TZ on the host), as the trace and journal days are.
const toMs = (s: string) => (s.length === 10 ? new Date(`${s}T00:00:00`).getTime() : Date.parse(s));
const Search = z.object({
  query: z.string().min(1).max(500), kind: z.enum([...SEARCHABLE, "tool"]).optional().describe("only this kind of record"), area: slug.optional(), project: slug.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  agent: z.string().min(1).max(120).optional().describe("only records this agent (name or id) wrote, proposed or logged"),
  after: when.optional().describe("created or logged on or after this date (YYYY-MM-DD) or time"), before: when.optional().describe("created or logged before this date or time"),
});
const PAGE = 20_000;
const Get = z.object({
  id: z.string().min(1).max(120),
  offset: z.number().int().min(0).optional().describe("where to start reading a long text (page.next_offset from the last call)"),
  limit: z.number().int().min(1).max(100_000).optional().describe(`characters of it to return; default ${PAGE}`),
});
// provenance rides on passthrough: spelling it out cost every client 911 more bytes of tools/list.
const Hit = z.object({ kind: z.string(), id: z.string(), title: z.string(), snippet: z.string().optional(), area: z.string().optional(), scope: z.string().optional(), valid_until: z.string().nullish() }).passthrough();
const SearchOut = z.object({ hits: z.array(Hit) });
const Page = z.object({ field: z.string(), offset: z.number(), limit: z.number(), total: z.number(), next_offset: z.number().nullable() });
const GetOut = z.object({ kind: z.string(), record: z.unknown(), page: Page.optional() }).passthrough();
const ProposeOut = z.object({ status: z.string(), id: z.string().nullable().optional(), reasons: z.array(z.string()) }).passthrough();
const ProfileOut = z.object({ target: z.string(), text: z.string(), lines: z.number() });
const Publish = z.object({
  title: z.string().min(1).max(200), filename: z.string().min(1).max(200).describe("with its extension: report.md, plan.html, statement.pdf"),
  text: z.string().max(10_000_000).optional().describe("the file's contents, for text files (markdown, HTML, CSV, JSON)"),
  content_base64: z.string().max(14_000_000).optional().describe("the file's bytes as base64, for anything else; send text or this, not both"),
  id: z.string().max(80).optional().describe("publish a new version of an artifact you published before"),
  description: z.string().max(2000).optional(), area: slug.optional(), project: slug.nullable().optional(),
  scope: z.enum(SCOPES as [Scope, ...Scope[]]).optional(), public: z.boolean().optional().describe("ask the user for a public link anyone can open"),
});
const PublishOut = z.object({ id: z.string(), version: z.number(), url: z.string(), public_url: z.string().nullable(), status: z.string() });
const Propose = z.object({
  kind: z.enum(["memory", "entity", "artifact", "skill", "episode"]),
  text: z.string().max(EPISODE_MAX).optional().describe(`memory (up to ${MEMORY_MAX} characters): the claim; episode: what happened, in full`),
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

// Long text comes a page at a time instead of being cut: page.total is its length and next_offset where the rest starts.
function paged(rec: Record<string, unknown>, field: string, offset: number, limit: number) {
  const full = rec[field];
  if (typeof full !== "string") return undefined;
  const start = Math.min(offset, full.length);
  let end = Math.min(full.length, start + limit);
  // Never end a page inside a surrogate pair, and never return an empty page before the end.
  if (end < full.length && end - 1 > start && /[\uD800-\uDBFF]/.test(full[end - 1])) end--;
  rec[field] = full.slice(start, end);
  return { field, offset: start, limit, total: full.length, next_offset: end < full.length ? end : null };
}

// Text files are what an agent can read of an artifact (its url opens only for the user). One file read per get of
// a text artifact, which is what the call is for; binaries and anything over MAX_FILE stay links only.
const READABLE = new Set(["md", "markdown", "html", "htm", "svg", ...TEXT]);
function artifactText(a: { versions?: { sha256: string; ext: string }[] }) {
  const cur = a.versions?.at(-1);
  if (!cur || !READABLE.has(cur.ext)) return undefined;
  try {
    const p = join(VAULT, "artifacts/files", `${cur.sha256}.${cur.ext}`);
    return statSync(p).size > MAX_FILE ? undefined : readFileSync(p, "utf8");
  } catch { return undefined; }
}

const LONG: Partial<Record<S.DocKind, string>> = { memory: "text", episode: "text", artifact: "text", skill: "body", profile: "body" };
function getRecord(agent: Agent, who: Actor, scopes: Scope[], a: { id: string; offset?: number; limit?: number }) {
  const id = a.id, doc = S.docById(id);
  if (!doc || doc.kind === "area" || doc.kind === "project" || doc.status === "forgotten") { trace(who, "get", id, "error", null, "not found"); return fail("Not found"); }
  if (!scopes.includes(doc.scope)) { trace(who, "get", id, "refused", doc.scope, "outside read grants"); return fail("Outside this agent's read grants"); }
  let rec: any, read: string[] = [];
  if (doc.kind === "memory") { rec = S.memoryById(id); read = [id]; }
  else if (doc.kind === "entity") { const v = entityView(id, scopes)!; rec = v; read = v.memories.map((m) => m.id); }
  else if (doc.kind === "artifact") { rec = S.artifacts([doc])[0]; const t = artifactText(rec); if (t !== undefined) rec.text = t; }
  else if (doc.kind === "skill") rec = S.skills([doc.title])[0];
  else rec = S.docData(doc);
  recordReads(agent, read);
  taintFrom(agent.id, [rec]);
  const data = S.docData<any>(doc), provenance = provenanceOf(doc.kind, data, doc.at, doc.mtime, agentNames());
  const ref = data?.source?.ref;
  if (!provenance.open && ref && readableIds([ref], scopes).has(ref)) provenance.open = { id: ref };
  const page = LONG[doc.kind] ? paged(rec, LONG[doc.kind]!, a.offset ?? 0, a.limit ?? PAGE) : undefined;
  trace(who, "get", id, "ok", doc.scope, page?.next_offset != null ? `chars ${page.offset}-${page.next_offset} of ${page.total}` : null);
  return text({ kind: doc.kind, record: rec, provenance, ...(page ? { page } : {}) });
}

// A gated upstream call's status and, once run, its result (kept 1 h). Only the agent that made it can read it.
function getCall(agent: Agent, who: Actor, id: string) {
  const rec = callRecord(agent, id.slice(5));
  trace(who, "get", id, rec ? "ok" : "error", null, rec ? String(rec.status) : "not found");
  return rec ? text({ kind: "call", record: rec }) : fail("No such call, or its result has expired");
}

// propose's area as an enum of the vault's areas with their summaries, so clients pick one instead of leaving it out.
// Built per MCP request (one indexed read of the area rows), so a new area reaches every client on its next call.
function proposeSchema() {
  const list = S.areaList();
  if (!list.length) return Propose;
  const one = (a: { slug: string; summary: string }) => (a.summary ? `${a.slug} (${a.summary})` : a.slug);
  return Propose.extend({ area: z.enum(list.map((a) => a.slug) as [string, ...string[]]).optional()
    .describe(`The part of life it belongs to; pick the closest: ${list.map(one).join("; ")}. Left out, finance goes to money, health to health, anything else to home.`) });
}

function server(agent: Agent) {
  const who: Actor = { id: agent.id, name: agent.name }, scopes = readScopes(agent);
  const s = new McpServer({ name: "engram", version: "0.1.0" }, { instructions: instructions(agent, scopes) });
  s.registerTool("search", { description: "Search what Engram knows that you may read: memories, people and things, files, journal (kind \"episode\"), profile, skills (kind \"skill\"; load one with get) and the upstream tools you may call (kind \"tool\"). Filter by kind, area, agent and date. Each hit's provenance says who it came from (trust: user, agent or untrusted), whether it was reviewed, when, and open: the source to get or its URL. Open a hit in full with get.", inputSchema: Search, outputSchema: SearchOut }, (a) => {
    const after = a.after ? toMs(a.after) : undefined, before = a.before ? toMs(a.before) : undefined;
    if (Number.isNaN(after) || Number.isNaN(before)) return fail("after and before take a date (YYYY-MM-DD) or an ISO 8601 time");
    const { hits, withheld } = a.kind === "tool" ? { hits: [], withheld: 0 } : search({ ...a, after, before, kind: a.kind as Exclude<typeof a.kind, "tool">, scopes });
    recordReads(agent, hits.filter((h) => h.kind === "memory").map((h) => h.id));
    taintFrom(agent.id, hits);
    // Tools have no author or date, so an agent or date filter leaves them out.
    if ((!a.kind || a.kind === "tool") && !a.agent && !a.after && !a.before) (hits as unknown[]).push(...toolHits(agent, a.query, a.limit ?? 10));
    trace(who, "search", a.query.slice(0, 80), "ok", null, `${hits.length} hits${withheld ? `, ${withheld} withheld` : ""}`);
    return text({ hits });
  });
  s.registerTool("get", { description: "Get one record by id, as returned by search, in full: a text artifact comes with its text. Long text comes in pages of up to limit characters; when page.next_offset is set, call again with offset to read on.", inputSchema: Get, outputSchema: GetOut }, (a) => a.id.startsWith("call:") ? getCall(agent, who, a.id) : getRecord(agent, who, scopes, a));
  s.registerTool("propose", { description: "Propose a memory, entity, artifact or skill for review, or log an episode (what you did). Say where it came from in source, and give an area.", inputSchema: proposeSchema(), outputSchema: ProposeOut }, async (a) => {
    try { return text(await propose(agent, a) as unknown as Record<string, unknown>); } catch (e) { return fail(errMsg(e)); }
  });
  s.registerTool("publish", { description: "Publish one file (markdown, HTML, PDF, image, anything) as an artifact with one link, url, that only the user can open at first. Pass id to publish a new version at the same link. public: true asks the user to let anyone with the link open it; until they agree, public_url is null (it is url once they do).", inputSchema: Publish, outputSchema: PublishOut }, async (a) => {
    try { return text(await publish({ agent, actor: who, source: { kind: "agent", label: agent.name, agent: agent.id, ref: null, at: now() } }, a) as unknown as Record<string, unknown>); }
    catch (e) { trace(who, "publish", a.id || "artifact", "error", null, errMsg(e)); return fail(errMsg(e)); }
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
  maxRequestBodySize: 15 << 20, onerror: (e) => console.error("mcp:", e.message),
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
