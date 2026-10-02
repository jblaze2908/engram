// A linked crew member's own memories (remember / forget in Pitcrew), its journal entries and the connections it can be
// given at hire. "Own" means the memory's source.agent is the member's Engram agent, so a member never edits yours.
import type { Agent, LinkConnection, LinkMemory, Memory, Source } from "../../shared/types.js";
import { now, uid, norm, httpErr } from "../config.js";
import { one, all, type Row } from "../db.js";
import { readDoc, writeDoc, commit, withVault } from "../vault.js";
import { indexPaths } from "../index.js";
import { memoryFm, memoryPath, propose, forgetMemory, type ProposeResult } from "../proposals.js";
import { docById, memories } from "../store.js";
import { listConnections } from "../gateway/store.js";
import { trace } from "../trace.js";
import { actorOf, type Member } from "./members.js";

export const TAINTED = "Saved during a Pitcrew turn that read untrusted content";
const EARLIEST = Date.UTC(2000, 0, 1);
const when = (t: number | undefined) => (t && t >= EARLIEST && t <= now() ? t : now());
const short = (s: string) => s.replace(/\s+/g, " ").slice(0, 60);

const ownRows = (m: Member, limit: number) =>
  all<Row>("SELECT id, path, data FROM docs WHERE kind='memory' AND status='active' AND json_extract(data,'$.source.agent')=? ORDER BY at DESC LIMIT ?", m.agent.id, limit);
export const ownBrief = (m: Member) => memories(ownRows(m, 60)).map((x) => ({ id: x.id, text: x.text }));
export const ownMemories = (m: Member): LinkMemory[] =>
  memories(ownRows(m, 200)).map((x) => ({ id: x.id, text: x.text, scope: x.scope, area: x.area, created_at: x.created_at, source: x.source.label }));
const own = (m: Member, id: string) => { const d = docById(id); return d && d.kind === "memory" && JSON.parse(d.data)?.source?.agent === m.agent.id ? d : null; };

type Remember = { text: string; supersedes?: string | null; ref?: string; untrusted?: boolean; by?: "member" | "driver"; valid_until?: string | null };
// Clean turn: accepted directly, like the one-shot import (Pitcrew is trusted and you saw it said in the thread).
// Tainted turn, or a member rewriting something you added: the ordinary write path, which holds it for you.
export async function remember(link: Agent, m: Member, b: Remember): Promise<ProposeResult> {
  const text = b.text.trim(), driver = b.by === "driver";
  const old = b.supersedes ? own(m, b.supersedes) : null;
  if (b.supersedes && (!old || old.status !== "active")) throw httpErr(400, "It can only replace one of this member's own active memories");
  const yours = old && JSON.parse(old.data)?.source?.kind === "you";
  if (b.untrusted || (yours && !driver)) {
    const r = await propose(m.agent, { kind: "memory", text, area: m.area, scope: m.scope, supersedes: b.supersedes ?? null, valid_until: b.valid_until ?? null, source: { kind: "agent", label: `pitcrew:${m.agent.name}`, ref: b.ref ?? null } }, b.untrusted ? [TAINTED] : []);
    trace(actorOf(link), "link.remember", r.id, r.status === "accepted" ? "ok" : "held", m.scope, `${m.agent.name}: ${short(text)}`);
    return r;
  }
  return withVault(async () => {
    const dup = one<{ id: string }>("SELECT id FROM docs WHERE kind='memory' AND status='active' AND norm=? AND area=? AND scope=?", norm(text), m.area, m.scope);
    if (dup) return { status: "accepted" as const, id: dup.id, reasons: [] };
    const t = now();
    const source: Source = driver ? { kind: "you", label: "Added in Pitcrew", agent: m.agent.id, ref: b.ref ?? null, at: t } : { kind: "agent", label: `pitcrew:${m.agent.name}`, agent: m.agent.id, ref: b.ref ?? null, at: t };
    const mem: Omit<Memory, "reads"> = {
      id: uid("m"), text, area: m.area, project: null, entities: [], scope: m.scope, source, trust: "trusted", status: "active",
      observed_at: t, valid_from: null, valid_until: b.valid_until ?? null, supersedes: old?.id ?? null, superseded_by: null, created_at: t, accepted_at: t,
    };
    const paths = [memoryPath(mem)];
    if (old) {
      const doc = readDoc(old.path);
      if (!doc || doc.fm.status !== "active") throw httpErr(409, "The memory it replaces has changed");
      writeDoc(old.path, { fm: { ...doc.fm, status: "superseded", superseded_by: mem.id }, body: doc.body });
      paths.push(old.path);
    }
    writeDoc(paths[0], { fm: memoryFm(mem), body: text });
    await commit(paths, `memory: ${short(text)} (pitcrew:${m.agent.name})`);
    indexPaths(paths);
    trace(actorOf(link), "link.remember", mem.id, "ok", m.scope, `${m.agent.name}${old ? ` · replaces ${old.id}` : ""}`);
    return { status: "accepted" as const, id: mem.id, reasons: [] };
  });
}

export async function forgetOwn(link: Agent, m: Member, id: string) {
  if (!own(m, id)) throw httpErr(404, "No such memory");
  await forgetMemory(id, actorOf(link));
  return { ok: true as const };
}

// Episodes describe, they don't assert: accepted without review, and nothing in one becomes a memory.
export function episode(link: Agent, m: Member, b: { text: string; at?: number; outputs?: { kind: string; ref: string; label: string }[] }) {
  return withVault(async () => {
    const t = when(b.at), d = new Date(t), id = uid("j");
    const rel = `journal/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${id}.md`;
    // The member's scope, so a Health member's sessions are searchable only by agents granted Health.
    writeDoc(rel, { fm: { id, at: t, who: m.agent.name, area: m.area, scope: m.scope, project: null, outputs: b.outputs || [] }, body: b.text.trim() });
    await commit([rel], `journal: ${short(b.text)}`);
    indexPaths([rel]);
    trace(actorOf(link), "link.episode", id, "ok", m.scope, m.agent.name);
    return { status: "accepted" as const, id };
  });
}

export const linkConnections = (): LinkConnection[] => listConnections().map((c) => ({
  id: c.id, name: c.name, status: c.status, detail: c.detail,
  read: c.tools.filter((t) => t.kind === "read").length, write: c.tools.filter((t) => t.kind === "write").length,
}));
