import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, BASE, req, close, signIn, makeAgent, g } from "./_env.mjs";

const { scan } = await import("../dist/src/index.js");
// tools/ sits outside app/, so the Docker build (context app/) has no copy; the sync script is tested from the repo.
const SCRIPT = fileURLToPath(new URL("../../tools/engram-sync.mjs", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "engram-home-"));
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

let cookie, agent, token;
before(async () => {
  cookie = await signIn();
  const skill = (name, scope, body) => put(join(ROOT, "vault/skills", name, "SKILL.md"), `---\ndescription: ${name} steps\nscope: ${scope}\nversion: 2\n---\n${body}\n`);
  skill("grocery-run", "personal", "Order from the usual list.");
  skill("notes", "personal", "Take notes.");
  skill("budget", "finance", "Check the budget.");
  put(join(ROOT, "vault/profile/rules.md"), "---\nscope: personal\n---\n- Ask before paying anything\n");
  put(join(ROOT, "vault/profile/money.md"), "---\nscope: finance\n---\n- Salary lands on the 1st\n");
  scan();
  ({ agent, token } = await makeAgent(cookie, "Claude Code", [g("personal", true, "propose")]));
  await req("PATCH", `/api/agents/${agent.id}`, { skills: ["grocery-run", "notes", "budget"] }, { cookie });
});
after(async () => { rmSync(HOME, { recursive: true, force: true }); await close(); });

test("GET /api/agent/sync: granted skills inside read scopes and the compiled profile", async () => {
  assert.equal((await req("GET", "/api/agent/sync")).status, 401);
  const r = await req("GET", "/api/agent/sync", undefined, { bearer: token });
  assert.equal(r.status, 200);
  assert.equal(r.json.agent, "Claude Code");
  assert.deepEqual(r.json.skills.map((s) => s.name), ["grocery-run", "notes"], "the finance skill stays on the server");
  const s = r.json.skills[0];
  assert.equal(s.version, 2);
  assert.equal(s.body, '---\nname: grocery-run\ndescription: "grocery-run steps"\n---\nOrder from the usual list.\n');
  assert.equal(r.json.profile.target, "claude-code");
  assert.match(r.json.profile.text, /Ask before paying anything/);
  assert.doesNotMatch(r.json.profile.text, /Salary/);
  const revoked = await makeAgent(cookie, "Old", []);
  await req("POST", `/api/agents/${revoked.agent.id}/revoke`, {}, { cookie });
  assert.equal((await req("GET", "/api/agent/sync", undefined, { bearer: revoked.token })).status, 401);
});

const sync = (...args) => new Promise((ok) => execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME, ENGRAM_URL: BASE } }, (e, stdout, stderr) => ok({ code: e ? e.code : 0, out: stdout + stderr })));
const skills = join(HOME, ".claude/skills"), profile = join(HOME, ".claude/CLAUDE.md"), tokenFile = join(HOME, ".config/engram/claude-code.token");

test("engram-sync.mjs: dry run, managed vs unmanaged skills, profile block, token file mode", { skip: !existsSync(SCRIPT) }, async () => {
  put(join(HOME, ".config/engram/agents.json"), JSON.stringify([{ name: "claude-code", token_file: "~/.config/engram/claude-code.token", skills_dir: "~/.claude/skills", profile_file: "~/.claude/CLAUDE.md" }]));
  put(tokenFile, `${token}\n`);
  chmodSync(tokenFile, 0o600);
  put(join(skills, "notes/SKILL.md"), "my own notes skill\n");
  put(join(skills, "mine/SKILL.md"), "mine\n");
  put(join(skills, "stale/SKILL.md"), "old\n");
  put(join(skills, "stale/.engram-managed"), "managed\n");
  const before = "# My rules\n\n<!-- engram:begin -->\nold block\n<!-- engram:end -->\n\n## After\nkeep me\n";
  put(profile, before);

  const dry = await sync("--dry-run");
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /\[dry-run\].*wrote grocery-run v2/);
  assert.ok(!existsSync(join(skills, "grocery-run")), "dry run writes nothing");
  assert.ok(existsSync(join(skills, "stale")), "dry run removes nothing");
  assert.equal(readFileSync(profile, "utf8"), before);

  const r = await sync();
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(join(skills, "grocery-run/SKILL.md"), "utf8"), /^---\nname: grocery-run\n/);
  assert.ok(existsSync(join(skills, "grocery-run/.engram-managed")));
  assert.equal(readFileSync(join(skills, "notes/SKILL.md"), "utf8"), "my own notes skill\n", "unmanaged skill with a granted name is left alone");
  assert.ok(!existsSync(join(skills, "notes/.engram-managed")));
  assert.equal(readFileSync(join(skills, "mine/SKILL.md"), "utf8"), "mine\n");
  assert.ok(!existsSync(join(skills, "stale")), "managed skill no longer granted is removed");
  const p = readFileSync(profile, "utf8");
  assert.ok(p.startsWith("# My rules\n\n<!-- engram:begin -->\n"));
  assert.ok(p.endsWith("<!-- engram:end -->\n\n## After\nkeep me\n"));
  assert.match(p, /Ask before paying anything/);
  assert.doesNotMatch(p, /old block/);

  const again = await sync();
  assert.equal(again.code, 0);
  assert.doesNotMatch(again.out, /wrote|updated|removed/, "a second run with nothing new changes nothing");

  // A profile file without the block gets it appended; parent dirs are made.
  const codex = join(HOME, ".codex/AGENTS.md");
  put(join(HOME, ".config/engram/agents.json"), JSON.stringify([{ name: "codex", token_file: tokenFile, skills_dir: join(HOME, ".agents/skills"), profile_file: codex }]));
  assert.equal((await sync()).code, 0);
  assert.match(readFileSync(codex, "utf8"), /^<!-- engram:begin -->\n[\s\S]*<!-- engram:end -->\n$/);
  assert.ok(existsSync(join(HOME, ".agents/skills/grocery-run/SKILL.md")));

  chmodSync(tokenFile, 0o644);
  rmSync(join(HOME, ".agents/skills"), { recursive: true });
  const refused = await sync();
  assert.equal(refused.code, 1);
  assert.match(refused.out, /refusing to run: .*claude-code\.token must be readable by you only/);
  assert.ok(!existsSync(join(HOME, ".agents/skills")), "nothing written when refused");
  assert.doesNotMatch(refused.out + r.out, new RegExp(token), "the token is never printed");
});
