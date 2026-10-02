import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { BASE, req, close, signIn, makeAgent, g, mcp, call } from "./_env.mjs";

const ISSUER = "https://engram.example.com";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
const local = (url) => BASE + new URL(url).pathname;
const register = (body) => req("POST", "/oauth/register", body, { csrf: false });
async function token(params, headers = {}) {
  const r = await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(params) });
  return { status: r.status, json: await r.json(), headers: r.headers };
}
const authorizeUrl = (client_id, challenge, extra = {}) => `${BASE}/oauth/authorize?${new URLSearchParams({
  response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-123", resource: `${ISSUER}/mcp`, ...extra,
})}`;
// /oauth/authorize → consent (signed in) → the code on the redirect URI.
async function codeFor(client_id, challenge, grants = [g("personal", true, "propose")], profile = "codex") {
  const a = await fetch(authorizeUrl(client_id, challenge), { redirect: "manual" });
  assert.equal(a.status, 302);
  const id = /^\/#\/consent\/([\w-]{32})$/.exec(a.headers.get("location"))[1];
  const ok = await req("POST", `/api/oauth/requests/${id}/approve`, { grants, profile }, { cookie });
  assert.equal(ok.status, 200, ok.text);
  const back = new URL(ok.json.redirect);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st-123");
  assert.equal(back.searchParams.get("iss"), ISSUER);
  return back.searchParams.get("code");
}

let cookie, pat, client;
before(async () => {
  cookie = await signIn();
  pat = (await makeAgent(cookie, "Claude Code", [g("personal", true)])).token;
  await req("POST", "/api/memories", { text: "Gym membership at Cult renews in June", area: "health", scope: "personal" }, { cookie });
});
after(close);

test("discovery from a 401: protected resource metadata, then authorization server metadata", async () => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(r.status, 401);
  const prmUrl = /resource_metadata="([^"]+)"/.exec(r.headers.get("www-authenticate"))[1];
  assert.equal(prmUrl, `${ISSUER}/.well-known/oauth-protected-resource/mcp`);
  const prm = await (await fetch(local(prmUrl))).json();
  assert.equal(prm.resource, `${ISSUER}/mcp`);
  assert.deepEqual(prm.authorization_servers, [ISSUER]);
  assert.deepEqual(await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json(), prm, "root probe gets the same document");
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, ISSUER);
  assert.equal(as.registration_endpoint, `${ISSUER}/oauth/register`);
  assert.equal(as.authorization_endpoint, `${ISSUER}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${ISSUER}/oauth/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none"));
});

test("registration: redirect URIs must be https or loopback http, exact strings", async () => {
  for (const bad of ["http://evil.example/cb", "myapp://cb", "https://x.example/cb#frag", "https://user:pw@x.example/cb", "not a url"]) {
    const r = await register({ redirect_uris: [bad], client_name: "Bad" });
    assert.equal(r.status, 400, bad);
    assert.equal(r.json.error, "invalid_redirect_uri");
  }
  assert.equal((await register({ redirect_uris: ["http://127.0.0.1:33418/callback", "http://localhost:5555/callback"] })).status, 201);
  assert.equal((await register({ redirect_uris: [REDIRECT], grant_types: ["client_credentials"] })).json.error, "invalid_client_metadata");
  const r = await register({ redirect_uris: [REDIRECT], client_name: "ChatGPT", token_endpoint_auth_method: "none" });
  assert.equal(r.status, 201);
  assert.match(r.json.client_id, /^egc_/);
  assert.equal(r.json.client_secret, undefined, "public client gets no secret");
  assert.equal(r.headers.get("cache-control"), "no-store");
  client = r.json.client_id;
});

test("authorize: unknown client or unregistered redirect is not redirected; protocol errors go back with state", async () => {
  const { challenge } = pkce();
  assert.equal((await fetch(authorizeUrl("egc_nope", challenge), { redirect: "manual" })).status, 400);
  assert.equal((await fetch(authorizeUrl(client, challenge, { redirect_uri: "https://evil.example/cb" }), { redirect: "manual" })).status, 400);
  assert.equal((await fetch(authorizeUrl(client, challenge, { redirect_uri: REDIRECT + "/x" }), { redirect: "manual" })).status, 400, "exact match only");
  for (const [extra, error] of [[{ code_challenge_method: "plain" }, "invalid_request"], [{ code_challenge: "" }, "invalid_request"], [{ response_type: "token" }, "unsupported_response_type"], [{ resource: "https://other.example/mcp" }, "invalid_target"]]) {
    const r = await fetch(authorizeUrl(client, challenge, extra), { redirect: "manual" });
    assert.equal(r.status, 302);
    const u = new URL(r.headers.get("location"));
    assert.equal(u.searchParams.get("error"), error);
    assert.equal(u.searchParams.get("state"), "st-123");
  }
});

test("consent needs a session and the CSRF header; a request is answered once", async () => {
  const { challenge } = pkce();
  const a = await fetch(authorizeUrl(client, challenge), { redirect: "manual" });
  const id = a.headers.get("location").split("/").pop();
  assert.equal((await req("GET", `/api/oauth/requests/${id}`)).status, 401);
  const view = await req("GET", `/api/oauth/requests/${id}`, undefined, { cookie });
  assert.equal(view.json.name, "ChatGPT");
  assert.equal(view.json.redirect_host, "chatgpt.com");
  assert.equal(view.json.agent, null);
  assert.equal((await req("POST", `/api/oauth/requests/${id}/approve`, { grants: [], profile: "codex" }, { cookie, csrf: false })).status, 403);
  assert.equal((await req("POST", `/api/oauth/requests/${id}/approve`, { grants: [g("private", true)], profile: "codex" }, { cookie })).status, 400, "private never");
  const deny = await req("POST", `/api/oauth/requests/${id}/deny`, {}, { cookie });
  assert.equal(new URL(deny.json.redirect).searchParams.get("error"), "access_denied");
  assert.equal((await req("POST", `/api/oauth/requests/${id}/approve`, { grants: [], profile: "codex" }, { cookie })).status, 404);
});

let tokens;
test("code + PKCE → tokens → /mcp works as the client's agent", async () => {
  const { verifier, challenge } = pkce();
  const code = await codeFor(client, challenge);
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: verifier, resource: `${ISSUER}/mcp` });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal(t.headers.get("cache-control"), "no-store");
  assert.match(t.json.access_token, /^ega_/);
  assert.match(t.json.refresh_token, /^egr_/);
  assert.equal(t.json.expires_in, 3600);
  tokens = t.json;
  const s = await call(tokens.access_token, "search", { query: "membership" });
  assert.deepEqual(s.data.hits.map((h) => h.title), ["Gym membership at Cult renews in June"]);
  const agents = (await req("GET", "/api/agents", undefined, { cookie })).json;
  const ag = agents.find((a) => a.name === "ChatGPT");
  assert.equal(ag.kind, "other");
  assert.equal(ag.profile, "codex");
  const apps = (await req("GET", "/api/oauth/clients", undefined, { cookie })).json;
  assert.deepEqual(apps.map((c) => [c.client_id, c.agent]), [[client, ag.id]]);
  assert.ok(apps[0].last_used_at);
  // Re-authorizing reuses the agent and replaces its grants.
  const again = await codeFor(client, pkce().challenge, [g("health", true)], "claude-code");
  assert.ok(again);
  const after = (await req("GET", "/api/agents", undefined, { cookie })).json.filter((a) => a.name.startsWith("ChatGPT"));
  assert.equal(after.length, 1);
  assert.equal(after[0].profile, "claude-code");
  assert.deepEqual(after[0].grants.filter((x) => x.read).map((x) => x.scope), ["health"]);
});

test("bad verifier, wrong redirect, another client's code, replayed code", async () => {
  const p = pkce(), code = await codeFor(client, p.challenge);
  assert.equal((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: pkce().verifier })).json.error, "invalid_grant");
  assert.equal((await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: p.verifier })).json.error, "invalid_grant", "a failed attempt burns the code");

  const other = (await register({ redirect_uris: [REDIRECT], client_name: "Other", token_endpoint_auth_method: "none" })).json.client_id;
  const p2 = pkce(), code2 = await codeFor(client, p2.challenge);
  assert.equal((await token({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, client_id: other, code_verifier: p2.verifier })).json.error, "invalid_grant");

  const p3 = pkce(), code3 = await codeFor(client, p3.challenge);
  assert.equal((await token({ grant_type: "authorization_code", code: code3, redirect_uri: REDIRECT + "?x=1", client_id: client, code_verifier: p3.verifier })).json.error, "invalid_grant");

  const p4 = pkce(), code4 = await codeFor(client, p4.challenge);
  const ok = await token({ grant_type: "authorization_code", code: code4, redirect_uri: REDIRECT, client_id: client, code_verifier: p4.verifier });
  assert.equal(ok.status, 200);
  assert.equal((await mcp(ok.json.access_token, "tools/list")).status, 200);
  assert.equal((await token({ grant_type: "authorization_code", code: code4, redirect_uri: REDIRECT, client_id: client, code_verifier: p4.verifier })).json.error, "invalid_grant");
  assert.equal((await mcp(ok.json.access_token, "tools/list")).status, 401, "a replayed code revokes what it bought");
});

test("refresh rotates; reusing a spent refresh token revokes the family", async () => {
  const r1 = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.json.refresh_token, tokens.refresh_token);
  assert.equal((await mcp(r1.json.access_token, "tools/list")).status, 200);
  const reuse = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.json.error, "invalid_grant");
  assert.equal((await mcp(r1.json.access_token, "tools/list")).status, 401, "the family's live access token dies");
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: client })).json.error, "invalid_grant");
  const trace = (await req("GET", "/api/trace?result=refused", undefined, { cookie })).json;
  assert.ok(trace.some((t) => t.action === "oauth.token" && /family revoked/.test(t.detail)));
  assert.ok(!JSON.stringify(trace).includes(tokens.refresh_token.slice(4, 20)), "tokens never reach the trace");
});

test("confidential client: secret required (basic or post)", async () => {
  const reg = await register({ redirect_uris: [REDIRECT], client_name: "Claude" });
  assert.equal(reg.json.token_endpoint_auth_method, "client_secret_basic");
  const { client_id, client_secret } = reg.json;
  assert.match(client_secret, /^egs_/);
  const p = pkce(), code = await codeFor(client_id, p.challenge);
  const base = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: p.verifier };
  const bad = await token({ ...base, client_id, client_secret: "egs_wrong" });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, "invalid_client");
  const basic = "Basic " + Buffer.from(`${client_id}:${client_secret}`).toString("base64");
  const ok = await token(base, { authorization: basic });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: ok.json.refresh_token, client_id, client_secret })).status, 200);
});

test("revoke in Agents kills every token; plain eg_ tokens are unaffected", async () => {
  const p = pkce(), code = await codeFor(client, p.challenge);
  const t = (await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client, code_verifier: p.verifier })).json;
  assert.equal((await mcp(t.access_token, "tools/list")).status, 200);
  assert.equal((await req("POST", `/api/oauth/clients/${client}/revoke`, {}, { cookie, csrf: false })).status, 403);
  assert.equal((await req("POST", `/api/oauth/clients/${client}/revoke`, {}, { cookie })).status, 200);
  assert.equal((await mcp(t.access_token, "tools/list")).status, 401);
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client })).json.error, "invalid_client");
  assert.equal((await fetch(authorizeUrl(client, p.challenge), { redirect: "manual" })).status, 400, "a revoked client can't start over");
  const ag = (await req("GET", "/api/agents", undefined, { cookie })).json.find((a) => a.name === "ChatGPT");
  assert.equal(ag.revoked, true);
  assert.ok(!(await req("GET", "/api/oauth/clients", undefined, { cookie })).json.some((c) => c.client_id === client));

  assert.equal((await mcp(pat, "tools/list")).status, 200);
  assert.equal((await call(pat, "search", { query: "membership" })).data.hits.length, 1);
  assert.equal((await mcp("ega_" + "A".repeat(43), "tools/list")).status, 401);
});
