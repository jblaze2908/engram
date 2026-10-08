// Shared by engram-app and the artifacts server: file types, the view token, URLs and the manifest shape. No side
// effects and no imports beyond node builtins, so the serving container never loads the app's config, DB or keys.
import { createHmac, timingSafeEqual } from "node:crypto";

// A separate origin, so a published page can never read Engram's cookies.
export const ARTIFACTS_HOST = process.env.ENGRAM_ARTIFACTS_HOST || `artifacts.${process.env.ENGRAM_HOST || "localhost"}`;
export const MAX_FILE = 10 << 20;
export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const SHA_RE = /^[a-f0-9]{64}$/;
export const EXT_RE = /^[a-z0-9]{1,8}$/;
export const SLUG_RE = /^[A-Za-z0-9_-]{22}$/;
export const VIEW_MS = 12 * 3600000;

export const MIME: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  txt: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", xml: "application/xml",
  yaml: "text/yaml", yml: "text/yaml", log: "text/plain", js: "text/javascript", ts: "text/plain", py: "text/x-python", sh: "text/x-shellscript",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", ics: "text/calendar",
};
// Shown as plain text, never rendered: code, data and anything a browser might otherwise interpret.
export const TEXT = new Set(["txt", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "js", "ts", "py", "sh", "ics"]);
export const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function extOf(filename: string) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  const ext = m ? m[1].toLowerCase() : "bin";
  return EXT_RE.test(ext) ? ext : "bin";
}
export const mimeOf = (ext: string) => MIME[ext] || "application/octet-stream";

export type ManifestVersion = { v: number; sha256: string; ext: string; mime: string };
/** links: slug → the artifact it opens and whether anyone may (else only you, through Engram). */
export type Manifest = { artifacts: Record<string, { title: string; versions: ManifestVersion[] }>; links: Record<string, { id: string; public: boolean }> };

// The private view token: base64url("slug.exp") + "." + HMAC-SHA256 over that part with view.key.
const mac = (key: Buffer, part: string) => createHmac("sha256", key).update(part).digest("base64url");
export function mintToken(key: Buffer, id: string, exp: number) {
  const part = Buffer.from(`${id}.${exp}`).toString("base64url");
  return `${part}.${mac(key, part)}`;
}
/** The expiry when the token is genuine, for this artifact and not past it; else null. */
export function checkToken(key: Buffer, token: string | undefined, id: string, at = Date.now()): number | null {
  if (!token || token.length > 400) return null;
  const [part, sig, extra] = token.split(".");
  if (!part || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(key, part)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [tid, exp] = Buffer.from(part, "base64url").toString("utf8").split(".");
  const e = Number(exp);
  return tid === id && Number.isFinite(e) && e > at && e <= at + VIEW_MS ? e : null;
}

export type Version = ManifestVersion & { size: number | null; at: number; by: string };
/** An entry's versions, oldest first. An entry from before versions (top-level sha256/ext/mime) reads as version 1. */
export function versionsOf(fm: Record<string, any>, at: number, by: string): Version[] {
  const ok = (x: any) => x && SHA_RE.test(x.sha256) && EXT_RE.test(x.ext);
  const one = (x: any, v: number): Version => ({ v, sha256: x.sha256, ext: x.ext, mime: typeof x.mime === "string" && x.mime ? x.mime.slice(0, 120) : mimeOf(x.ext),
    size: typeof x.size === "number" ? x.size : null, at: typeof x.at === "number" ? x.at : at, by: typeof x.by === "string" ? x.by.slice(0, 120) : by });
  if (Array.isArray(fm.versions)) return fm.versions.filter(ok).map((x: any, i: number) => one(x, Number.isInteger(x.v) && x.v > 0 ? x.v : i + 1));
  return ok({ sha256: fm.sha256, ext: EXT_RE.test(fm.ext) ? fm.ext : "bin" }) ? [one({ ...fm, ext: EXT_RE.test(fm.ext) ? fm.ext : "bin" }, 1)] : [];
}
