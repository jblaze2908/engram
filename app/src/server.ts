// Engram's one process: the web app (static, SPA fallback), /api for your session, /mcp for agents, /oauth for remote MCP clients, /healthz.
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PORT, ROOT, type HttpError } from "./config.js";
import { ensureVault } from "./vault.js";
import { scan, startScanner } from "./index.js";
import { ensureMasterKey, ensureSetupToken } from "./auth.js";
import { api } from "./api.js";
import { mcpRoute } from "./mcp.js";
import { link } from "./routes/link.js";
import { oauth } from "./routes/oauth.js";
import { startJobs } from "./jobs.js";
import { startVaultSync } from "./vaultsync.js";
import { gateway } from "./routes/gateway.js";
import { leftovers } from "./routes/leftovers.js";
import { startGateway } from "./gateway/upstream.js";
import { PRIVACY_HTML } from "./privacy.js";
import { writeManifest } from "./artifacts/app.js";

const WEB = new URL("../web/", import.meta.url).pathname;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

// The built web app is small; held in memory at boot so a page load never touches disk.
const assets = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
function loadWeb() {
  if (!existsSync(WEB)) return;
  for (const f of readdirSync(WEB, { recursive: true }) as string[]) {
    const p = join(WEB, f);
    if (statSync(p).isFile()) assets.set("/" + f.split("\\").join("/"), { body: new Uint8Array(readFileSync(p)), type: TYPES[extname(f)] || "application/octet-stream" });
  }
}

export const app = new Hono();
app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Strict-Transport-Security", "max-age=31536000");
});
app.onError((e: HttpError, c) => {
  const status = e.status || 500;
  if (status === 500) console.error(new Date().toISOString(), c.req.method, c.req.path, e.stack);
  return c.json({ error: status === 500 ? "Something went wrong" : e.message }, status as ContentfulStatusCode);
});
app.get("/healthz", (c) => c.json({ ok: true }));
app.get("/privacy", (c) => c.html(PRIVACY_HTML, 200, { "Cache-Control": "public, max-age=3600" }));
app.all("/mcp", mcpRoute);
app.route("/", link);
app.route("/", oauth);
app.route("/", api);
app.route("/", gateway);
app.route("/", leftovers);
app.get("*", (c) => {
  const path = c.req.path;
  if (path.startsWith("/api/") || path === "/api") return c.json({ error: "Not found" }, 404);
  const a = assets.get(path) || (extname(path) ? undefined : assets.get("/index.html"));
  if (!a) return c.text(assets.size ? "Not found" : "Engram web app is not built", 404);
  return c.body(a.body, 200, { "Content-Type": a.type, "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
});

export async function boot() {
  ensureMasterKey();
  ensureSetupToken();
  if (await ensureVault()) console.log(`new vault at ${ROOT}/vault`);
  console.log(`indexed ${scan(true)} files`);
  startScanner();
  startJobs();
  startVaultSync();
  startGateway();
  writeManifest();
  loadWeb();
}

export function listen(port = PORT, host?: string): Promise<Server> {
  const s = createServer(getRequestListener(app.fetch));
  return new Promise((ok) => s.listen(port, host, () => ok(s)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await boot();
  await listen();
  console.log(`engram on :${PORT} (root ${ROOT})`);
}
