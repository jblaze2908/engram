// Upstream credentials: AES-256-GCM under master.key, one row per secret. Values never reach logs, traces or the API.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, now } from "../config.js";
import { db, one, run } from "../db.js";

db.exec("CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, blob TEXT NOT NULL, updated_at INTEGER NOT NULL)");

// Read once, on first use: boot() creates the key before anything here runs.
let key: Buffer | null = null;
const master = () => (key ??= Buffer.from(readFileSync(join(ROOT, "master.key"), "utf8").trim(), "base64url"));

export function putSecret(name: string, value: string) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", master(), iv);
  const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
  const blob = [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
  run("INSERT INTO secrets(name,blob,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blob=excluded.blob, updated_at=excluded.updated_at", name, blob, now());
}

export function getSecret(name: string): string | null {
  const row = one<{ blob: string }>("SELECT blob FROM secrets WHERE name=?", name);
  if (!row) return null;
  const [iv, tag, data] = row.blob.split(".").map((s) => Buffer.from(s, "base64url"));
  const d = createDecipheriv("aes-256-gcm", master(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

export const putJson = (name: string, v: unknown) => putSecret(name, JSON.stringify(v));
export const getJson = <T>(name: string): T | undefined => { const s = getSecret(name); return s ? (JSON.parse(s) as T) : undefined; };
export const dropSecret = (name: string) => run("DELETE FROM secrets WHERE name=?", name);
// Connection ids are slugs (no "%" or "_"), so the prefix match can't reach another connection's secrets.
export const dropSecrets = (prefix: string) => run("DELETE FROM secrets WHERE name LIKE ?", `${prefix}%`);
