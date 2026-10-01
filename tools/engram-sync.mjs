#!/usr/bin/env node
// engram-sync: writes each Mac agent's granted Engram skills and profile block to disk (docs/milestones.md, M5).
// No dependencies, Node >= 22. Run by tools/com.engram.sync.plist every 15 min.
//
//   node tools/engram-sync.mjs [--dry-run]
//
// Config: ~/.config/engram/agents.json (or ENGRAM_SYNC_CONFIG), a list of
//   { "name", "token_file", "skills_dir", "profile_file" } with ~ allowed. Server: ENGRAM_URL (default below).
// Only skill folders holding a .engram-managed marker are ever written or removed; anything else is yours. In the
// profile file only the block between the engram markers is replaced.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const URL_BASE = (process.env.ENGRAM_URL || "https://engram.example.com").replace(/\/+$/, "");
const DRY = process.argv.includes("--dry-run");
const MARKER = ".engram-managed";
const BEGIN = "<!-- engram:begin -->", END = "<!-- engram:end -->";
const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

const home = homedir();
const expand = (p) => resolve(String(p).replace(/^~(?=$|\/)/, home));
const log = (msg) => console.log(`${new Date().toISOString()} ${DRY ? "[dry-run] " : ""}${msg}`);
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

// Temp file + rename in the same directory, so a reader never sees half a file.
function put(path, text) {
  if (read(path) === text) return false;
  if (!DRY) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.engram-tmp-${process.pid}`;
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, path);
  }
  return true;
}

function withBlock(file, text) {
  const block = `${BEGIN}\n<!-- Written by engram-sync from Engram; edits inside this block are replaced. -->\n${text.trim() ? `${text.trim()}\n` : ""}${END}`;
  if (file === null || file === "") return `${block}\n`;
  const b = file.indexOf(BEGIN), e = file.indexOf(END, b + BEGIN.length);
  if (b < 0 && file.indexOf(END) < 0) return `${file.replace(/\n*$/, "")}\n\n${block}\n`;
  if (b < 0 || e < 0 || file.indexOf(BEGIN, b + 1) >= 0) return null;
  return file.slice(0, b) + block + file.slice(e + END.length);
}

function loadConfig() {
  const path = expand(process.env.ENGRAM_SYNC_CONFIG || "~/.config/engram/agents.json");
  const list = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${path} must be a JSON list`);
  return list.map((a, i) => {
    for (const k of ["name", "token_file", "skills_dir", "profile_file"]) if (typeof a?.[k] !== "string" || !a[k]) throw new Error(`agent ${i}: ${k} is missing`);
    return { name: a.name, token_file: expand(a.token_file), skills_dir: expand(a.skills_dir), profile_file: expand(a.profile_file) };
  });
}

// A token readable by anyone else on the Mac is as good as leaked; refuse before sending it anywhere.
function checkTokens(agents) {
  const bad = agents.filter((a) => (statSync(a.token_file).mode & 0o077) !== 0);
  if (bad.length) throw new Error(`refusing to run: ${bad.map((a) => a.token_file).join(", ")} must be readable by you only (chmod 600)`);
}

async function fetchBundle(a) {
  const token = readFileSync(a.token_file, "utf8").trim();
  if (!/^eg_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`${a.name}: ${a.token_file} doesn't hold an Engram token`);
  const r = await fetch(`${URL_BASE}/api/agent/sync`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${a.name}: Engram answered ${r.status}`);
  return r.json();
}

// lstat: a symlinked skill folder is never ours, even if its target has a marker.
const managed = (dir) => lstatSync(dir).isDirectory() && existsSync(join(dir, MARKER));

function syncSkills(a, skills) {
  const want = new Set();
  for (const s of skills) {
    if (!NAME.test(s?.name || "") || typeof s.body !== "string") { log(`${a.name}: skipped a skill with a bad name`); continue; }
    want.add(s.name);
    const dir = join(a.skills_dir, s.name);
    if (existsSync(dir) && !managed(dir)) { log(`${a.name}: ${dir} is yours (no ${MARKER}); left alone`); continue; }
    const wrote = put(join(dir, "SKILL.md"), s.body);
    put(join(dir, MARKER), `Managed by engram-sync (skill ${s.name} v${s.version}). Delete this file to keep the folder as your own.\n`);
    if (wrote) log(`${a.name}: wrote ${s.name} v${s.version}`);
  }
  if (!existsSync(a.skills_dir)) return;
  for (const e of readdirSync(a.skills_dir, { withFileTypes: true })) {
    const dir = join(a.skills_dir, e.name);
    if (!e.isDirectory() || want.has(e.name) || !managed(dir)) continue;
    if (!DRY) rmSync(dir, { recursive: true, force: true });
    log(`${a.name}: removed ${e.name} (no longer granted)`);
  }
}

function syncProfile(a, profile) {
  const next = withBlock(read(a.profile_file), profile?.text || "");
  if (next === null) { log(`${a.name}: ${a.profile_file} has broken engram markers; left alone`); return; }
  if (put(a.profile_file, next)) log(`${a.name}: updated the profile block in ${a.profile_file} (${profile?.lines ?? 0} lines)`);
}

async function main() {
  const agents = loadConfig();
  checkTokens(agents);
  let failed = 0;
  for (const a of agents) {
    try {
      const b = await fetchBundle(a);
      syncSkills(a, Array.isArray(b.skills) ? b.skills : []);
      syncProfile(a, b.profile);
    } catch (e) { failed++; log(`${a.name}: ${e.message}`); }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { log(e.message); process.exitCode = 1; });
