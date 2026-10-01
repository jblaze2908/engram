// Typed reads over the index. Everything here is SQLite; nothing touches the vault or git.
import type { Memory, Entity, Artifact, Episode, Skill, ProfileFile, Area, Project, Scope } from "../shared/types.js";
import { one, all, json, marks, type Row } from "./db.js";

export type DocKind = "memory" | "entity" | "artifact" | "episode" | "skill" | "profile" | "area" | "project";
export type DocRow = { id: string; kind: DocKind; path: string; title: string; area: string; scope: Scope; status: string; data: string; at: number };

export const docById = (id: string) => one<DocRow>("SELECT * FROM docs WHERE id=?", id);
export const docData = <T>(r: { data: string }) => json<T>(r.data, {});

const readsFor = (ids: string[]) => ids.length
  ? new Map(all<{ memory_id: string; n: number }>(`SELECT memory_id, SUM(n) n FROM reads WHERE memory_id IN (${marks(ids.length)}) GROUP BY memory_id`, ...ids).map((r) => [r.memory_id, r.n]))
  : new Map<string, number>();
export function memories(rows: Row[]): Memory[] {
  const reads = readsFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...json<Memory>(r.data, {}), reads: reads.get(r.id) || 0 }));
}
export const memoryById = (id: string) => { const r = one("SELECT id,data FROM docs WHERE id=? AND kind='memory'", id); return r ? memories([r])[0] : null; };

export function listMemories(f: { status?: string; area?: string; ids?: string[]; entity?: string; scopes?: Scope[]; limit?: number }) {
  const where = ["d.kind='memory'"], args: (string | number)[] = [];
  if (f.status && f.status !== "all") { where.push("d.status=?"); args.push(f.status); }
  if (f.area) { where.push("d.area=?"); args.push(f.area); }
  if (f.ids) { where.push(`d.id IN (${marks(f.ids.length) || "''"})`); args.push(...f.ids); }
  if (f.entity) { where.push("EXISTS (SELECT 1 FROM json_each(d.data,'$.entities') e WHERE e.value=?)"); args.push(f.entity); }
  if (f.scopes) { where.push(`d.scope IN (${marks(f.scopes.length) || "''"})`); args.push(...f.scopes); }
  return memories(all(`SELECT d.id, d.data FROM docs d WHERE ${where.join(" AND ")} ORDER BY d.at DESC LIMIT ?`, ...args, f.limit ?? 200));
}

export function entities(rows: Row[]): Entity[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const counts = new Map(all<{ v: string; n: number }>(`SELECT e.value v, COUNT(*) n FROM docs d, json_each(d.data,'$.entities') e WHERE d.kind='memory' AND d.status='active' AND e.value IN (${marks(ids.length)}) GROUP BY e.value`, ...ids).map((r) => [r.v, r.n]));
  const held = new Map(all<{ v: string; n: number }>(`SELECT e.value v, COUNT(*) n FROM proposals p, json_each(p.data,'$.entities') e WHERE p.status='open' AND p.held=1 AND e.value IN (${marks(ids.length)}) GROUP BY e.value`, ...ids).map((r) => [r.v, r.n]));
  return rows.map((r) => { const e = json<Entity & { slug?: string }>(r.data, {}); delete e.slug; return { ...e, memories: counts.get(r.id) || 0, held: held.get(r.id) || 0 }; });
}
export function listEntities(f: { kind?: string; area?: string; scopes?: Scope[]; ids?: string[] } = {}) {
  const where = ["kind='entity'"], args: string[] = [];
  if (f.kind) { where.push("json_extract(data,'$.kind')=?"); args.push(f.kind); }
  if (f.area) { where.push("area=?"); args.push(f.area); }
  if (f.scopes) { where.push(`scope IN (${marks(f.scopes.length) || "''"})`); args.push(...f.scopes); }
  if (f.ids) { where.push(`id IN (${marks(f.ids.length) || "''"})`); args.push(...f.ids); }
  return entities(all(`SELECT id, data FROM docs WHERE ${where.join(" AND ")} ORDER BY title LIMIT 500`, ...args));
}

export function artifacts(rows: Row[]): Artifact[] {
  const mems = new Map<string, string[]>();
  if (rows.length) for (const m of all<{ id: string; ref: string }>(`SELECT id, source_ref ref FROM docs WHERE kind='memory' AND source_ref IN (${marks(rows.length)})`, ...rows.map((r) => r.id)))
    mems.set(m.ref, [...(mems.get(m.ref) || []), m.id]);
  return rows.map((r) => { const a = json<Artifact & { ext?: string }>(r.data, {}); delete a.ext; return { ...a, memories: mems.get(r.id) || [] }; });
}
export function listArtifacts(f: { kind?: string; area?: string; scopes?: Scope[] } = {}) {
  const where = ["kind='artifact'"], args: string[] = [];
  if (f.kind) { where.push("json_extract(data,'$.kind')=?"); args.push(f.kind); }
  if (f.area) { where.push("area=?"); args.push(f.area); }
  if (f.scopes) { where.push(`scope IN (${marks(f.scopes.length) || "''"})`); args.push(...f.scopes); }
  return artifacts(all(`SELECT id, data FROM docs WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT 500`, ...args));
}

export const episodes = (where: string, ...args: (string | number)[]) =>
  all(`SELECT data FROM docs WHERE kind='episode' ${where} ORDER BY at DESC LIMIT 200`, ...args).map((r) => json<Episode>(r.data, {}));

export function skills(names?: string[]): Skill[] {
  const rows = names ? all(`SELECT data FROM docs WHERE kind='skill' AND title IN (${marks(names.length) || "''"})`, ...names) : all("SELECT data FROM docs WHERE kind='skill' ORDER BY title");
  const agents = all<{ name: string; skills: string }>("SELECT name, skills FROM agents WHERE revoked=0");
  const weekAgo = Date.now() - 7 * 86400000;
  return rows.map((r) => {
    const s = json<Skill>(r.data, {});
    return {
      ...s, agents: agents.filter((a) => json<string[]>(a.skills, []).includes(s.name)).map((a) => a.name),
      uses7d: one<{ n: number }>("SELECT COUNT(*) n FROM trace WHERE at>=? AND target=?", weekAgo, `skill:${s.name}`)!.n,
      pending: one<{ n: number }>("SELECT COUNT(*) n FROM proposals WHERE status='open' AND kind='skill' AND title=?", s.name)!.n,
    };
  });
}

export const profileFiles = () => all("SELECT data FROM docs WHERE kind='profile' ORDER BY title").map((r) => json<ProfileFile>(r.data, {}));
export const areaRecord = (slug: string) => { const r = one("SELECT data FROM docs WHERE id=?", `area:${slug}`); return r ? json<{ slug: string; name: string; summary: string }>(r.data, {}) : null; };
export const areaExists = (slug: string) => !!one("SELECT 1 FROM docs WHERE id=?", `area:${slug}`);

const AREA_ORDER = ["home", "money", "health", "car", "travel", "building"];
export function areas(): Area[] {
  // The seeded areas keep the designed order; areas you add sort after them by name.
  const rank = (s: string) => { const i = AREA_ORDER.indexOf(s); return i < 0 ? AREA_ORDER.length : i; };
  const rows = all("SELECT data FROM docs WHERE kind='area' ORDER BY title").map((r) => json<{ slug: string; name: string; summary: string }>(r.data, {}))
    .sort((a, b) => rank(a.slug) - rank(b.slug));
  const count = (sql: string, ...a: string[]) => new Map(all<{ area: string; n: number }>(sql, ...a).map((r) => [r.area, r.n]));
  const mem = count("SELECT area, COUNT(*) n FROM docs WHERE kind='memory' AND status='active' GROUP BY area");
  const files = count("SELECT area, COUNT(*) n FROM docs WHERE kind='artifact' GROUP BY area");
  const people = count("SELECT area, COUNT(*) n FROM docs WHERE kind='entity' AND json_extract(data,'$.kind')='person' GROUP BY area");
  const held = count("SELECT area, COUNT(*) n FROM proposals WHERE status='open' AND held=1 GROUP BY area");
  const soon = count(`SELECT area, COUNT(*) n FROM docs WHERE kind='memory' AND status='active' AND valid_until IS NOT NULL AND valid_until<=? GROUP BY area`, new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  return rows.map((a) => ({ ...a, counts: { memories: mem.get(a.slug) || 0, files: files.get(a.slug) || 0, people: people.get(a.slug) || 0 }, held: held.get(a.slug) || 0, runningOut: soon.get(a.slug) || 0 }));
}
export const projects = (area?: string) => (area ? all("SELECT data FROM docs WHERE kind='project' AND area=? ORDER BY title", area) : all("SELECT data FROM docs WHERE kind='project' ORDER BY title")).map((r) => json<Project>(r.data, {}));
