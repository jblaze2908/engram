import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, req, close, signIn, makeAgent, g, mcp } from "./_env.mjs";

const { scan } = await import("../dist/src/index.js");
const skill = (name, description, scope = "personal") => {
  mkdirSync(join(ROOT, "vault", "skills", name), { recursive: true });
  writeFileSync(join(ROOT, "vault", "skills", name, "SKILL.md"), `---\ndescription: ${description}\nscope: ${scope}\n---\nBody of ${name}.\n`);
};
const init = async (token) => (await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).msg.result;

let cookie;
before(async () => {
  cookie = await signIn();
  writeFileSync(join(ROOT, "vault", "profile", "working-style.md"), "---\nscope: personal\n---\n# How I work\n- Short answers first\n- Ask before spending money\n- Dates as 2 Oct\n- Fourth line never shown\n");
  skill("pay-rent", "Monthly rent to the landlord");
  skill("file-receipt", "Where receipts go");
  skill("tax-filing", "Annual ITR steps", "finance");
  for (let i = 0; i < 30; i++) skill(`bulk-${String(i).padStart(2, "0")}`, `A long description that takes room in the index, number ${i} of thirty`);
  scan(true);
});
after(close);

test("instructions: profile gist, granted skills within read scopes only, tool naming", async () => {
  const a = await makeAgent(cookie, "Claude Code", [g("personal", true, "propose")]);
  await req("PATCH", `/api/agents/${a.agent.id}`, { skills: ["pay-rent", "tax-filing"] }, { cookie });
  const r = await init(a.token);
  const text = r.instructions;
  assert.match(text, /profile\(\) has all \d+ lines/);
  assert.match(text, /- Short answers first\n- Ask before spending money\n- Dates as 2 Oct/);
  assert.ok(!text.includes("Fourth line"), "three profile lines only");
  assert.ok(!text.includes("How I work"), "headings are skipped");
  assert.match(text, /Skills you can load with get\('skill:<name>'\):\n- pay-rent — Monthly rent to the landlord/);
  assert.ok(!text.includes("tax-filing"), "a granted skill outside the read scopes is not listed");
  assert.ok(!text.includes("file-receipt"), "an ungranted skill is not listed");
  assert.ok(!text.includes("<conn>__<tool>"), "no tool note without tool grants");
  const list = await mcp(a.token, "tools/list");
  assert.match(list.msg.result.tools.find((t) => t.name === "search").description, /skill.*tool/s);

  // Finance read brings the finance skill in.
  await req("PATCH", `/api/agents/${a.agent.id}`, { grants: [g("personal", true), g("finance", true)] }, { cookie });
  assert.match((await init(a.token)).instructions, /- tax-filing — Annual ITR steps/);
});

test("instructions: the skills index is capped with an overflow line", async () => {
  const a = await makeAgent(cookie, "Many skills", [g("personal", true)]);
  const names = Array.from({ length: 30 }, (_, i) => `bulk-${String(i).padStart(2, "0")}`);
  await req("PATCH", `/api/agents/${a.agent.id}`, { skills: names }, { cookie });
  const text = (await init(a.token)).instructions;
  const block = text.slice(text.indexOf("Skills you can load"));
  assert.ok(block.length <= 1500, `skills block is ${block.length} chars`);
  const shown = (block.match(/^- bulk-/gm) || []).length;
  assert.ok(shown > 5 && shown < 30, `${shown} shown`);
  assert.match(block, new RegExp(`…and ${30 - shown} more: search with kind "skill" to find them\\.`));
  console.log(`# measured instructions: ${text.length} chars, skills block ${block.length} chars, ${shown}/30 skills shown`);
});

test("instructions: no skills and no profile within grants", async () => {
  const a = await makeAgent(cookie, "Nothing", []);
  const text = (await init(a.token)).instructions;
  assert.match(text, /No profile within your grants yet\./);
  assert.ok(!text.includes("Skills you can load"));
});
