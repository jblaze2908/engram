// SQLite: the derived index of the vault (docs + FTS5) and the state that isn't knowledge (agents, proposals, trace).
// WAL + synchronous=NORMAL: a power cut can lose the last commits, never corrupt the file, and the index rebuilds anyway.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import { ROOT } from "./config.js";

export const db = new DatabaseSync(join(ROOT, "engram.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, profile TEXT NOT NULL, hue TEXT, skills TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS grants (
  agent_id TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('personal','finance','health')), read INTEGER NOT NULL,
  write TEXT NOT NULL CHECK (write IN ('none','propose')), PRIMARY KEY (agent_id, scope));
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT, title TEXT NOT NULL, scope TEXT NOT NULL, area TEXT NOT NULL,
  data TEXT NOT NULL, norm TEXT, source TEXT NOT NULL, source_ref TEXT, reasons TEXT NOT NULL, held INTEGER NOT NULL, replaces TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status, created_at);
-- Append-only: nothing updates or deletes trace rows except the age prune in the index scan.
CREATE TABLE IF NOT EXISTS trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT NOT NULL, agent TEXT, action TEXT NOT NULL,
  target TEXT NOT NULL, scope TEXT, result TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS trace_at ON trace(at);
CREATE INDEX IF NOT EXISTS trace_agent ON trace(agent, at);
-- One row per (memory, agent): read counts for the UI and last_at for the 24 h recall check, without a growing log.
CREATE TABLE IF NOT EXISTS reads (
  memory_id TEXT NOT NULL, agent TEXT NOT NULL, n INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (memory_id, agent));
CREATE INDEX IF NOT EXISTS reads_agent ON reads(agent, last_at);
-- Derived from the vault; rebuilt at boot. data is the parsed record as the API returns it.
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '', project TEXT, scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', norm TEXT,
  source_ref TEXT, at INTEGER NOT NULL, valid_until TEXT, data TEXT NOT NULL, mtime INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind, area, status, at);
CREATE INDEX IF NOT EXISTS docs_norm ON docs(norm);
CREATE INDEX IF NOT EXISTS docs_ref ON docs(source_ref);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2');
`);

export type Row = Record<string, any>;
type Param = SQLInputValue | undefined;
export const one = <T = Row>(sql: string, ...a: Param[]) => db.prepare(sql).get(...(a as SQLInputValue[])) as T | undefined;
export const all = <T = Row>(sql: string, ...a: Param[]) => db.prepare(sql).all(...(a as SQLInputValue[])) as T[];
export const run = (sql: string, ...a: Param[]) => db.prepare(sql).run(...(a as SQLInputValue[]));
export const json = <T = any>(s: unknown, d: any = null): T => { try { return JSON.parse(s as string); } catch { return d; } };
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
// "?,?,?" for an IN list; values still go through parameters.
export const marks = (n: number) => Array(n).fill("?").join(",");

export function getSetting(k: string): string | null { return one<{ value: string }>("SELECT value FROM settings WHERE key=?", k)?.value ?? null; }
export const setSetting = (k: string, v: unknown) => run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, String(v));
