// Bearer routes outside /mcp: the Pitcrew link API (link tokens only, docs/milestones.md M3) and an agent's sync
// bundle (M5). Inbox polls aren't traced (one a minute); every decision, member and import is.
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Agent, ArtifactKind, Decision, LinkInbox } from "../../shared/types.js";
import { HOST, now, httpErr, type HttpError } from "../config.js";
import { one, all } from "../db.js";
import { authenticate } from "../agents.js";
import { decide, toProposal } from "../proposals.js";
import { digest } from "../digest.js";
import { trace } from "../trace.js";
import { memberOf, upsertMember } from "../link/members.js";
import { importArtifact, importMemories } from "../link/imports.js";
import { syncBundle } from "../link/sync.js";

type Env = { Variables: { agent: Agent } };
const PITCREW = { id: null, name: "you (in Pitcrew)" };
const ARTIFACT_KINDS: [ArtifactKind, ...ArtifactKind[]] = ["receipt", "statement", "report", "screenshot", "plan", "document"];
const PID = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
const ID = /^[A-Za-z0-9_:-]{1,120}$/;
const at = z.number().int().nonnegative().optional();

function sameHost(origin: string, host: string | undefined) {
  try { const h = new URL(origin).host; return h === host || h === HOST; } catch { return false; }
}
// link: true for /link; any live agent for its own sync. A browser page can't borrow a token, but refuse foreign Origins anyway.
const bearer = (link: boolean) => createMiddleware<Env>(async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && !sameHost(origin, c.req.header("host"))) throw httpErr(403, "Cross-site request refused");
  const header = c.req.header("authorization"), a = authenticate(header);
  if (!a) {
    if (header) trace({ id: null, name: "unknown" }, link ? "link" : "sync", "auth", "refused", null, "bad or revoked token");
    c.header("WWW-Authenticate", 'Bearer realm="engram"');
    throw httpErr(401, "Missing or invalid token");
  }
  if (link && !a.link) { trace({ id: a.id, name: a.name }, "link", "auth", "refused", null, "not a link token"); throw httpErr(403, "Only the Pitcrew link token can use this"); }
  c.set("agent", a);
  await next();
});

async function body<S extends z.ZodType>(c: Context, schema: S, max = 1 << 20): Promise<z.output<S>> {
  if (Number(c.req.header("content-length") || 0) > max) throw httpErr(413, "Too large");
  let v: unknown;
  try { const t = await c.req.text(); if (t.length > max) throw httpErr(413, "Too large"); v = t ? JSON.parse(t) : {}; } catch (e) { throw (e as HttpError).status ? e : httpErr(400, "Bad JSON"); }
  const r = schema.safeParse(v);
  if (!r.success) throw httpErr(400, `Invalid ${r.error.issues[0]?.path.join(".") || "request"}`);
  return r.data;
}

// Private proposals never leave Engram, so Pitcrew can neither list nor decide them.
const mirrored = () => all("SELECT * FROM proposals WHERE status='open' AND scope!='private' ORDER BY held DESC, created_at DESC LIMIT 500").map(toProposal);

export const link = new Hono<Env>()
  .use("/link/*", bearer(true))
  .get("/link/inbox", (c) => c.json({ proposals: mirrored(), at: now() } satisfies LinkInbox))
  .post("/link/inbox/:id", async (c) => {
    const id = c.req.param("id"), b = await body(c, z.object({ decision: z.enum(["accept", "keep", "reject", "reject_and_forget_source"]) }));
    if (!ID.test(id) || !one("SELECT 1 FROM proposals WHERE id=? AND scope!='private'", id)) throw httpErr(404, "No such proposal");
    return c.json(await decide(id, b.decision as Decision, PITCREW));
  })
  .get("/link/digest", (c) => c.json(digest()))
  .post("/link/members", async (c) => {
    const b = await body(c, z.object({
      pitcrew_id: PID, name: z.string().trim().min(1).max(60),
      hue: z.string().regex(/^[#a-zA-Z0-9(),.% -]{1,40}$/).nullable().optional(), area: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/).nullable().optional(),
    }));
    return c.json(upsertMember(c.get("agent"), b));
  })
  .post("/link/import/memories", async (c) => {
    const b = await body(c, z.object({ pitcrew_id: PID, items: z.array(z.object({ text: z.string().trim().min(1).max(4000), created_at: at })).min(1).max(500) }), 4 << 20);
    return c.json(await importMemories(c.get("agent"), memberOf(b.pitcrew_id), b.items));
  })
  .post("/link/import/artifacts", async (c) => {
    const b = await body(c, z.object({
      pitcrew_id: PID, title: z.string().trim().min(1).max(200), kind: z.enum(ARTIFACT_KINDS), mime: z.string().max(100),
      content_base64: z.string().min(1).max(8_400_000).regex(/^[A-Za-z0-9+/=\r\n]+$/), created_at: at,
    }), 9 << 20);
    return c.json(await importArtifact(c.get("agent"), memberOf(b.pitcrew_id), b));
  })
  .get("/link/sync", (c) => {
    const pid = PID.safeParse(c.req.query("pitcrew_id"));
    if (!pid.success) throw httpErr(400, "Invalid pitcrew_id");
    return c.json(syncBundle(memberOf(pid.data).agent));
  })
  .all("/link/*", (c) => c.json({ error: "Not found" }, 404));

link.onError((e: HttpError, c) => {
  const status = e.status || 500;
  if (status === 500) console.error(new Date().toISOString(), c.req.method, c.req.path, e.stack);
  return c.json({ error: status === 500 ? "Something went wrong" : e.message }, status as ContentfulStatusCode);
});
