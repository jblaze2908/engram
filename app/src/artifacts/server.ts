// The artifacts host (artifacts.example.com): serves published files, nothing else. Its own container sees only
// the vault's artifacts folder and the manifest + view key engram-app writes; no DB, no master key, no secrets in env.
//   /a/<id>   private: a view token from Engram (?t=, then a cookie for 12 h), else back to Engram to sign in
//   /s/<slug> public: anyone with the link
// Per request: one stat of the manifest (re-read only when it changed) and one file read.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Marked } from "marked";
import { ARTIFACTS_HOST, ID_RE, SLUG_RE, SHA_RE, EXT_RE, IMAGES, TEXT, checkToken, type Manifest } from "./shared.js";

export const HTML_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com data:; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
export const MD_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const IMG_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
const TEXT_CSP = "sandbox; default-src 'none'";

type Opts = { files: string; serve: string; engramHost: string };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Markdown is rendered here, with any raw HTML in it shown as text: a .md file never runs code.
const md = new Marked({ gfm: true, renderer: { html: ({ text }) => esc(text) } });
export function renderMarkdown(title: string, src: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--ink:#1d1d1f;--ink2:#5b5b60;--bg:#fff;--line:#e5e5ea;--code:#f5f5f7}
@media (prefers-color-scheme:dark){:root{--ink:#f2f2f4;--ink2:#a1a1a8;--bg:#111113;--line:#2c2c30;--code:#1c1c1f}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 80px}h1,h2,h3{line-height:1.25;margin:1.6em 0 .5em}h1{font-size:2em;margin-top:0}
a{color:inherit;text-underline-offset:3px}code,pre{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px}
code{padding:.1em .35em}pre{padding:14px 16px;overflow:auto}pre code{padding:0;background:none}blockquote{margin:0;padding-left:16px;border-left:3px solid var(--line);color:var(--ink2)}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}img{max-width:100%}hr{border:0;border-top:1px solid var(--line)}
</style></head><body><main>${md.parse(src, { async: false }) as string}</main></body></html>`;
}

export function createArtifactsServer(o: Opts) {
  let manifest: Manifest = { artifacts: {}, shares: {} }, mtime = -1, key: Buffer | null = null;
  const load = () => {
    const p = join(o.serve, "manifest.json");
    try {
      const m = statSync(p).mtimeMs;
      if (m !== mtime) { manifest = JSON.parse(readFileSync(p, "utf8")); mtime = m; key = readFileSync(join(o.serve, "view.key")); }
    } catch { /* no manifest yet: nothing is served */ }
    return manifest;
  };

  function send(res: ServerResponse, status: number, headers: Record<string, string>, body?: Buffer | string) {
    res.writeHead(status, { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Strict-Transport-Security": "max-age=31536000", ...headers });
    res.end(body);
  }
  const notFound = (res: ServerResponse) => send(res, 404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, "Not found");

  function serve(res: ServerResponse, id: string, url: URL, pub: boolean, head: boolean) {
    const a = load().artifacts[id];
    const want = url.searchParams.get("v");
    const v = a && (want ? (/^\d{1,6}$/.test(want) ? a.versions.find((x) => x.v === Number(want)) : undefined) : a.versions.at(-1));
    if (!a || !v || !SHA_RE.test(v.sha256) || !EXT_RE.test(v.ext)) return notFound(res);
    const file = join(o.files, `${v.sha256}.${v.ext}`);
    if (!existsSync(file)) return notFound(res);
    const body = readFileSync(file), ext = v.ext;
    const h: Record<string, string> = { "Cache-Control": pub ? "public, max-age=60" : "private, no-store" };
    const name = `${a.title.replace(/[^\w .-]+/g, "_").trim().slice(0, 80) || "file"}.${ext}`;
    const attach = () => ({ ...h, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(`${a.title.slice(0, 80)}.${ext}`)}`, "Content-Security-Policy": TEXT_CSP });
    let out: Record<string, string>, data: Buffer | string = body;
    if (url.searchParams.get("download") === "1") out = attach();
    else if (ext === "html" || ext === "htm") out = { ...h, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": HTML_CSP };
    else if (ext === "md" || ext === "markdown") { out = { ...h, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": MD_CSP }; data = renderMarkdown(a.title, body.toString("utf8")); }
    // No CSP sandbox on a PDF: it stops Chrome's viewer. Framing is still refused.
    else if (ext === "pdf") out = { ...h, "Content-Type": "application/pdf", "Content-Disposition": "inline", "X-Frame-Options": "DENY" };
    else if (IMAGES.has(ext)) out = { ...h, "Content-Type": v.mime, "Content-Security-Policy": IMG_CSP };
    else if (ext === "svg") out = { ...h, "Content-Type": "image/svg+xml", "Content-Security-Policy": SVG_CSP };
    else if (TEXT.has(ext)) out = { ...h, "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": TEXT_CSP };
    else out = attach();
    send(res, 200, out, head ? undefined : data);
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || "/", `https://${ARTIFACTS_HOST}`), head = req.method === "HEAD";
      if (req.method !== "GET" && !head) return send(res, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain" }, "Method not allowed");
      if (url.pathname === "/healthz") return send(res, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" }, '{"ok":true}');
      const [, kind, ref, extra] = url.pathname.split("/");
      if (extra !== undefined) return notFound(res);
      if (kind === "s" && SLUG_RE.test(ref || "")) { const id = load().shares[ref]; return id ? serve(res, id, url, true, head) : notFound(res); }
      if (kind !== "a" || !ID_RE.test(ref || "")) return notFound(res);
      const id = ref, keep = new URLSearchParams([...url.searchParams].filter(([k]) => k === "v" || k === "download")).toString(), clean = `/a/${id}${keep ? `?${keep}` : ""}`;
      load();
      const t = url.searchParams.get("t");
      if (t !== null) {
        const exp = key && checkToken(key, t, id);
        if (!exp) return send(res, 302, { Location: `https://${o.engramHost}/artifacts/${id}/open${url.searchParams.get("v") ? `?v=${url.searchParams.get("v")}` : ""}`, "Cache-Control": "no-store" });
        // Host-only, this artifact's path only: one page can never present another's view.
        return send(res, 302, { Location: clean, "Cache-Control": "no-store",
          "Set-Cookie": `v=${t}; Path=/a/${id}; Max-Age=${Math.floor((exp - Date.now()) / 1000)}; HttpOnly; Secure; SameSite=Lax` });
      }
      const cookie = (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === "v")?.[1];
      if (!key || !checkToken(key, cookie, id))
        return send(res, 302, { Location: `https://${o.engramHost}/artifacts/${id}/open${url.searchParams.get("v") ? `?v=${url.searchParams.get("v")}` : ""}`, "Cache-Control": "no-store" });
      return serve(res, id, url, false, head);
    } catch (e) {
      console.error(new Date().toISOString(), "artifacts:", (e as Error).message);
      return send(res, 500, { "Content-Type": "text/plain" }, "Something went wrong");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.ARTIFACTS_PORT || 8345);
  createArtifactsServer({
    files: process.env.ENGRAM_ARTIFACTS_FILES || "/srv/engram/vault/artifacts/files",
    serve: process.env.ENGRAM_ARTIFACTS_SERVE || "/srv/engram/artifacts-serve",
    engramHost: process.env.ENGRAM_HOST || "engram.example.com",
  }).listen(port, () => console.log(`engram artifacts on :${port} (${ARTIFACTS_HOST})`));
}
