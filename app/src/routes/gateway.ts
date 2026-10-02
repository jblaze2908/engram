// /api/connections (the gateway screens) and per-agent tool grants. Cookie session + CSRF header, like the rest of /api.
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ConnectResult } from "../../shared/types.js";
import { now, slugify, httpErr } from "../config.js";
import { run, one } from "../db.js";
import { getAgent } from "../agents.js";
import { trace, YOU } from "../trace.js";
import { forgetConnectionMemories } from "../proposals.js";
import { you, body, sessionCookie } from "../api.js";
import { assertPublicUrl } from "../gateway/net.js";
import * as G from "../gateway/store.js";
import * as U from "../gateway/upstream.js";
import { BUILTIN_GOOGLE } from "../gateway/google.js";
import { callArgs, dropCalls } from "../gateway/gate.js";
import { catalogRoutes } from "./catalog.js";

const cid = (c: Context) => { const v = c.req.param("id") || ""; if (!G.CONN_ID.test(v) || !G.connRow(v)) throw httpErr(404, "No such connection"); return v; };
const tname = (c: Context) => { const v = c.req.param("tool") || ""; if (!G.TOOL_NAME.test(v)) throw httpErr(404, "No such tool"); return v; };
const session = (c: Context) => sessionCookie(c.req.header("cookie"));
const result = (id: string, authorize_url: string | null): ConnectResult => ({ connection: G.connectionDetail(id), authorize_url });
const secret = z.string().trim().min(1).max(4000);

// Connecting can fail upstream after the row exists; the row stays (state error) so you can fix the token and retry.
async function connectOrState(c: Context, id: string): Promise<ConnectResult> {
  try { return result(id, await U.connect(id, session(c) || "")); } catch (e) {
    if ((e as { status?: number }).status === 502) return result(id, null);
    throw e;
  }
}

export const gateway = new Hono()
  .get("/api/connections", you, (c) => c.json(G.listConnections()))
  .post("/api/connections", you, async (c) => {
    const b = await body(c, z.object({
      name: z.string().trim().min(1).max(40), id: z.string().regex(G.CONN_ID).optional(), url: z.string().trim().min(8).max(500), auth: z.enum(["oauth", "bearer", "none"]),
      untrusted: z.boolean().default(false), token: secret.optional(), client_id: z.string().trim().min(1).max(300).optional(), client_secret: secret.optional(),
    }));
    if (b.auth === "bearer" && !b.token) throw httpErr(400, "Paste the token");
    // The catalog suggests an id; otherwise it is the name's slug, cut to 12 (see CONN_ID).
    // The built-in Google connection has no URL to check; it needs your own OAuth client (Google offers no registration).
    const google = b.url === BUILTIN_GOOGLE;
    if (google && (b.auth !== "oauth" || !b.client_id || !b.client_secret)) throw httpErr(400, "Paste your Google OAuth client id and secret");
    const url = google ? BUILTIN_GOOGLE : (await assertPublicUrl(b.url)).href, id = google ? "google" : b.id ?? slugify(b.name).slice(0, 12).replace(/-+$/, "");
    if (!G.CONN_ID.test(id)) throw httpErr(400, "Use letters or numbers in the name");
    if (G.connRow(id)) throw httpErr(409, "A connection with that name exists");
    run("INSERT INTO connections(id,name,url,auth,untrusted,created_at) VALUES(?,?,?,?,?,?)", id, b.name, url, b.auth, b.untrusted ? 1 : 0, now());
    U.saveCredentials(id, b.auth === "bearer" ? { token: b.token } : b.auth === "oauth" ? { client_id: b.client_id, client_secret: b.client_secret } : {});
    trace(YOU, "connection.add", id, "ok", null, `${b.auth}${b.untrusted ? ", untrusted" : ""}`);
    return c.json(await connectOrState(c, id));
  })
  // Literal paths before /:id so "oauth" is never read as a connection id.
  .get("/api/connections/oauth/callback", async (c) => {
    // The authorization server's redirect is a cross-site navigation, so the SameSite=Strict session cookie is usually
    // absent here; then the web app finishes it with a same-origin POST (below) that carries the cookie.
    const q = c.req.query(), state = q.state || "", code = q.code || "";
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(state) || !code || code.length > 2000) return c.redirect("/#/connections?oauth=failed", 302);
    const s = session(c);
    if (!s) return c.redirect(`/#/connections?${new URLSearchParams({ oauth: "finish", state, code, ...(q.iss ? { iss: q.iss.slice(0, 500) } : {}) })}`, 302);
    try { return c.redirect(`/#/connections/${await U.finishOAuth(state, code, q.iss, s)}`, 302); } catch { return c.redirect("/#/connections?oauth=failed", 302); }
  })
  .post("/api/connections/oauth/finish", you, async (c) => {
    const b = await body(c, z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/), code: z.string().min(1).max(2000), iss: z.string().max(500).optional() }));
    return c.json(result(await U.finishOAuth(b.state, b.code, b.iss, session(c)), null));
  })
  .get("/api/connections/:id", you, (c) => c.json(G.connectionDetail(cid(c))))
  .patch("/api/connections/:id", you, async (c) => {
    const id = cid(c), b = await body(c, z.object({ untrusted: z.boolean().optional(), token: secret.optional() }));
    if (b.untrusted !== undefined) run("UPDATE connections SET untrusted=? WHERE id=?", b.untrusted ? 1 : 0, id);
    if (b.token) { if (G.connRow(id)!.auth !== "bearer") throw httpErr(400, "Only a bearer connection takes a token"); U.saveCredentials(id, { token: b.token }); await U.closeClient(id); }
    trace(YOU, "connection.update", id, "ok", null, [b.untrusted !== undefined ? `untrusted=${b.untrusted}` : "", b.token ? "new token" : ""].filter(Boolean).join(", ") || null);
    return c.json(b.token ? await connectOrState(c, id) : result(id, null));
  })
  .post("/api/connections/:id/connect", you, async (c) => c.json(await connectOrState(c, cid(c))))
  .post("/api/connections/:id/refresh", you, async (c) => { const id = cid(c); await U.refreshTools(id); return c.json(result(id, null)); })
  .post("/api/connections/:id/forget-memories", you, async (c) => c.json({ forgotten: await forgetConnectionMemories(cid(c)) }))
  .delete("/api/connections/:id", you, async (c) => {
    const id = cid(c);
    // ?memories=forget: disconnecting also forgets what agents saved from it (features §6).
    const forgotten = c.req.query("memories") === "forget" ? await forgetConnectionMemories(id) : 0;
    await U.forget(id);
    dropCalls(id);
    G.deleteConnection(id);
    trace(YOU, "connection.remove", id, "ok", null, forgotten ? `${forgotten} memories forgotten` : null);
    return c.json({ ok: true, forgotten });
  })
  .patch("/api/connections/:id/tools/:tool", you, async (c) => {
    const id = cid(c), t = tname(c), b = await body(c, z.object({ kind: z.enum(["read", "write"]).nullable().optional(), policy: z.enum(["allow", "ask", "block"]).nullable().optional() }));
    if (!one("SELECT 1 FROM conn_tools WHERE conn_id=? AND name=?", id, t)) throw httpErr(404, "No such tool");
    if (b.kind !== undefined) { run("UPDATE conn_tools SET override=? WHERE conn_id=? AND name=?", b.kind, id, t); trace(YOU, "tool.kind", `${id}/${t}`, "ok", null, b.kind ?? "inferred"); }
    if (b.policy !== undefined) { run("UPDATE conn_tools SET policy=? WHERE conn_id=? AND name=?", b.policy, id, t); trace(YOU, "tool.policy", `${id}/${t}`, "ok", null, b.policy ?? "default"); }
    return c.json(result(id, null));
  })
  .post("/api/connections/:id/tools/:tool/approve", you, (c) => { const id = cid(c); G.approveTool(id, tname(c), YOU); return c.json(result(id, null)); })
  .post("/api/connections/:id/tools/:tool/keep", you, (c) => { const id = cid(c); G.keepBlocked(id, tname(c), YOU); return c.json(result(id, null)); })

  // A held tool call's full arguments, decrypted for you only; proposals, the Pitcrew mirror and ntfy carry shapes.
  .get("/api/calls/:proposal", you, (c) => {
    const p = c.req.param("proposal") || "";
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(p)) throw httpErr(404, "No such call");
    return c.json(callArgs(p));
  })

  .put("/api/agents/:id/tools", you, async (c) => {
    const id = c.req.param("id") || "", b = await body(c, z.object({ tools: z.array(z.string().max(100)).max(500) }));
    if (!/^[A-Za-z0-9_:-]{1,120}$/.test(id) || !getAgent(id)) throw httpErr(404, "No such agent");
    G.setToolGrants(id, b.tools);
    trace(YOU, "agent.tools", id, "ok", null, `${b.tools.length} tools`);
    return c.json(getAgent(id)!);
  })
  // Mounted here rather than in server.ts: the catalog is part of the gateway screens.
  .route("/", catalogRoutes);
