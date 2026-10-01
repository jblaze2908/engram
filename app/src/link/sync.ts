// What an agent writes to disk (M5): its granted skills as SKILL.md files and its compiled profile block.
import type { Agent, SyncBundle } from "../../shared/types.js";
import { now } from "../config.js";
import { all, json, marks } from "../db.js";
import { readScopes } from "../agents.js";
import { compile } from "../views.js";
import { trace } from "../trace.js";

// A granted skill outside the agent's read scopes stays on the server: granting a skill never widens a scope.
export function syncBundle(a: Agent): SyncBundle {
  const scopes = readScopes(a);
  const rows = a.skills.length && scopes.length
    ? all<{ data: string }>(`SELECT data FROM docs WHERE kind='skill' AND title IN (${marks(a.skills.length)}) AND scope IN (${marks(scopes.length)}) ORDER BY title`, ...a.skills, ...scopes)
    : [];
  const skills = rows.map((r) => {
    const s = json<{ name: string; description: string; body: string; version: number }>(r.data, { name: "", description: "", body: "", version: 1 });
    const head = `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description || s.name)}\n---\n`;
    return { name: s.name, version: s.version || 1, body: `${head}${s.body.trim()}\n` };
  });
  const profile = compile(a.profile, scopes);
  trace({ id: a.id, name: a.name }, "sync", a.profile, "ok", null, `${skills.length} skills, ${profile.lines} profile lines`);
  return { agent: a.name, profile, skills, at: now() };
}
