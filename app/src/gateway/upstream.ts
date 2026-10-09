// Engram's side of each upstream MCP server: one cached client per connection (never one per call), the OAuth client
// provider whose storage is the encrypted secrets table, tools/list on connect and on a single 6 h timer.
import { randomBytes } from "node:crypto";
import { Client, InMemoryTransport, StreamableHTTPClientTransport, auth, UnauthorizedError, OAuthError, type OAuthClientProvider, type OAuthClientMetadata,
  type StoredOAuthClientInformation, type StoredOAuthTokens, type OAuthDiscoveryState, type AuthProvider } from "@modelcontextprotocol/client";
import { HOST, now, httpErr, type HttpError } from "../config.js";
import { one, run } from "../db.js";
import { sha, safeEq } from "../auth.js";
import { safeFetch } from "./net.js";
import { getSecret, putSecret, getJson, putJson, dropSecret, dropSecrets } from "./secrets.js";
import { connRow, connRows, setState, reconcile, PASTE_BACK, type ConnRow } from "./store.js";
import { refreshRegistry } from "./catalog.js";
import { pruneCalls } from "./gate.js";
import { BUILTIN_GOOGLE, googleServer, googleAuthUrl, googleExchange, accessToken } from "./google.js";

export const ENGRAM_URL = (process.env.ENGRAM_URL || `https://${HOST}`).replace(/\/$/, "");
export const REDIRECT = `${ENGRAM_URL}/api/connections/oauth/callback`;
// For servers that only send sign-ins back to apps on your own computer (Canva). The browser ends on this unreachable
// address and you paste it into Engram; its code is useless without the PKCE verifier, which never leaves the server.
export const LOOPBACK = "http://127.0.0.1/engram/oauth/callback";
// Servers that check the callback only after you sign in, so the Connect probe can't see the refusal. Each gets a
// callback already on its allowlist that keeps the code in the address bar (Postman's is a static page).
const PASTE_BACK_VIA: Record<string, string> = { "mcp-server.zomato.com": "https://oauth.pstmn.io/v1/callback" };
const STATE_TTL = 10 * 60_000;
const REFRESH_EVERY = 6 * 3600_000;
const sec = (id: string, k: string) => `conn:${id}:${k}`;

/** OAuth storage for one connection. `session` is set only for a flow you started in the browser; background refresh has none. */
class Provider implements OAuthClientProvider {
  authUrl: URL | null = null;
  readonly redirectUrl: string;
  constructor(private id: string, private session: string | null) {
    const via = getSecret(PASTE_BACK(id));
    this.redirectUrl = !via ? REDIRECT : via.startsWith("https://") ? via : LOOPBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Engram", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() {
    if (!this.session) throw httpErr(409, "Sign in to this connection again from Connections");
    const s = randomBytes(32).toString("base64url");
    run("DELETE FROM oauth_states WHERE created_at<?", now() - STATE_TTL);
    run("INSERT INTO oauth_states(hash,conn_id,session_hash,created_at) VALUES(?,?,?,?)", sha(s), this.id, sha(this.session), now());
    return s;
  }
  clientInformation(ctx?: { issuer: string }) {
    const i = getJson<StoredOAuthClientInformation>(sec(this.id, "client"));
    // A pasted client id has no issuer yet: bind it to the first authorization server it is used with.
    if (i && !i.issuer && ctx?.issuer) { i.issuer = ctx.issuer; putJson(sec(this.id, "client"), i); }
    return i;
  }
  saveClientInformation(i: StoredOAuthClientInformation) { putJson(sec(this.id, "client"), i); }
  tokens() { return getJson<StoredOAuthTokens>(sec(this.id, "tokens")); }
  saveTokens(t: StoredOAuthTokens) { putJson(sec(this.id, "tokens"), t); }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
  saveCodeVerifier(v: string) { putSecret(sec(this.id, "verifier"), v); }
  codeVerifier() { const v = getSecret(sec(this.id, "verifier")); if (!v) throw httpErr(409, "Start the sign-in again"); return v; }
  saveDiscoveryState(s: OAuthDiscoveryState) { putJson(sec(this.id, "discovery"), s); }
  discoveryState() { return getJson<OAuthDiscoveryState>(sec(this.id, "discovery")); }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") { for (const k of ["tokens", "verifier", "discovery"]) dropSecret(sec(this.id, k)); if (!getSecret(sec(this.id, "pasted"))) dropSecret(sec(this.id, "client")); }
    else if (scope !== "client" || !getSecret(sec(this.id, "pasted"))) dropSecret(sec(this.id, scope));
  }
}

function authProvider(c: ConnRow): AuthProvider | OAuthClientProvider | undefined {
  if (c.auth === "bearer") return { token: async () => getSecret(sec(c.id, "bearer")) ?? undefined };
  if (c.auth === "oauth") return new Provider(c.id, null);
  return undefined;
}

export function saveCredentials(id: string, p: { token?: string; client_id?: string; client_secret?: string }) {
  if (p.token) putSecret(sec(id, "bearer"), p.token);
  if (p.client_id) {
    putJson(sec(id, "client"), { client_id: p.client_id, ...(p.client_secret ? { client_secret: p.client_secret } : {}) });
    putSecret(sec(id, "pasted"), "1");
  }
}

// ---------- clients ----------

const clients = new Map<string, Promise<Client>>();

function open(c: ConnRow) {
  const p = (async () => {
    const client = new Client({ name: "engram", version: "0.2.0" });
    // The built-in Google connection is an MCP server in this process: same client API, no network hop.
    if (c.url === BUILTIN_GOOGLE) {
      const [mine, theirs] = InMemoryTransport.createLinkedPair();
      await googleServer(c.id).connect(theirs);
      await client.connect(mine);
      return client;
    }
    const transport = new StreamableHTTPClientTransport(new URL(c.url), { authProvider: authProvider(c), fetch: safeFetch, onInsufficientScope: "throw" });
    await client.connect(transport);
    return client;
  })();
  p.catch(() => { if (clients.get(c.id) === p) clients.delete(c.id); });
  clients.set(c.id, p);
  return p;
}
export const clientFor = (c: ConnRow) => clients.get(c.id) ?? open(c);

export async function closeClient(id: string) {
  const p = clients.get(id);
  clients.delete(id);
  if (p) await p.then((c) => c.close(), () => {}).catch(() => {});
}

const OAUTH_OUTAGE = new Set(["server_error", "temporarily_unavailable", "too_many_requests"]);
/** A short sentence for the UI and trace. Upstream error text is never shown as-is: it can carry anything. */
export function describe(e: unknown, c: ConnRow): { state: ConnRow["state"]; error: string } {
  const err = e as HttpError;
  if (e instanceof UnauthorizedError || err?.name === "UnauthorizedError" || err?.status === 401) return { state: "auth", error: c.auth === "bearer" ? "The token was refused" : "Needs you to sign in" };
  // A refused token refresh (Zomato's /token wants a code_verifier even then); only the server's own outages aren't a sign-in.
  if (e instanceof OAuthError && !OAUTH_OUTAGE.has(e.code)) return { state: "auth", error: "Needs you to sign in" };
  if (err?.status && err.status < 500 && /^(Refused|Put credentials|Sign in|Start the sign-in)/.test(err.message)) return { state: "error", error: err.message };
  return { state: "error", error: "Can't reach it" };
}

/** tools/list now: on connect, on Refresh, and from the timer. Keeps the client cached for later calls. */
export async function refreshTools(id: string) {
  const c = connRow(id);
  if (!c) throw httpErr(404, "No such connection");
  try {
    // Its tools are local, so check the Google sign-in itself; a refresh here also keeps the token warm.
    if (c.url === BUILTIN_GOOGLE) await accessToken(c.id);
    const client = await clientFor(c);
    const { tools } = await client.listTools(undefined, { cacheMode: "bypass", timeout: 30_000 });
    const r = reconcile(c, tools);
    run("UPDATE connections SET state='ok', error=NULL, refreshed_at=?, connected_at=COALESCE(connected_at, ?) WHERE id=?", now(), now(), id);
    return r;
  } catch (e) {
    await closeClient(id);
    const d = describe(e, c);
    setState(id, d.state, d.error);
    if (!(e as HttpError).status || (e as HttpError).status! >= 500) console.error(`gateway: ${id} tools/list failed:`, (e as Error).name);
    throw httpErr(502, `${c.name}: ${d.error}`);
  }
}

// ---------- OAuth in the browser ----------

/** Connect: an OAuth connection without tokens gets an authorization URL to open; anything else lists tools. */
export async function connect(id: string, session: string): Promise<string | null> {
  const c = connRow(id);
  if (!c) throw httpErr(404, "No such connection");
  await closeClient(id);
  if (c.url === BUILTIN_GOOGLE) {
    if (!getJson(sec(id, "tokens"))) { setState(id, "auth", "Needs you to sign in"); return googleAuthUrl(id, REDIRECT, new Provider(id, session).state()); }
  } else if (c.auth === "oauth") {
    let url: URL | null;
    try { url = await authorizeUrl(c, session); } catch (e) {
      const d = describe(e, c);
      setState(id, d.state, d.error);
      throw httpErr(502, `${c.name}: ${d.state === "auth" ? "sign-in failed" : d.error}`);
    }
    if (url) { setState(id, "auth", "Needs you to sign in"); return url.href; }
  }
  await refreshTools(id);
  return null;
}

/** Discovery and registration; null when tokens already work. A server that refuses Engram's callback address gets
 *  registered again with LOOPBACK, once: after that the connection stays paste-back until it is disconnected. */
async function authorizeUrl(c: ConnRow, session: string): Promise<URL | null> {
  const via = PASTE_BACK_VIA[new URL(c.url).hostname];
  if (via && !getSecret(PASTE_BACK(c.id))) { new Provider(c.id, session).invalidateCredentials("all"); putSecret(PASTE_BACK(c.id), via); }
  for (;;) {
    const p = new Provider(c.id, session);
    if ((await auth(p, { serverUrl: c.url, fetchFn: safeFetch })) !== "REDIRECT") return null;
    if (!(await refusesRedirect(p.authUrl!))) return p.authUrl!;
    if (p.redirectUrl === LOOPBACK) throw httpErr(400, `Refused: ${c.name} won't send the sign-in back to Engram`);
    p.invalidateCredentials("all");
    putSecret(PASTE_BACK(c.id), "1");
  }
}

/** One unfollowed GET per Connect press: a 400 that names the redirect means the server allowlists callback addresses. */
async function refusesRedirect(u: URL) {
  try {
    const res = await safeFetch(u, { redirect: "manual" });
    if (res.status !== 400) { await res.body?.cancel(); return false; }
    return /redirect/i.test((await res.text()).slice(0, 2000));
  } catch { return false; }
}

/** The callback leg: the state must be one we issued, unused, under 10 minutes old, and from this same browser session. */
export async function finishOAuth(state: string, code: string, iss: string | undefined, session: string | undefined) {
  const row = one<{ conn_id: string; session_hash: string; created_at: number }>("SELECT * FROM oauth_states WHERE hash=?", sha(state));
  if (!row || now() - row.created_at > STATE_TTL) throw httpErr(400, "That sign-in link has expired; press Connect again");
  // Another session can't consume it either: both the state and the session are 256-bit random, so retrying gains nothing.
  if (!session || !safeEq(sha(session), row.session_hash)) throw httpErr(403, "Finish the sign-in in the browser that started it");
  run("DELETE FROM oauth_states WHERE hash=?", sha(state));
  const c = connRow(row.conn_id);
  if (!c) throw httpErr(404, "No such connection");
  try {
    if (c.url === BUILTIN_GOOGLE) await googleExchange(c.id, code, REDIRECT);
    else await auth(new Provider(c.id, session), { serverUrl: c.url, authorizationCode: code, iss, fetchFn: safeFetch });
  } catch (e) {
    const d = describe(e, c);
    setState(c.id, "auth", "Sign-in failed");
    throw httpErr(502, `${c.name}: ${d.state === "auth" ? "sign-in failed" : d.error}`);
  }
  dropSecret(sec(c.id, "verifier"));
  await refreshTools(c.id);
  return c.id;
}

export async function forget(id: string) {
  await closeClient(id);
  dropSecrets(`conn:${id}:`);
}

// One timer for every connection: every 15 min, refresh those not listed in 6 h (and drop expired call results). A restart doesn't reset the clock.
// The same tick keeps the MCP Registry copy for the catalog at most a day old.
export function startGateway() {
  if (process.env.ENGRAM_REGISTRY_SYNC !== "0") void refreshRegistry();
  const t = setInterval(async () => {
    pruneCalls();
    if (process.env.ENGRAM_REGISTRY_SYNC !== "0") void refreshRegistry();
    for (const c of connRows()) {
      if (c.state === "new" || (c.state === "auth" && c.auth === "oauth")) continue;
      if (c.refreshed_at && now() - c.refreshed_at < REFRESH_EVERY) continue;
      await refreshTools(c.id).catch(() => {});
    }
  }, 15 * 60_000);
  t.unref();
}
