// /api/catalog: search the catalog and probe a server's sign-in. Cookie session + CSRF header, like the rest of /api.
import { Hono } from "hono";
import { z } from "zod";
import { you, body } from "../api.js";
import { catalog, probe } from "../gateway/catalog.js";

export const catalogRoutes = new Hono()
  .get("/api/catalog", you, async (c) => c.json(await catalog((c.req.query("q") || "").slice(0, 200), c.req.query("community") === "1")))
  .post("/api/catalog/probe", you, async (c) => {
    const b = await body(c, z.object({ url: z.string().trim().min(8).max(500) }));
    return c.json(await probe(b.url));
  });
