// What Pitcrew puts in a member's instructions: its compiled profile and the skills it may load with get("skill:<name>"),
// plus the names of the connections it may call, so Pitcrew can label those tool steps.
import type { SyncBundle } from "../../shared/types.js";
import { now } from "../config.js";
import { readScopes } from "../agents.js";
import { compile } from "../views.js";
import { grantedSkills } from "../instructions.js";
import { trace } from "../trace.js";
import { all } from "../db.js";
import type { Member } from "./members.js";
import { ownBrief } from "./memories.js";

export function syncBundle(m: Member): SyncBundle {
  const a = m.agent;
  const scopes = readScopes(a), skills = grantedSkills(a, scopes), profile = compile(a.profile, scopes);
  trace({ id: a.id, name: a.name }, "sync", a.profile, "ok", null, `${skills.length} skills, ${profile.lines} profile lines`);
  const connections = all<{ id: string; name: string }>("SELECT DISTINCT c.id, c.name FROM agent_tools g JOIN connections c ON c.id=g.conn_id WHERE g.agent_id=? ORDER BY c.name", a.id);
  return { agent: a.name, profile, skills, connections, memories: ownBrief(m), scope: m.scope, at: now() };
}
