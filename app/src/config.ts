// Where Engram keeps its state, and the small helpers every module shares.
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";

export const ROOT = resolve(process.env.ENGRAM_ROOT || "./.data");
export const VAULT = join(ROOT, "vault");
export const PENDING = join(ROOT, "pending");
export const PORT = Number(process.env.PORT || 8340);
// Public hostname of this instance; OAuth issuer, MCP origin checks and links build on it.
export const HOST = process.env.ENGRAM_HOST || "localhost";
mkdirSync(ROOT, { recursive: true, mode: 0o700 });
mkdirSync(PENDING, { recursive: true, mode: 0o700 });

export const now = () => Date.now();
export const uid = (p: string) => `${p}_${randomBytes(9).toString("base64url")}`;
export const DAY = 86400000;
export const startOfDay = (t = now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
// Dedupe and the recall check compare claims by this, so case, spacing and a trailing full stop don't make a new memory.
export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");

export type HttpError = Error & { status?: number };
export function httpErr(status: number, message: string): HttpError { const e: HttpError = new Error(message); e.status = status; return e; }
