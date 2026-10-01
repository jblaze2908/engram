// Routes for the M1 leftovers (docs/milestones.md). Cookie session + CSRF header, like the rest of /api.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { httpErr } from "../config.js";
import { you, body } from "../api.js";
import * as L from "../leftovers.js";

const ID = /^[A-Za-z0-9_:-]{1,120}$/;
const id = (c: Context) => { const v = c.req.param("id") || ""; if (!ID.test(v)) throw httpErr(404, "Not found"); return v; };

export const leftovers = new Hono()
  .post("/api/memories/:id/edit", you, async (c) => {
    const b = await body(c, z.object({ text: z.string().trim().min(1).max(4000), valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }));
    return c.json(await L.editMemory(id(c), b));
  })
  .post("/api/memories/:id/wrong", you, async (c) => {
    const b = await body(c, z.object({ reason: z.string().trim().min(1).max(200) }));
    return c.json(await L.markWrong(id(c), b.reason));
  })
  .post("/api/artifacts/:id/forget", you, async (c) => c.json(await L.forgetArtifact(id(c))))
  .post("/api/inbox/:id/link-profile", you, async (c) => {
    const b = await body(c, z.object({ file: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/) }));
    return c.json(await L.linkSkillToProfile(id(c), b.file));
  })
  .post("/api/inbox/:id/undo", you, async (c) => c.json(await L.undoAccept(id(c))));
