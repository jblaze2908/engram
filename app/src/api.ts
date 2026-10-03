// The web API for your browser session: every /api route in docs/build.md. Errors are { error } with a short message.
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Scope, Decision, MemoryStatus, ArtifactVersion } from "../shared/types.js";
import { SCOPES } from "../shared/types.js";
import { findArtifacts } from "./artifacts/list.js";
import { urlOf } from "./artifacts/shares.js";
import { HOST, VAULT, httpErr, type HttpError } from "./config.js";
import * as A from "./auth.js";
import * as G from "./agents.js";
import * as P from "./proposals.js";
import * as V from "./views.js";
import * as S from "./store.js";
import { search } from "./search.js";
import { listTrace } from "./trace.js";
import { digest, digestWeeks, WEEK_RE } from "./digest.js";
import { createLinkAgent } from "./link/members.js";
import * as AR from "./artifacts/app.js";
import { ARTIFACTS_HOST } from "./artifacts/shared.js";
import { YOU } from "./trace.js";

const COOKIE = "eg_s";
const cookie = (header: string | undefined) => (header || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === COOKIE)?.[1];
const authed = (c: Context) => A.sessionValid(cookie(c.req.header("cookie")));
const sameOrigin = (origin: string | undefined, host: string | undefined) => {
  if (!origin) return true;
  try { const h = new URL(origin).host; return h === host || h === HOST; } catch { return false; }
};

// Runs once a route matched: mutations need the same origin and x-engram: 1 (a cross-site form can't set it), then a session.
const guard = (open: boolean) => createMiddleware(async (c, next) => {
  if (c.req.method !== "GET" && (!sameOrigin(c.req.header("origin"), c.req.header("host")) || c.req.header("x-engram") !== "1")) throw httpErr(403, "Cross-site request refused");
  if (!open && !authed(c)) throw httpErr(401, "Sign in");
  await next();
});
const anyone = guard(true), you = guard(false);

async function body<S extends z.ZodType>(c: Context, schema: S, max = 1 << 20): Promise<z.output<S>> {
  if (Number(c.req.header("content-length") || 0) > max) throw httpErr(413, "Too large");
  let v: unknown;
  try { const t = await c.req.text(); if (t.length > max) throw httpErr(413, "Too large"); v = t ? JSON.parse(t) : {}; } catch (e) { throw (e as HttpError).status ? e : httpErr(400, "Bad JSON"); }
  const r = schema.safeParse(v);
  if (!r.success) throw httpErr(400, `Invalid ${r.error.issues[0]?.path.join(".") || "request"}`);
  return r.data;
}
const q = (c: Context, k: string, re: RegExp) => { const v = c.req.query(k); if (v === undefined || v === "") return undefined; if (!re.test(v)) throw httpErr(400, `Invalid ${k}`); return v; };
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/, DAYRE = /^\d{4}-\d{2}-\d{2}$/, WORD = /^[a-z_]{1,30}$/;
const ID = /^[A-Za-z0-9_:-]{1,120}$/;
const id = (c: Context) => { const v = c.req.param("id") || ""; if (!ID.test(v)) throw httpErr(404, "Not found"); return v; };

const scope = z.enum(SCOPES as [Scope, ...Scope[]]);
const grant = z.object({ scope, read: z.boolean(), write: z.enum(["none", "propose"]) });
const name = z.string().trim().min(1).max(60);
const target = z.enum(V.TARGETS as [typeof V.TARGETS[number], ...typeof V.TARGETS]);
const login = (c: Context) => c.header("Set-Cookie", `${COOKIE}=${A.newSession()}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Strict`);
const MEMORY_STATUS: (MemoryStatus | "all")[] = ["active", "superseded", "held", "forgotten", "all"];

export const api = new Hono()
  .get("/api/session", anyone, (c) => c.json({ setup: A.setupDone(), authed: authed(c) }))
  .post("/api/setup", anyone, async (c) => {
    const b = await body(c, z.object({ token: z.string().max(200), password: z.string().max(1024) }));
    A.setupPassword(b.token, b.password); login(c); return c.json({ ok: true });
  })
  .post("/api/login", anyone, async (c) => { const b = await body(c, z.object({ password: z.string().max(1024) })); A.checkPassword(b.password); login(c); return c.json({ ok: true }); })
  .post("/api/logout", you, (c) => { A.endSession(cookie(c.req.header("cookie"))); c.header("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`); return c.json({ ok: true }); })

  .get("/api/status", you, (c) => c.json(V.status()))
  .get("/api/inbox", you, (c) => c.json(P.listProposals("open")))
  .post("/api/inbox/:id", you, async (c) => {
    const b = await body(c, z.object({ decision: z.enum(["accept", "keep", "reject", "reject_and_forget_source"]) }));
    return c.json(await P.decide(id(c), b.decision as Decision));
  })
  .get("/api/context", you, (c) => c.json(V.contextHome()))
  .get("/api/areas/:slug", you, (c) => { const s = c.req.param("slug"); if (!SLUG.test(s)) throw httpErr(404, "No such area"); return c.json(V.areaView(s)); })

  .get("/api/entities", you, (c) => c.json(S.listEntities({ kind: q(c, "kind", WORD) })))
  .get("/api/entities/:id", you, (c) => { const v = V.entityView(id(c)); if (!v) throw httpErr(404, "No such entity"); return c.json(v); })

  .get("/api/memories", you, (c) => {
    const status = q(c, "status", WORD), area = q(c, "area", SLUG), text = c.req.query("q")?.slice(0, 200);
    if (status && !MEMORY_STATUS.includes(status as MemoryStatus)) throw httpErr(400, "Invalid status");
    // Batch read by id (the Artifacts page): any status, at most 100.
    const batch = q(c, "ids", /^[A-Za-z0-9_:-]{1,120}(,[A-Za-z0-9_:-]{1,120}){0,99}$/);
    if (batch) return c.json(S.listMemories({ status: "all", ids: [...new Set(batch.split(","))] }));
    const ids = text ? search({ query: text, kind: "memory", area, limit: 50 }).hits.map((h) => h.id) : undefined;
    return c.json(S.listMemories({ status: status || "active", area, ids }));
  })
  .post("/api/memories", you, async (c) => {
    const b = await body(c, z.object({ text: z.string().trim().min(1).max(4000), area: z.string().regex(SLUG), scope, valid_until: z.string().regex(DAYRE).nullable().optional() }));
    return c.json(await P.addMemory(b));
  })
  .get("/api/memories/:id", you, (c) => { const m = S.memoryById(id(c)); if (!m) throw httpErr(404, "No such memory"); return c.json(m); })
  .post("/api/memories/:id/forget", you, async (c) => c.json(await P.forgetMemory(id(c))))
  .get("/api/memories/:id/provenance", you, (c) => c.json(V.provenance(id(c))))

  .get("/api/artifacts", you, (c) => {
    const f = z.object({
      q: z.string().max(100).optional(), by: z.string().regex(/^[\w-]{1,40}$/).optional(), status: z.enum(["public", "waiting", "private"]).optional(),
      kind: z.string().regex(WORD).optional(), type: z.enum(["page", "pdf", "image", "other"]).optional(), scope,
      area: z.string().regex(SLUG).optional(), cursor: z.string().regex(/^\d{1,15}:[\w-]{1,100}$/).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
    }).partial().safeParse(c.req.query());
    if (!f.success) throw httpErr(400, "Invalid filter");
    const [at, cid] = f.data.cursor?.split(/:(.*)/) ?? [];
    return c.json(findArtifacts({ ...f.data, cursor: f.data.cursor ? { at: Number(at), id: cid } : undefined }));
  })
  .get("/api/artifacts/:id", you, (c) => { const d = S.docById(id(c)); if (!d || d.kind !== "artifact") throw httpErr(404, "No such artifact"); return c.json(S.artifacts([d])[0]); })
  .get("/api/artifacts/:id/file", you, (c) => {
    // Always a download here (pages open on the artifacts host); the path comes from the index's sha and ext, never the client.
    const d = S.docById(id(c)), a = d && d.kind === "artifact" ? S.docData<{ title: string; versions: ArtifactVersion[] }>(d) : null;
    const want = q(c, "v", /^\d{1,6}$/), v = want ? a?.versions?.find((x) => x.v === Number(want)) : a?.versions?.at(-1);
    if (!a || !v || !/^[a-f0-9]{64}$/.test(v.sha256) || !/^[a-z0-9]{1,8}$/.test(v.ext)) throw httpErr(404, "No kept file");
    const p = join(VAULT, "artifacts", "files", `${v.sha256}.${v.ext}`);
    if (!existsSync(p)) throw httpErr(404, "No kept file");
    const name = `${a.title.replace(/[^\w .-]+/g, "_").slice(0, 80) || "file"}.${v.ext}`;
    return c.body(readFileSync(p), 200, {
      "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=3600",
    });
  })
  // Upload from the web app: you publish, so it's accepted directly; any scope, including private.
  .post("/api/artifacts", you, async (c) => {
    const b = await body(c, z.object({
      title: z.string().trim().min(1).max(200), filename: z.string().trim().min(1).max(200), content_base64: z.string().min(1).max(14_000_000),
      id: z.string().regex(ID).nullable().optional(), description: z.string().max(2000).optional(), area: z.string().regex(SLUG).optional(), scope: scope.optional(),
      kind: z.string().regex(/^[a-z_]{1,30}$/).optional(), public: z.boolean().optional(),
    }), 14 << 20);
    return c.json(await AR.publish({ agent: null, actor: YOU, source: { kind: "you", label: "Uploaded in Engram", agent: null, ref: null, at: Date.now() } }, b));
  })
  .post("/api/artifacts/:id/share", you, (c) => c.json({ public_url: AR.share(id(c), YOU) }))
  .delete("/api/artifacts/:id/share", you, (c) => { AR.unshare(id(c), YOU); return c.json({ ok: true }); })
  .post("/api/artifacts/:id/reset-link", you, (c) => c.json({ url: AR.resetLink(id(c), YOU) }))
  // Opening a private artifact: your session mints a 12 h view token for the artifacts host. The session cookie is
  // SameSite=Strict, so a link followed from another site arrives without it; one same-site reload brings it.
  .get("/artifacts/:id/open", (c) => {
    const aid = id(c), v = q(c, "v", /^\d{1,6}$/), self = `/artifacts/${encodeURIComponent(aid)}/open${v ? `?v=${v}` : ""}`;
    if (!authed(c)) {
      if (c.req.query("r") !== "1") return c.html(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${self}${v ? "&" : "?"}r=1"><title>Opening…</title>`);
      return c.redirect(`/?next=${encodeURIComponent(self)}`, 302);
    }
    const d = S.docById(aid);
    if (!d || d.kind !== "artifact" || d.status !== "active") throw httpErr(404, "No such artifact");
    return c.redirect(`${urlOf(aid)}?t=${AR.viewToken(aid)}${v ? `&v=${v}` : ""}`, 302);
  })

  .get("/api/journal", you, (c) => c.json(V.journalView(q(c, "day", DAYRE))))
  .get("/api/profile", you, (c) => c.json({ files: S.profileFiles(), compiled: V.compiledForUi() }))
  .get("/api/skills", you, (c) => c.json(S.skills()))
  .get("/api/skills/:name", you, (c) => { const n = c.req.param("name"); const [s] = SLUG.test(n) ? S.skills([n]) : []; if (!s) throw httpErr(404, "No such skill"); return c.json(s); })

  .get("/api/agents", you, (c) => c.json(G.listAgents()))
  .post("/api/agents", you, async (c) => {
    const b = await body(c, z.object({ name, kind: z.enum(["pitcrew", "mac", "other"]), profile: target, grants: z.array(grant).max(5).default([]) }));
    return c.json(G.createAgent(b));
  })
  .patch("/api/agents/:id", you, async (c) => {
    const b = await body(c, z.object({ name: name.optional(), grants: z.array(grant).max(5).optional(), skills: z.array(z.string().regex(SLUG)).max(100).optional(), auto_accept: z.boolean().optional() }));
    return c.json(G.updateAgent(id(c), b));
  })
  .post("/api/agents/:id/token", you, (c) => c.json(G.rotateToken(id(c))))
  .post("/api/agents/:id/revoke", you, (c) => c.json(G.revokeAgent(id(c))))
  .post("/api/link", you, (c) => c.json(createLinkAgent()))
  .get("/api/digest", you, (c) => c.json(digest(q(c, "week", WEEK_RE))))
  .get("/api/digest/weeks", you, (c) => c.json(digestWeeks()))

  .get("/api/trace", you, (c) => c.json(listTrace({ who: q(c, "who", /^[\w .:-]{1,80}$/), result: q(c, "result", WORD), day: q(c, "day", DAYRE) })));

api.notFound((c) => c.json({ error: "Not found" }, 404));
api.onError((e: HttpError, c) => {
  const status = e.status || 500;
  if (status === 500) console.error(new Date().toISOString(), c.req.method, c.req.path, e.stack);
  return c.json({ error: status === 500 ? "Something went wrong" : e.message }, status as ContentfulStatusCode);
});

// Shared with routes/*.ts so every /api route uses the same guard, body limits and session cookie.
export { you, body, cookie as sessionCookie };
