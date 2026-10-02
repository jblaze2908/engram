// Engram as an OAuth 2.1 authorization server for remote MCP clients (ChatGPT, claude.ai): dynamic registration,
// authorization code + PKCE S256, rotating refresh tokens. Each client that you approve is one Engram agent.
// Secrets, codes and tokens are stored only as sha256; revoking deletes rows, so nothing revoked can match later.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Agent, Grant, OAuthClient, OAuthConsent, ProfileTarget } from "../../shared/types.js";
import { HOST, now, httpErr, type HttpError } from "../config.js";
import { db, one, all, run, json, tx } from "../db.js";
import { sha, safeEq } from "../auth.js";
import { createAgent, getAgent, revokeAgent, updateAgent } from "../agents.js";
import { trace, YOU } from "../trace.js";

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY, secret_hash TEXT, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, auth_method TEXT NOT NULL,
  agent_id TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (
  hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, agent_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
  family TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
-- family: every token descended from one authorization code; a reused refresh token deletes the whole family.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access','refresh')), client_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  family TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family);
CREATE INDEX IF NOT EXISTS oauth_tokens_client ON oauth_tokens(client_id);
`);

export const ISSUER = (process.env.ENGRAM_PUBLIC_URL || `https://${HOST}`).replace(/\/+$/, "");
export const RESOURCE = `${ISSUER}/mcp`;
export const SCOPE = "engram";
const REQUEST_MS = 10 * 60000, CODE_MS = 5 * 60000, ACCESS_S = 3600, REFRESH_MS = 30 * 86400000;
export const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
const LOOPBACK = ["127.0.0.1", "[::1]", "localhost"];
const rand = (p: string) => `${p}${randomBytes(32).toString("base64url")}`;

export type OAuthErr = HttpError & { code: string };
export const oauthErr = (status: number, code: string, message: string): OAuthErr => Object.assign(httpErr(status, message), { code });

// https only, or http on loopback (RFC 8252 native apps); no fragment, no userinfo. Matched later as the exact string.
export function redirectOk(u: string) {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (u.includes("#") || url.username || url.password || u.length > 2000) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.includes(url.hostname));
}

// Global, like the password limiter: registration is open to anyone who can reach Engram.
let registrations: number[] = [];
export function register(m: { redirect_uris: string[]; client_name?: string; token_endpoint_auth_method?: typeof AUTH_METHODS[number] }) {
  const t = now();
  registrations = registrations.filter((r) => t - r < 3600000);
  if (registrations.length >= 30) throw oauthErr(429, "slow_down", "Too many registrations. Try again in an hour.");
  for (const u of m.redirect_uris) if (!redirectOk(u)) throw oauthErr(400, "invalid_redirect_uri", "Redirect URIs must be https, or http on a loopback address");
  registrations.push(t);
  // A client nobody approved within a day is noise from a probe or an abandoned connect.
  run("DELETE FROM oauth_clients WHERE agent_id IS NULL AND created_at<?", t - 86400000);
  const method = m.token_endpoint_auth_method ?? "client_secret_basic", id = `egc_${randomBytes(16).toString("base64url")}`;
  const secret = method === "none" ? null : rand("egs_");
  const name = (m.client_name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || "OAuth client";
  run("INSERT INTO oauth_clients(client_id,secret_hash,name,redirect_uris,auth_method,created_at) VALUES(?,?,?,?,?,?)", id, secret && sha(secret), name, JSON.stringify(m.redirect_uris), method, t);
  trace({ id: null, name: "anon" }, "oauth.register", id, "ok", null, name);
  return {
    client_id: id, client_id_issued_at: Math.floor(t / 1000), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name, redirect_uris: m.redirect_uris, token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: SCOPE,
  };
}

type ClientRow = { client_id: string; secret_hash: string | null; name: string; redirect_uris: string; auth_method: string; agent_id: string | null; created_at: number; last_used_at: number | null };
export const client = (id: string | undefined) => (id && id.length <= 64 ? one<ClientRow>("SELECT * FROM oauth_clients WHERE client_id=? AND revoked=0", id) : undefined);
export const redirects = (c: ClientRow) => json<string[]>(c.redirect_uris, []);

// Public clients (method none) prove nothing here; PKCE carries their proof. Confidential ones must present the secret.
export function authenticateClient(id: string | undefined, secret: string | undefined) {
  const c = client(id);
  if (!c) throw oauthErr(401, "invalid_client", "Unknown client");
  if (c.auth_method !== "none" && !(c.secret_hash && safeEq(sha(secret ?? ""), c.secret_hash))) throw oauthErr(401, "invalid_client", "Client authentication failed");
  return c;
}

export const S256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export function startRequest(c: ClientRow, redirect_uri: string, challenge: string, state: string | undefined) {
  prune();
  const id = randomBytes(24).toString("base64url");
  run("INSERT INTO oauth_requests(id,client_id,redirect_uri,state,challenge,expires_at) VALUES(?,?,?,?,?,?)", id, c.client_id, redirect_uri, state ?? null, challenge, now() + REQUEST_MS);
  return id;
}

type RequestRow = { id: string; client_id: string; redirect_uri: string; state: string | null; challenge: string; expires_at: number };
function pending(id: string) {
  const r = one<RequestRow>("SELECT * FROM oauth_requests WHERE id=? AND expires_at>?", id, now()), c = r && client(r.client_id);
  if (!r || !c) throw httpErr(404, "This sign-in request has expired. Start again from the app.");
  return { r, c };
}

export function consentView(id: string): OAuthConsent {
  const { r, c } = pending(id);
  return { id, client_id: c.client_id, name: c.name, redirect_uri: r.redirect_uri, redirect_host: new URL(r.redirect_uri).host, agent: c.agent_id ? liveAgent(c.agent_id) : null, expires_at: r.expires_at };
}

export function backTo(r: { redirect_uri: string; state: string | null }, params: Record<string, string>) {
  const u = new URL(r.redirect_uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (r.state !== null) u.searchParams.set("state", r.state);
  u.searchParams.set("iss", ISSUER);
  return u.href;
}

function uniqueName(base: string) {
  for (let i = 1; i < 50; i++) { const n = i === 1 ? base : `${base} (${i})`; if (!one("SELECT 1 FROM agents WHERE name=? AND revoked=0", n)) return n; }
  return `${base} ${randomBytes(3).toString("hex")}`;
}

// Approving creates the client's agent once (its eg_ token is discarded: this agent signs in only through OAuth),
// or re-grants the live one. Upstream tool grants stay as set in the Agents screen.
export function approve(id: string, p: { grants: Grant[]; profile: ProfileTarget }) {
  // Checked before the request is spent, so a refused grant leaves it answerable (agents.setGrants refuses it too).
  if (p.grants.some((g) => g.scope === "private" && (g.read || g.write !== "none"))) throw httpErr(400, "Private is never granted to an agent");
  const { r, c } = claim(id), code = rand("");
  let a = c.agent_id ? liveAgent(c.agent_id) : null;
  if (a) { updateAgent(a.id, { grants: p.grants }); run("UPDATE agents SET profile=? WHERE id=?", p.profile, a.id); }
  else { a = createAgent({ name: uniqueName(c.name), kind: "other", profile: p.profile, grants: p.grants }).agent; run("UPDATE oauth_clients SET agent_id=? WHERE client_id=?", a.id, c.client_id); }
  run("INSERT INTO oauth_codes(hash,client_id,agent_id,redirect_uri,challenge,family,expires_at) VALUES(?,?,?,?,?,?,?)", sha(code), c.client_id, a.id, r.redirect_uri, r.challenge, randomBytes(12).toString("base64url"), now() + CODE_MS);
  trace(YOU, "oauth.consent", c.client_id, "ok", null, `${c.name} as ${a.name}`);
  return { redirect: backTo(r, { code }) };
}

// One decision per request: a double-submitted Allow can't mint two codes.
function claim(id: string) {
  const p = pending(id);
  if (!Number(run("DELETE FROM oauth_requests WHERE id=?", id).changes)) throw httpErr(404, "This sign-in request was already answered.");
  return p;
}

export function deny(id: string) {
  const { r, c } = claim(id);
  trace(YOU, "oauth.consent", c.client_id, "refused", null, c.name);
  return { redirect: backTo(r, { error: "access_denied" }) };
}

function issue(c: ClientRow, agent: string, family: string) {
  const access = rand("ega_"), refresh = rand("egr_"), t = now();
  run("INSERT INTO oauth_tokens(hash,kind,client_id,agent_id,family,expires_at) VALUES(?,?,?,?,?,?)", sha(access), "access", c.client_id, agent, family, t + ACCESS_S * 1000);
  run("INSERT INTO oauth_tokens(hash,kind,client_id,agent_id,family,expires_at) VALUES(?,?,?,?,?,?)", sha(refresh), "refresh", c.client_id, agent, family, t + REFRESH_MS);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_S, refresh_token: refresh, scope: SCOPE };
}
const liveAgent = (id: string) => { const a = getAgent(id); return a && !a.revoked ? a : null; };
const killFamily = (family: string) => run("DELETE FROM oauth_tokens WHERE family=?", family);

export function exchangeCode(c: ClientRow, code: string, redirect_uri: string | undefined, verifier: string | undefined) {
  const row = one<{ agent_id: string; client_id: string; redirect_uri: string; challenge: string; family: string; expires_at: number; used: number }>("SELECT * FROM oauth_codes WHERE hash=?", sha(code));
  if (!row || row.client_id !== c.client_id || row.expires_at < now()) throw oauthErr(400, "invalid_grant", "Invalid or expired code");
  // A replayed code means it leaked: what it already bought is revoked too (RFC 6749 §4.1.2).
  if (row.used) { killFamily(row.family); trace({ id: row.agent_id, name: c.name }, "oauth.token", c.client_id, "refused", null, "code reused; tokens revoked"); throw oauthErr(400, "invalid_grant", "Code already used"); }
  run("UPDATE oauth_codes SET used=1 WHERE hash=?", sha(code));
  if (redirect_uri !== row.redirect_uri) throw oauthErr(400, "invalid_grant", "redirect_uri does not match");
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEq(S256(verifier), row.challenge)) throw oauthErr(400, "invalid_grant", "PKCE verification failed");
  const a = liveAgent(row.agent_id);
  if (!a) throw oauthErr(400, "invalid_grant", "The agent was revoked");
  touch(c.client_id, a.id);
  trace({ id: a.id, name: a.name }, "oauth.token", c.client_id, "ok", null, "authorization_code");
  return issue(c, a.id, row.family);
}

export function refresh(c: ClientRow, token: string) {
  const row = one<{ hash: string; client_id: string; agent_id: string; family: string; expires_at: number; used_at: number | null }>("SELECT * FROM oauth_tokens WHERE hash=? AND kind='refresh'", sha(token));
  if (!row || row.client_id !== c.client_id || row.expires_at < now()) throw oauthErr(400, "invalid_grant", "Invalid or expired refresh token");
  if (row.used_at) {
    killFamily(row.family);
    trace({ id: row.agent_id, name: c.name }, "oauth.token", c.client_id, "refused", null, "refresh token reused; family revoked");
    throw oauthErr(400, "invalid_grant", "Refresh token already used");
  }
  const a = liveAgent(row.agent_id);
  if (!a) throw oauthErr(400, "invalid_grant", "The agent was revoked");
  run("UPDATE oauth_tokens SET used_at=? WHERE hash=?", now(), row.hash);
  touch(c.client_id, a.id);
  return issue(c, a.id, row.family);
}

// RFC 7009: unknown tokens are not an error. A refresh token takes its family with it.
export function revokeToken(c: ClientRow, token: string) {
  const row = one<{ family: string; kind: string; client_id: string }>("SELECT family, kind, client_id FROM oauth_tokens WHERE hash=?", sha(token));
  if (!row || row.client_id !== c.client_id) return;
  if (row.kind === "refresh") killFamily(row.family); else run("DELETE FROM oauth_tokens WHERE hash=?", sha(token));
}

function touch(clientId: string, agentId: string) {
  const t = now();
  run("UPDATE oauth_clients SET last_used_at=? WHERE client_id=? AND (last_used_at IS NULL OR last_used_at<?)", t, clientId, t - 60000);
  run("UPDATE agents SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)", t, agentId, t - 60000);
}

// Per /mcp request with an OAuth token: one indexed join, one agent read, last-used writes at most once a minute.
export function verifyAccess(header: string | undefined): Agent | null {
  const m = /^Bearer (ega_[A-Za-z0-9_-]{43})$/.exec(header || "");
  if (!m) return null;
  const h = sha(m[1]);
  const r = one<{ hash: string; agent_id: string; client_id: string }>("SELECT t.hash, t.agent_id, t.client_id FROM oauth_tokens t JOIN oauth_clients c ON c.client_id=t.client_id WHERE t.hash=? AND t.kind='access' AND t.expires_at>? AND c.revoked=0", h, now());
  if (!r || !timingSafeEqual(Buffer.from(r.hash), Buffer.from(h))) return null;
  const a = liveAgent(r.agent_id);
  if (a) touch(r.client_id, a.id);
  return a;
}

export const listClients = (): OAuthClient[] =>
  all<ClientRow>("SELECT * FROM oauth_clients WHERE revoked=0 AND agent_id IS NOT NULL ORDER BY created_at")
    .map((c) => ({ client_id: c.client_id, name: c.name, redirect_uris: redirects(c), agent: c.agent_id!, created_at: c.created_at, last_used_at: c.last_used_at }));

export function revokeClient(id: string) {
  const c = client(id);
  if (!c) throw httpErr(404, "No such app");
  tx(() => {
    run("UPDATE oauth_clients SET revoked=1, secret_hash=NULL WHERE client_id=?", id);
    for (const t of ["oauth_tokens", "oauth_codes", "oauth_requests"]) run(`DELETE FROM ${t} WHERE client_id=?`, id);
  });
  if (c.agent_id && liveAgent(c.agent_id)) revokeAgent(c.agent_id);
  trace(YOU, "oauth.revoke", id, "ok", null, c.name);
}

// Cheap enough per authorization (rare): drops expired requests, codes and tokens.
function prune() {
  const t = now();
  for (const tb of ["oauth_requests", "oauth_codes", "oauth_tokens"]) run(`DELETE FROM ${tb} WHERE expires_at<?`, t);
}
