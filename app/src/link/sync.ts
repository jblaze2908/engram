// What Pitcrew puts in a member's instructions: its compiled profile and the skills it may load with get("skill:<name>").
import type { Agent, SyncBundle } from "../../shared/types.js";
import { now } from "../config.js";
import { readScopes } from "../agents.js";
import { compile } from "../views.js";
import { grantedSkills } from "../instructions.js";
import { trace } from "../trace.js";

export function syncBundle(a: Agent): SyncBundle {
  const scopes = readScopes(a), skills = grantedSkills(a, scopes), profile = compile(a.profile, scopes);
  trace({ id: a.id, name: a.name }, "sync", a.profile, "ok", null, `${skills.length} skills, ${profile.lines} profile lines`);
  return { agent: a.name, profile, skills, at: now() };
}
