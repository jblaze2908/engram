// Mirrors the vault to a private git remote (ENGRAM_VAULT_REMOTE) so Obsidian on the Mac edits the same files: a
// push after commits (debounced 10 s), and every 60 s a fetch with Engram's commits rebased onto yours. A conflict keeps
// both versions and lands in the inbox. Never force-pushes. All git runs under the vault writer lock except fetch.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Proposal, Status } from "../shared/types.js";
import { ROOT, VAULT, now, uid, httpErr } from "./config.js";
import { one, run } from "./db.js";
import { abs, afterCommit, withVault, writeRaw } from "./vault.js";
import { scan, CONFLICT } from "./index.js";
import { trace } from "./trace.js";
import { proposed } from "./notify.js";

const REMOTE = process.env.ENGRAM_VAULT_REMOTE || "";
// ssh (scp-style or ssh://) for GitHub, file:// for tests. Nothing that could start with "-" and read as an option.
const REMOTE_RE = /^(ssh:\/\/[\w.@:/~-]+|[\w.-]+@[\w.-]+:[\w./~-]+|file:\/\/\/[\w./ -]+)$/;
const PUSH_DELAY = 10000, EVERY = 60000;
const SSH = join(ROOT, "home", ".ssh");
const sq = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
const ENV = {
  ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true",
  GIT_SSH_COMMAND: `ssh -i ${sq(join(SSH, "vault_deploy"))} -o IdentitiesOnly=yes -o UserKnownHostsFile=${sq(join(SSH, "known_hosts"))} -o StrictHostKeyChecking=yes -o BatchMode=yes`,
};
const GIT = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=off"];

function gitRaw(args: string[]): Promise<Buffer> {
  return new Promise((ok, fail) => execFile("git", [...GIT, ...args], { cwd: VAULT, env: ENV, timeout: 60000, maxBuffer: 16 << 20, encoding: "buffer" },
    (e, out, err) => (e ? fail(Object.assign(new Error(String(err).trim().split("\n").pop() || e.message), { code: e.code })) : ok(out))));
}
const git = async (...args: string[]) => (await gitRaw(args)).toString("utf8").trim();
const yes = (...args: string[]) => gitRaw(args).then(() => true, () => false);
const blob = (spec: string) => gitRaw(["show", spec]).catch(() => null);
const remoteHead = () => git("rev-parse", "-q", "--verify", "refs/remotes/origin/main").catch(() => "");

async function setup() {
  const cur = await git("remote", "get-url", "origin").catch(() => null);
  if (cur === null) await git("remote", "add", "origin", REMOTE);
  else if (cur !== REMOTE) await git("remote", "set-url", "origin", REMOTE);
}

// Replays Engram's commits onto yours. On a conflict Engram's version stays at the path and the remote one is saved
// next to it, once per file (a later commit's "ours" side is already Engram's resolution).
async function rebase(onto: string) {
  const ts = now(), copies = new Map<string, string>();
  let done = await yes("rebase", "-q", onto);
  for (let i = 0; !done && i < 100; i++) {
    const files = (await git("diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
    if (!files.length) { done = await yes("rebase", "--skip"); continue; }
    for (const f of files) {
      const remote = await blob(`:2:${f}`), mine = await blob(`:3:${f}`), keep = mine ?? remote;
      if (keep) writeRaw(f, keep); else rmSync(abs(f), { force: true });
      if (mine && remote && f.endsWith(".md") && !copies.has(f)) {
        const copy = f.replace(/\.md$/, `.conflict-${ts}.md`);
        writeRaw(copy, remote);
        await git("add", "--", copy);
        copies.set(f, copy);
      }
      await git("add", "-A", "--", f);
    }
    done = await yes("rebase", "--continue");
  }
  if (!done) { await yes("rebase", "--abort"); throw new Error("rebase onto the remote vault did not finish"); }
  for (const [path, copy] of copies) raiseConflict(path, copy);
}

function raiseConflict(path: string, copy: string) {
  const t = now(), area = one<{ area: string }>("SELECT area FROM docs WHERE path=?", path)?.area || "home";
  // Private scope: resolved in Engram only, never mirrored to Pitcrew or named in a notification.
  run("INSERT INTO proposals(id,kind,agent,title,scope,area,data,norm,source,source_ref,reasons,held,replaces,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    uid("p"), "vault_conflict", null, `Edit conflict in ${path}`, "private", area,
    JSON.stringify({ text: `Engram and Obsidian both changed ${path}. Engram kept its version; yours is saved as ${copy}.`, path, conflict: copy }), null,
    JSON.stringify({ kind: "other", label: "Vault sync", agent: null, ref: null, at: t }), null,
    JSON.stringify(["Your edit in Obsidian and Engram's both changed this file", "Accept uses your Obsidian version; Reject keeps Engram's and leaves your copy in the vault"]),
    1, "null", "open", t);
  trace({ id: null, name: "engram" }, "vault.conflict", path, "held", null, copy);
  proposed();
}

/** Accepting a vault_conflict proposal: the saved remote copy replaces the file. Called from the write path. */
export function useRemoteVersion(p: Proposal): { paths: string[]; msg: string } {
  const d = p.data as { path?: unknown; conflict?: unknown };
  if (typeof d.path !== "string" || typeof d.conflict !== "string" || !CONFLICT.test(d.conflict) || d.conflict.replace(CONFLICT, ".md") !== d.path) throw httpErr(400, "Bad conflict record");
  const src = abs(d.conflict);
  if (!existsSync(src)) throw httpErr(409, "The saved copy is gone; reject this instead");
  writeRaw(d.path, readFileSync(src));
  rmSync(src);
  return { paths: [d.path, d.conflict], msg: `conflict: used the Obsidian version of ${d.path}` };
}

async function cycle() {
  // Outside the lock: fetch only writes objects and refs/remotes, which nothing else touches.
  await git("fetch", "--quiet", "--no-tags", "origin");
  await withVault(async () => {
    const theirs = await remoteHead();
    if (theirs) {
      const head = await git("rev-parse", "HEAD");
      if (head !== theirs && !(await yes("merge-base", "--is-ancestor", theirs, head))) {
        if (await git("status", "--porcelain", "--untracked-files=no")) throw new Error("the vault has uncommitted changes");
        if (await yes("merge-base", "--is-ancestor", head, theirs)) await git("merge", "--ff-only", "-q", theirs);
        else if (await yes("merge-base", head, theirs)) await rebase(theirs);
        else throw new Error("the remote vault has unrelated history");
        scan();
      }
    }
    const base = await remoteHead();
    if (!base || (await git("rev-list", "--count", `${base}..HEAD`)) !== "0") await git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  });
}

let running: Promise<void> | null = null, lastError: string | null = null, lastOk: number | null = null, timer: ReturnType<typeof setTimeout> | undefined;
/** One sync at a time; a caller arriving mid-sync waits for it and then runs its own. */
export async function syncNow(): Promise<void> {
  while (running) await running.catch(() => {});
  running = cycle().then(() => { lastOk = now(); lastError = null; }, (e: Error) => {
    if (e.message !== lastError) console.error("vault sync failed:", e.message);
    lastError = e.message;
    throw e;
  }).finally(() => { running = null; });
  return running;
}
const later = () => { clearTimeout(timer); timer = setTimeout(() => { syncNow().catch(() => {}); }, PUSH_DELAY); timer.unref(); };

export let vaultSyncReady: Promise<void> = Promise.resolve();
export function startVaultSync() {
  if (!REMOTE) return;
  if (!REMOTE_RE.test(REMOTE)) { console.error("ENGRAM_VAULT_REMOTE is not an ssh or file:// git URL; vault sync is off"); return; }
  afterCommit.push(later);
  vaultSyncReady = withVault(setup).then(() => syncNow()).catch(() => {});
  setInterval(() => { syncNow().catch(() => {}); }, EVERY).unref();
}

/** For Status: a sync failing for over 10 minutes needs you (keys, known_hosts, or a stuck rebase). */
export function vaultSyncAttention(): Status["attention"] {
  if (!REMOTE || !lastError || (lastOk && now() - lastOk < 10 * 60000)) return [];
  return [{ level: "warn", title: "Vault sync is failing", detail: lastError.slice(0, 160), action: "Trace", href: "/trace" }];
}
