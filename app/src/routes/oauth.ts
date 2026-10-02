// OAuth for remote MCP clients (docs/milestones.md Batch 2): discovery documents, registration, authorize, token and
// revoke at the top level; the consent screen and the connected-apps list under /api for your session.
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { buildOAuthProtectedResourceMetadata, checkResourceAllowed, getOAuthProtectedResourceMetadataUrl, oauthMetadataResponse, type AuthMetadataOptions } from "@modelcontextprotocol/server";
import { SCOPES, type ProfileTarget, type Scope } from "../../shared/types.js";
import { httpErr, type HttpError } from "../config.js";
import { you, body } from "../api.js";
import { TARGETS } from "../views.js";
import * as O from "../oauth/store.js";

const META: AuthMetadataOptions = {
  resourceServerUrl: new URL(O.RESOURCE), resourceName: "Engram", scopesSupported: [O.SCOPE],
  oauthMetadata: {
    issuer: O.ISSUER, authorization_endpoint: `${O.ISSUER}/oauth/authorize`, token_endpoint: `${O.ISSUER}/oauth/token`,
    registration_endpoint: `${O.ISSUER}/oauth/register`, revocation_endpoint: `${O.ISSUER}/oauth/revoke`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...O.AUTH_METHODS], revocation_endpoint_auth_methods_supported: [...O.AUTH_METHODS],
    scopes_supported: [O.SCOPE], authorization_response_iss_parameter_supported: true,
  },
};
export const RESOURCE_METADATA_URL = getOAuthProtectedResourceMetadataUrl(new URL(O.RESOURCE));

// Engram is the only resource on its host, so any path on it names the MCP endpoint.
const resourceOk = (r: string) => { try { return checkResourceAllowed({ requestedResource: r, configuredResource: `${O.ISSUER}/` }); } catch { return false; } };
const noStore = (c: Context) => { c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache"); };
const badClient = () => O.oauthErr(401, "invalid_client", "Client authentication failed");

async function readBody(c: Context, max: number) {
  if (Number(c.req.header("content-length") || 0) > max) throw O.oauthErr(413, "invalid_request", "Too large");
  const t = await c.req.text();
  if (t.length > max) throw O.oauthErr(413, "invalid_request", "Too large");
  return t;
}
// Token and revoke take a form body (RFC 6749); a JSON body is accepted too because some clients send one.
async function form(c: Context) {
  const t = await readBody(c, 16 << 10);
  if (!(c.req.header("content-type") || "").includes("json")) return new URLSearchParams(t);
  try { return new URLSearchParams(Object.entries(JSON.parse(t) as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][]); }
  catch { throw O.oauthErr(400, "invalid_request", "Bad body"); }
}
function clientCreds(c: Context, p: URLSearchParams) {
  const h = c.req.header("authorization");
  if (!h?.startsWith("Basic ")) return { id: p.get("client_id") ?? undefined, secret: p.get("client_secret") ?? undefined };
  const raw = Buffer.from(h.slice(6), "base64").toString(), i = raw.indexOf(":");
  if (i < 0) throw badClient();
  try { return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) }; } catch { throw badClient(); }
}

const Register = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10), client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.enum(O.AUTH_METHODS).optional(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).max(2).optional(), response_types: z.array(z.literal("code")).max(1).optional(),
}).passthrough();
const grant = z.object({ scope: z.enum(SCOPES as [Scope, ...Scope[]]), read: z.boolean(), write: z.enum(["none", "propose"]) });
const RID = /^[A-Za-z0-9_-]{32}$/, CID = /^egc_[A-Za-z0-9_-]{22}$/;
const rid = (c: Context) => { const v = c.req.param("id") || ""; if (!RID.test(v)) throw httpErr(404, "This sign-in request has expired. Start again from the app."); return v; };
const meta = (c: Context) => oauthMetadataResponse(c.req.raw, META) ?? c.json({ error: "Not found" }, 404);

export const oauth = new Hono()
  .all("/.well-known/oauth-protected-resource/mcp", meta)
  .all("/.well-known/oauth-authorization-server", meta)
  // Clients that probe the root document (no resource path) get the same one.
  .get("/.well-known/oauth-protected-resource", (c) => { c.header("Access-Control-Allow-Origin", "*"); return c.json(buildOAuthProtectedResourceMetadata(META)); })

  .post("/oauth/register", async (c) => {
    noStore(c);
    let raw: unknown;
    try { raw = JSON.parse(await readBody(c, 64 << 10)); } catch (e) { throw (e as O.OAuthErr).code ? e : O.oauthErr(400, "invalid_client_metadata", "Bad JSON"); }
    const r = Register.safeParse(raw);
    if (!r.success) { const k = String(r.error.issues[0]?.path[0] ?? "request"); throw O.oauthErr(400, k === "redirect_uris" ? "invalid_redirect_uri" : "invalid_client_metadata", `Invalid ${k}`); }
    return c.json(O.register(r.data), 201);
  })

  // The session cookie is SameSite=Strict, so it isn't sent on this cross-site navigation: the request is parked and
  // the web app (sign-in, then consent) picks it up by id.
  .get("/oauth/authorize", (c) => {
    const q = (k: string) => c.req.query(k), cl = O.client(q("client_id")), uri = q("redirect_uri"), state = q("state");
    // Without a known client and one of its exact redirect URIs there is nowhere safe to send an error.
    if (!cl) return c.text("Unknown client. Add the connector again from the app.", 400);
    if (!uri || !O.redirects(cl).includes(uri)) return c.text("That redirect URI isn't registered for this client.", 400);
    const fail = (error: string, msg: string, st = state ?? null) => c.redirect(O.backTo({ redirect_uri: uri, state: st }, { error, error_description: msg }), 302);
    if (state && state.length > 1000) return fail("invalid_request", "state is too long", null);
    if (q("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code");
    const ch = q("code_challenge");
    if (q("code_challenge_method") !== "S256" || !ch || !/^[A-Za-z0-9_-]{43}$/.test(ch)) return fail("invalid_request", "PKCE with S256 is required");
    const res = q("resource");
    if (res && !resourceOk(res)) return fail("invalid_target", "Unknown resource");
    return c.redirect(`/#/consent/${O.startRequest(cl, uri, ch, state)}`, 302);
  })

  .post("/oauth/token", async (c) => {
    noStore(c);
    const p = await form(c), { id, secret } = clientCreds(c, p), cl = O.authenticateClient(id, secret), res = p.get("resource");
    if (res && !resourceOk(res)) throw O.oauthErr(400, "invalid_target", "Unknown resource");
    const gt = p.get("grant_type");
    if (gt === "authorization_code") return c.json(O.exchangeCode(cl, p.get("code") ?? "", p.get("redirect_uri") ?? undefined, p.get("code_verifier") ?? undefined));
    if (gt === "refresh_token") return c.json(O.refresh(cl, p.get("refresh_token") ?? ""));
    throw O.oauthErr(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  })
  .post("/oauth/revoke", async (c) => {
    const p = await form(c), { id, secret } = clientCreds(c, p);
    O.revokeToken(O.authenticateClient(id, secret), p.get("token") ?? "");
    return c.json({});
  })

  .get("/api/oauth/requests/:id", you, (c) => c.json(O.consentView(rid(c))))
  .post("/api/oauth/requests/:id/approve", you, async (c) => {
    const b = await body(c, z.object({ grants: z.array(grant).max(4), profile: z.enum(TARGETS as [ProfileTarget, ...ProfileTarget[]]) }));
    return c.json(O.approve(rid(c), b));
  })
  .post("/api/oauth/requests/:id/deny", you, (c) => c.json(O.deny(rid(c))))
  .get("/api/oauth/clients", you, (c) => c.json(O.listClients()))
  .post("/api/oauth/clients/:id/revoke", you, (c) => {
    const v = c.req.param("id");
    if (!CID.test(v)) throw httpErr(404, "No such app");
    O.revokeClient(v);
    return c.json({ ok: true });
  });

oauth.onError((e: HttpError & { code?: string }, c) => {
  const status = e.status || 500;
  if (status === 500) console.error(new Date().toISOString(), c.req.method, c.req.path, e.stack);
  if (!e.code) return c.json({ error: status === 500 ? "Something went wrong" : e.message }, status as ContentfulStatusCode);
  if (e.code === "invalid_client") c.header("WWW-Authenticate", 'Basic realm="engram"');
  return c.json({ error: e.code, error_description: e.message }, status as ContentfulStatusCode);
});
