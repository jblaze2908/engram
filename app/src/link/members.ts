// The Pitcrew link (M3): one agent with link: true, and one ordinary Engram agent per crew member it creates.
import type { Agent, LinkMember, NewToken } from "../../shared/types.js";
import { now, httpErr } from "../config.js";
import { db, one, all, run } from "../db.js";
import { createAgent, getAgent, rotateToken, updateAgent } from "../agents.js";
import { areaExists } from "../store.js";
import { trace, type Actor } from "../trace.js";

if (!all<{ name: string }>("PRAGMA table_info(agents)").some((c) => c.name === "link")) db.exec("ALTER TABLE agents ADD COLUMN link INTEGER NOT NULL DEFAULT 0");
db.exec("CREATE TABLE IF NOT EXISTS link_members (pitcrew_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, area TEXT NOT NULL DEFAULT 'home')");

const LINKED_MS = 10 * 60000;
export const actorOf = (a: Agent): Actor => ({ id: a.id, name: a.name });

// last_used_at moves at most once a minute (agents.authenticate), so a 10 min window never flickers.
export const pitcrewLinked = () => !!one("SELECT 1 FROM agents WHERE link=1 AND revoked=0 AND last_used_at>?", now() - LINKED_MS);

export function createLinkAgent(): NewToken {
  if (one("SELECT 1 FROM agents WHERE link=1 AND revoked=0")) throw httpErr(409, "Pitcrew is already linked. Make it a new token instead.");
  // No grants: the link reads the inbox and digest through /link, never memories through /mcp.
  const t = createAgent({ name: "Pitcrew", kind: "pitcrew", profile: "crew-chief", grants: [] });
  run("UPDATE agents SET link=1 WHERE id=?", t.agent.id);
  return { ...t, agent: getAgent(t.agent.id)! };
}

export type Member = { agent: Agent; area: string };
export function memberOf(pitcrewId: string): Member {
  const r = one<{ agent_id: string; area: string }>("SELECT agent_id, area FROM link_members WHERE pitcrew_id=?", pitcrewId);
  const agent = r && getAgent(r.agent_id);
  if (!r || !agent || agent.revoked) throw httpErr(404, "No such crew member");
  return { agent, area: r.area };
}

// Rotating keeps your grant edits; a member you revoked in Engram stays revoked rather than coming back silently.
export function upsertMember(link: Agent, m: LinkMember): NewToken {
  const area = m.area || "home";
  if (!areaExists(area)) throw httpErr(400, `Unknown area: ${area}`);
  const profile = /^crew[ -]?chief$/i.test(m.name.trim()) || m.pitcrew_id === "crew-chief" ? "crew-chief" : "pitcrew-member";
  const r = one<{ agent_id: string }>("SELECT agent_id FROM link_members WHERE pitcrew_id=?", m.pitcrew_id);
  const existing = r ? getAgent(r.agent_id) : null;
  let t: NewToken;
  if (existing) {
    if (existing.name !== m.name && one("SELECT 1 FROM agents WHERE name=? AND revoked=0 AND id!=?", m.name, existing.id)) throw httpErr(409, "An agent with that name exists");
    if (existing.name !== m.name) updateAgent(existing.id, { name: m.name });
    t = rotateToken(existing.id);
  } else {
    t = createAgent({ name: m.name, kind: "pitcrew", profile, grants: [{ scope: "personal", read: true, write: "propose" }] });
  }
  run("UPDATE agents SET hue=? WHERE id=?", m.hue ?? null, t.agent.id);
  run("INSERT INTO link_members(pitcrew_id,agent_id,area) VALUES(?,?,?) ON CONFLICT(pitcrew_id) DO UPDATE SET agent_id=excluded.agent_id, area=excluded.area", m.pitcrew_id, t.agent.id, area);
  trace(actorOf(link), existing ? "link.member.token" : "link.member", t.agent.id, "ok", null, m.name);
  return { ...t, agent: getAgent(t.agent.id)! };
}
