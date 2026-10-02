// What an MCP client is told at initialize: a profile gist, the skills it may load, how upstream tools are named.
// Built per /mcp request (the server is stateless): two indexed SQLite reads, no disk.
import type { Agent, Scope } from "../shared/types.js";
import { all, json, marks } from "./db.js";
import { compile } from "./views.js";

export const SKILLS_CAP = 1500;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// A granted skill outside the agent's read scopes stays hidden: granting a skill never widens a scope.
export function grantedSkills(a: Agent, scopes: Scope[]) {
  if (!a.skills.length || !scopes.length) return [];
  return all<{ data: string }>(`SELECT data FROM docs WHERE kind='skill' AND title IN (${marks(a.skills.length)}) AND scope IN (${marks(scopes.length)}) ORDER BY title`, ...a.skills, ...scopes)
    .map((r) => json<{ name: string; description: string; version: number }>(r.data, { name: "", description: "", version: 1 }))
    .map((s) => ({ name: s.name, description: s.description || s.name, version: s.version || 1 }));
}

export function instructions(a: Agent, scopes: Scope[]): string {
  const p = compile(a.profile, scopes);
  const gist = p.text.split("\n").map((l) => l.replace(/^[-*\d.)\s]+/, "").trim()).filter((l) => l && !l.startsWith("#")).slice(0, 3);
  const out = ["Engram holds what the user has told their agents: search, then get by id; propose what you learn."];
  out.push(gist.length ? `How the user works (profile() has all ${p.lines} lines):\n${gist.map((l) => `- ${clip(l, 160)}`).join("\n")}` : "No profile within your grants yet.");
  const skills = grantedSkills(a, scopes);
  if (skills.length) {
    let block = "Skills you can load with get('skill:<name>'):", shown = 0;
    for (const s of skills) {
      const line = `\n- ${s.name} — ${clip(s.description.replace(/\s+/g, " "), 200)}`;
      if (block.length + line.length > SKILLS_CAP - 80) break;
      block += line; shown++;
    }
    if (shown < skills.length) block += `\n…and ${skills.length - shown} more: search with kind "skill" to find them.`;
    out.push(block);
  }
  if (a.tools?.length) out.push(`Upstream tools are named <conn>__<tool>; search with kind "tool" to find them.`);
  return out.join("\n\n");
}
