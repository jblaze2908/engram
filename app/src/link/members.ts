// The Pitcrew link (M3): one agent with link: true, and one ordinary Engram agent per crew member it creates.
import type { Agent, Grant, LinkMember, NewToken, Scope } from "../../shared/types.js";
import { now, httpErr } from "../config.js";
import { db, one, all, run } from "../db.js";
import { createAgent, getAgent, rotateToken, updateAgent } from "../agents.js";
import { areaExists } from "../store.js";
import { connRow, kindOf, policyOf, toolRows } from "../gateway/store.js";
import { trace, type Actor } from "../trace.js";

if (!all<{ name: string }>("PRAGMA table_info(agents)").some((c) => c.name === "link")) db.exec("ALTER TABLE agents ADD COLUMN link INTEGER NOT NULL DEFAULT 0");
db.exec("CREATE TABLE IF NOT EXISTS link_members (pitcrew_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, area TEXT NOT NULL DEFAULT 'home')");
if (!all<{ name: string }>("PRAGMA table_info(link_members)").some((c) => c.name === "scope")) db.exec("ALTER TABLE link_members ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'");

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

// scope is the member's home scope: where its memories, artifacts and journal land (a private Pitcrew member uses
// finance or health, so members granted only personal never read it).
export type Member = { agent: Agent; area: string; scope: Scope };
export function memberOf(pitcrewId: string): Member {
  const r = one<{ agent_id: string; area: string; scope: Scope }>("SELECT agent_id, area, scope FROM link_members WHERE pitcrew_id=?", pitcrewId);
  const agent = r && getAgent(r.agent_id);
  if (!r || !agent || agent.revoked) throw httpErr(404, "No such crew member");
  return { agent, area: r.area, scope: r.scope };
}

const SCOPE_AREA: Partial<Record<Scope, string>> = { finance: "money", health: "health" };
const propose = (scope: Scope): Grant => ({ scope, read: true, write: "propose" });
// Read only: household facts are yours to add, so a member can see them but never proposes into them.
const HOUSEHOLD: Grant = { scope: "household", read: true, write: "none" };
export const hasHousehold = (a: Agent) => a.grants.some((g) => g.scope === "household" && g.read);

/** The driver's checkbox in Pitcrew: adds or removes the household read grant, and leaves the token alone. */
export function setHousehold(link: Agent, pitcrewId: string, on: boolean) {
  const { agent } = memberOf(pitcrewId);
  if (on) run("INSERT INTO grants(agent_id,scope,read,write) VALUES(?,?,1,'none') ON CONFLICT(agent_id,scope) DO UPDATE SET read=1", agent.id, "household");
  else run("DELETE FROM grants WHERE agent_id=? AND scope='household'", agent.id);
  trace(actorOf(link), "link.member.household", agent.id, "ok", "household", `${agent.name}: ${on ? "on" : "off"}`);
  return { household: hasHousehold(getAgent(agent.id)!) };
}
// Read tools of the named connections that aren't blocked; never a write tool (those you grant in Engram).
function readTools(conns: string[]) {
  return [...new Set(conns)].filter((c) => connRow(c)).flatMap((c) => toolRows(c).filter((t) => kindOf(t) === "read" && policyOf(t) !== "block").map((t) => [c, t.name] as const));
}

// Rotating keeps your grant edits; a member you revoked in Engram stays revoked rather than coming back silently.
export function upsertMember(link: Agent, m: LinkMember): NewToken {
  const scope: Scope = m.scope || "personal", own = SCOPE_AREA[scope];
  const area = m.area || (own && areaExists(own) ? own : "home");
  if (!areaExists(area)) throw httpErr(400, `Unknown area: ${area}`);
  const profile = /^crew[ -]?chief$/i.test(m.name.trim()) || m.pitcrew_id === "crew-chief" ? "crew-chief" : "pitcrew-member";
  const r = one<{ agent_id: string; scope: Scope }>("SELECT agent_id, scope FROM link_members WHERE pitcrew_id=?", m.pitcrew_id);
  const existing = r ? getAgent(r.agent_id) : null;
  let t: NewToken;
  if (existing) {
    if (existing.name !== m.name && one("SELECT 1 FROM agents WHERE name=? AND revoked=0 AND id!=?", m.name, existing.id)) throw httpErr(409, "An agent with that name exists");
    if (existing.name !== m.name) updateAgent(existing.id, { name: m.name });
    t = rotateToken(existing.id);
    // Only a scope change from Pitcrew (the driver's own edit) touches grants, and it only adds.
    if (scope !== "personal" && r!.scope !== scope) run("INSERT INTO grants(agent_id,scope,read,write) VALUES(?,?,1,'propose') ON CONFLICT(agent_id,scope) DO UPDATE SET read=1, write='propose'", existing.id, scope);
  } else {
    const grants = scope === "personal" ? [propose("personal")] : [propose("personal"), propose(scope)];
    t = createAgent({ name: m.name, kind: "pitcrew", profile, grants: m.household ? [...grants, HOUSEHOLD] : grants });
    // Connections picked at hire apply once, on creation; after that the tool grants are yours to edit in Engram.
    for (const [c, tool] of readTools(m.connections || [])) run("INSERT OR IGNORE INTO agent_tools(agent_id,conn_id,tool) VALUES(?,?,?)", t.agent.id, c, tool);
  }
  run("UPDATE agents SET hue=? WHERE id=?", m.hue ?? null, t.agent.id);
  run("INSERT INTO link_members(pitcrew_id,agent_id,area,scope) VALUES(?,?,?,?) ON CONFLICT(pitcrew_id) DO UPDATE SET agent_id=excluded.agent_id, area=excluded.area, scope=excluded.scope", m.pitcrew_id, t.agent.id, area, scope);
  trace(actorOf(link), existing ? "link.member.token" : "link.member", t.agent.id, "ok", scope, `${m.name}${!existing && m.connections?.length ? ` · read tools of ${m.connections.join(", ")}` : ""}`);
  return { ...t, agent: getAgent(t.agent.id)! };
}
