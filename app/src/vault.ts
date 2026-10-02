// The vault: markdown files with YAML frontmatter in a git repo. Source of truth; every write is one commit.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parse, stringify } from "yaml";
import { VAULT, httpErr } from "./config.js";

const exec = promisify(execFile);
// -c overrides beat a global gpgsign or hooksPath on the host, which would break or slow every commit.
const GIT = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=off"];
const git = (...args: string[]) => exec("git", [...GIT, ...args], { cwd: VAULT, timeout: 20000, maxBuffer: 1 << 20 });

export type Doc = { fm: Record<string, any>; body: string };

export function parseDoc(src: string): Doc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { fm: {}, body: src.trim() };
  let fm: unknown;
  try { fm = parse(m[1], { maxAliasCount: 10 }); } catch { fm = {}; }
  return { fm: fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, any>) : {}, body: m[2].trim() };
}
export const renderDoc = (d: Doc) => `---\n${stringify(d.fm, { lineWidth: 0 }).trimEnd()}\n---\n${d.body ? d.body.trim() + "\n" : ""}`;

// rel is built by callers from generated ids and validated slugs; this is the last check that it stays inside the vault.
export function abs(rel: string) {
  const p = join(VAULT, rel), r = relative(VAULT, p);
  if (!r || r.startsWith("..") || r.split(sep)[0] === ".git") throw httpErr(400, "Bad path");
  return p;
}
export const readDoc = (rel: string): Doc | null => { const p = abs(rel); return existsSync(p) ? parseDoc(readFileSync(p, "utf8")) : null; };
export function writeDoc(rel: string, d: Doc) { writeRaw(rel, renderDoc(d)); }
export function writeRaw(rel: string, data: string | Buffer) {
  const p = abs(rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, data);
  renameSync(`${p}.tmp`, p);
}

// One writer at a time: git's index.lock would fail the second of two concurrent commits.
let chain: Promise<unknown> = Promise.resolve();
export function withVault<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// Run after every commit (vault sync's debounced push); listeners must not throw or do I/O inline.
export const afterCommit: (() => void)[] = [];

export async function commit(paths: string[], message: string) {
  const msg = message.replace(/\s+/g, " ").trim().slice(0, 100) || "update";
  await git("add", "--", ...paths);
  try { await git("commit", "-q", "--no-verify", "-m", msg); } catch (e) {
    // A write that left the file byte-identical has nothing to commit; that's not a failure.
    if (!/nothing (added )?to commit|no changes added/.test(String((e as { stdout?: string }).stdout || ""))) throw e;
  }
  for (const f of afterCommit) f();
}

const AREAS: [string, string][] = [["home", "Home"], ["money", "Money"], ["health", "Health"], ["car", "Car"], ["travel", "Travel"], ["building", "Building"], ["hobbies", "Hobbies"]];
const PROFILE: [string, string][] = [["working-style", "personal"], ["voice", "personal"], ["rules", "personal"], ["preferences", "personal"], ["money", "finance"], ["health", "health"]];

// First boot: an empty, committed vault with the seeded areas and empty profile files. No facts, ever.
export async function ensureVault() {
  if (existsSync(join(VAULT, ".git"))) return false;
  mkdirSync(VAULT, { recursive: true });
  await exec("git", [...GIT, "init", "-q", "-b", "main"], { cwd: VAULT });
  await git("config", "user.name", "Engram");
  await git("config", "user.email", "engram@localhost");
  for (const [slug, name] of AREAS) writeDoc(`areas/${slug}.md`, { fm: { name, summary: "" }, body: "" });
  for (const [name, scope] of PROFILE) writeDoc(`profile/${name}.md`, { fm: { scope }, body: "" });
  for (const d of ["projects", "entities", "memories", "artifacts/files", "journal", "skills"]) writeRaw(`${d}/.gitkeep`, "");
  await git("add", "-A");
  await git("commit", "-q", "--no-verify", "-m", "engram: new vault");
  return true;
}
