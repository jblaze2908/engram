import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A local bare repo stands in for GitHub; a clone of it stands in for Obsidian on your computer.
const BARE = mkdtempSync(join(tmpdir(), "engram-bare-")), OBS = mkdtempSync(join(tmpdir(), "engram-obs-"));
execFileSync("git", ["init", "-q", "--bare", "-b", "main", BARE]);
process.env.ENGRAM_VAULT_REMOTE = `file://${BARE}`;
const { ROOT, req, close, signIn, gitLog } = await import("./_env.mjs");
const VS = await import("../dist/src/vaultsync.js");

const bare = (...a) => execFileSync("git", ["--git-dir", BARE, ...a]).toString().trim();
const obs = (...a) => execFileSync("git", ["-c", "user.name=Obsidian", "-c", "user.email=o@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: OBS }).toString().trim();
const obsPut = (rel, s) => { mkdirSync(dirname(join(OBS, rel)), { recursive: true }); writeFileSync(join(OBS, rel), s); };
const ym = () => { const d = new Date(); return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}`; };

let cookie;
before(async () => {
  await VS.vaultSyncReady;
  cookie = await signIn();
});
after(async () => { await close(); rmSync(BARE, { recursive: true, force: true }); rmSync(OBS, { recursive: true, force: true }); });

test("boot pushes the new vault to an empty remote; later commits are pushed", async () => {
  assert.deepEqual(bare("log", "--format=%s", "main").split("\n"), ["engram: new vault"]);
  const m = await req("POST", "/api/memories", { text: "The gate code is 2024", area: "building", scope: "personal" }, { cookie });
  assert.equal(m.status, 200);
  await VS.syncNow();
  assert.equal(bare("log", "-1", "--format=%s", "main"), "memory: The gate code is 2024");
});

test("an Obsidian edit is pulled, rebased under Engram's unpushed commit, and indexed", async () => {
  execFileSync("git", ["clone", "-q", BARE, OBS]);
  obsPut(`memories/${ym()}/m_obs.md`, `---\nid: m_obs\narea: home\nscope: personal\nstatus: active\nsource: { kind: you, label: Obsidian }\ncreated_at: ${Date.now()}\n---\nThe water filter needs a new cartridge\n`);
  obs("add", "-A"); obs("commit", "-q", "-m", "obsidian: water filter"); obs("push", "-q", "origin", "main");
  const obsHead = obs("rev-parse", "HEAD");

  await req("POST", "/api/memories", { text: "Milk comes at 7", area: "home", scope: "personal" }, { cookie });
  await VS.syncNow();
  const m = await req("GET", "/api/memories/m_obs", undefined, { cookie });
  assert.equal(m.status, 200, "reindexed after the pull");
  assert.equal(m.json.text, "The water filter needs a new cartridge");
  assert.deepEqual(gitLog().slice(0, 2), ["memory: Milk comes at 7", "obsidian: water filter"], "Engram's commit replayed on top");
  bare("merge-base", "--is-ancestor", obsHead, "main");
  assert.equal(bare("rev-parse", "main"), execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(ROOT, "vault") }).toString().trim());
});

test("a conflict keeps both versions, raises an inbox item, and never force-pushes", async () => {
  const mine = (await req("GET", "/api/memories?area=building", undefined, { cookie })).json.find((x) => x.text === "The gate code is 2024");
  const rel = `memories/${ym()}/${mine.id}.md`;
  obs("pull", "-q", "--rebase", "origin", "main");
  const theirs = readFileSync(join(OBS, rel), "utf8").replace("status: active", "status: active # checked").replace("The gate code is 2024", "The gate code is 2025");
  obsPut(rel, theirs);
  obs("commit", "-q", "-am", "obsidian: new gate code"); obs("push", "-q", "origin", "main");
  const obsHead = obs("rev-parse", "HEAD");

  assert.equal((await req("POST", `/api/memories/${mine.id}/forget`, {}, { cookie })).status, 200);
  await VS.syncNow();

  const vault = join(ROOT, "vault");
  assert.match(readFileSync(join(vault, rel), "utf8"), /status: forgotten\n[\s\S]*The gate code is 2024/, "Engram's version stays at the path");
  const copies = readdirSync(dirname(join(vault, rel))).filter((f) => f.startsWith(`${mine.id}.conflict-`));
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(dirname(join(vault, rel)), copies[0]), "utf8"), theirs, "the remote version is saved next to it");
  const all = (await req("GET", "/api/memories?status=all", undefined, { cookie })).json.filter((x) => x.id === mine.id);
  assert.equal(all.length, 1, "the conflict copy isn't indexed");
  assert.equal(all[0].status, "forgotten");

  const item = (await req("GET", "/api/inbox", undefined, { cookie })).json.find((p) => p.kind === "vault_conflict");
  assert.ok(item);
  assert.equal(item.scope, "private");
  assert.equal(item.held, true);
  assert.equal(item.data.path, rel);
  bare("merge-base", "--is-ancestor", obsHead, "main");
  assert.match(bare("log", "-1", "--format=%s", "main"), /^forget: /);

  // Accept = use the Obsidian version; the copy goes, and that is one more commit, pushed.
  const d = await req("POST", `/api/inbox/${item.id}`, { decision: "accept" }, { cookie });
  assert.equal(d.status, 200, d.text);
  assert.equal(readFileSync(join(vault, rel), "utf8"), theirs);
  assert.ok(!existsSync(join(dirname(join(vault, rel)), copies[0])));
  assert.equal(gitLog()[0], `conflict: used the Obsidian version of ${rel}`);
  assert.equal((await req("GET", `/api/memories/${mine.id}`, undefined, { cookie })).json.text, "The gate code is 2025");
  await VS.syncNow();
  assert.equal(bare("log", "-1", "--format=%s", "main"), `conflict: used the Obsidian version of ${rel}`);
});
