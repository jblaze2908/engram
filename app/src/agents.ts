// Agents and their bearer tokens. A token is shown once; only its sha256 and a display prefix are stored.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Agent, Grant, NewToken, ProfileTarget, Scope } from "../shared/types.js";
import { now, uid, httpErr } from "./config.js";
import { db, one, all, run, json, tx, type Row } from "./db.js";
import { sha } from "./auth.js";
import { trace, YOU } from "./trace.js";
import { toolGrants } from "./gateway/store.js";

if (!all<{ name: string }>("PRAGMA table_info(agents)").some((c) => c.name === "auto_accept")) db.exec("ALTER TABLE agents ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0");

export const GRANTABLE: Scope[] = ["personal", "finance", "health", "household"];
const newToken = () => `eg_${randomBytes(32).toString("base64url")}`;
const prefixOf = (t: string) => t.slice(0, 7);

function toAgent(r: Row): Agent {
  const grants = all<{ scope: Scope; read: number; write: Grant["write"] }>("SELECT scope, read, write FROM grants WHERE agent_id=?", r.id);
  return {
    id: r.id, name: r.name, kind: r.kind, profile: r.profile, hue: r.hue ?? null, skills: json(r.skills, []), tools: toolGrants(r.id),
    grants: GRANTABLE.map((s) => { const g = grants.find((x) => x.scope === s); return { scope: s, read: !!g?.read, write: g?.write || "none" }; }),
    token_prefix: r.token_prefix, created_at: r.created_at, last_used_at: r.last_used_at ?? null, revoked: !!r.revoked, link: !!r.link, auto_accept: !!r.auto_accept,
  };
}
export const listAgents = () => all("SELECT * FROM agents ORDER BY created_at").map(toAgent);
export const getAgent = (id: string) => { const r = one("SELECT * FROM agents WHERE id=?", id); return r ? toAgent(r) : null; };

// private is never granted: asking for it is an error, not a silent drop, so the UI can't think it worked.
function setGrants(id: string, grants: Grant[]) {
  for (const g of grants) if (g.scope === "private" && (g.read || g.write !== "none")) throw httpErr(400, "Private is never granted to an agent");
  run("DELETE FROM grants WHERE agent_id=?", id);
  for (const g of grants) if (GRANTABLE.includes(g.scope)) run("INSERT OR REPLACE INTO grants(agent_id,scope,read,write) VALUES(?,?,?,?)", id, g.scope, g.read ? 1 : 0, g.write);
}

export function createAgent(a: { name: string; kind: Agent["kind"]; profile: ProfileTarget; grants: Grant[] }): NewToken {
  if (one("SELECT 1 FROM agents WHERE name=? AND revoked=0", a.name)) throw httpErr(409, "An agent with that name exists");
  const id = uid("ag"), token = newToken();
  tx(() => {
    run("INSERT INTO agents(id,name,kind,profile,token_hash,token_prefix,created_at) VALUES(?,?,?,?,?,?,?)", id, a.name, a.kind, a.profile, sha(token), prefixOf(token), now());
    setGrants(id, a.grants);
  });
  trace(YOU, "agent.create", id, "ok", null, a.name);
  return { agent: getAgent(id)!, token };
}

export function updateAgent(id: string, p: { name?: string; grants?: Grant[]; skills?: string[]; auto_accept?: boolean }) {
  const a = getAgent(id);
  if (!a) throw httpErr(404, "No such agent");
  // Pitcrew members already have their own rule (clean turns go straight in), and the link never proposes.
  if (p.auto_accept && (a.kind === "pitcrew" || a.link)) throw httpErr(400, "Pitcrew members follow Pitcrew's own rule");
  tx(() => {
    if (p.name !== undefined) run("UPDATE agents SET name=? WHERE id=?", p.name, id);
    if (p.skills !== undefined) run("UPDATE agents SET skills=? WHERE id=?", JSON.stringify(p.skills), id);
    if (p.grants !== undefined) setGrants(id, p.grants);
    if (p.auto_accept !== undefined) run("UPDATE agents SET auto_accept=? WHERE id=?", p.auto_accept ? 1 : 0, id);
  });
  trace(YOU, "agent.update", id, "ok", null, p.auto_accept !== undefined ? `auto_accept=${p.auto_accept}` : null);
  return getAgent(id)!;
}

export function rotateToken(id: string): NewToken {
  const a = getAgent(id);
  if (!a) throw httpErr(404, "No such agent");
  if (a.revoked) throw httpErr(409, "Agent is revoked");
  const token = newToken();
  run("UPDATE agents SET token_hash=?, token_prefix=? WHERE id=?", sha(token), prefixOf(token), id);
  trace(YOU, "agent.token", id);
  return { agent: getAgent(id)!, token };
}

export function revokeAgent(id: string) {
  if (!getAgent(id)) throw httpErr(404, "No such agent");
  // The hash is replaced too, so a revoked token can't match even if the revoked flag were ever ignored.
  run("UPDATE agents SET revoked=1, token_hash=? WHERE id=?", `revoked:${randomBytes(16).toString("hex")}`, id);
  trace(YOU, "agent.revoke", id);
  return getAgent(id)!;
}

// Per MCP request: one indexed lookup plus a last_used_at write at most once a minute.
export function authenticate(header: string | undefined): Agent | null {
  const m = /^Bearer (eg_[A-Za-z0-9_-]{43})$/.exec(header || "");
  if (!m) return null;
  const h = sha(m[1]), r = one("SELECT * FROM agents WHERE token_hash=? AND revoked=0", h);
  if (!r || !timingSafeEqual(Buffer.from(r.token_hash), Buffer.from(h))) return null;
  if (!r.last_used_at || now() - r.last_used_at > 60000) run("UPDATE agents SET last_used_at=? WHERE id=?", now(), r.id);
  return toAgent(r);
}

export const readScopes = (a: Agent): Scope[] => a.grants.filter((g) => g.read && g.scope !== "private").map((g) => g.scope);
export const canPropose = (a: Agent, s: Scope) => s !== "private" && a.grants.some((g) => g.scope === s && g.write === "propose");
