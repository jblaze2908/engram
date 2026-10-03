// Artifact lists that stay fast however many files exist: filters and full-text search run in SQL, pages are keyset
// cursors (at, id). Shared by the web app's Artifacts screen and Pitcrew's Library (/link/artifacts).
// Per view: one page query, one filtered count, and a few counts over the docs_kind index.
import type { ArtifactFilter, ArtifactPage, ArtifactType } from "../../shared/types.js";
import { one, all } from "../db.js";
import { artifacts } from "../store.js";
import { ftsQuery } from "../search.js";

const CUR_MIME = "COALESCE(json_extract(data,'$.versions[#-1].mime'), json_extract(data,'$.mime'), '')";
export const PUBLIC = "id IN (SELECT artifact_id FROM artifact_links WHERE public=1)";
export const WAITING = `(id IN (SELECT source_ref FROM proposals WHERE kind='share' AND status='open') AND NOT ${PUBLIC})`;
export const TYPES: Record<ArtifactType, string> = {
  page: `(${CUR_MIME} LIKE 'text/%' OR ${CUR_MIME} IN ('application/json','image/svg+xml'))`, pdf: `${CUR_MIME}='application/pdf'`,
  image: `(${CUR_MIME} LIKE 'image/%' AND ${CUR_MIME}!='image/svg+xml')`, other: "",
};
TYPES.other = `NOT (${TYPES.page} OR ${TYPES.pdf} OR ${TYPES.image})`;
// Who published it: the agent, else you, else Engram itself (people briefs).
export const PUBLISHER = "COALESCE(json_extract(data,'$.source.agent'), CASE json_extract(data,'$.source.kind') WHEN 'you' THEN 'you' ELSE 'engram' END)";

type Sql = { where: string[]; args: (string | number)[] };
/** Adds the filters (not the cursor) to a query; false when the search can't match anything. */
export function filtered(base: Sql, f: Omit<ArtifactFilter, "cursor" | "limit">): Sql | false {
  const where = [...base.where], args = [...base.args];
  if (f.by) { where.push(`${PUBLISHER}=?`); args.push(f.by); }
  if (f.status) where.push(f.status === "public" ? PUBLIC : f.status === "waiting" ? WAITING : `NOT ${PUBLIC} AND NOT ${WAITING}`);
  if (f.kind) { where.push("json_extract(data,'$.kind')=?"); args.push(f.kind); }
  if (f.type) where.push(TYPES[f.type]);
  if (f.scope) { where.push("scope=?"); args.push(f.scope); }
  if (f.area) { where.push("area=?"); args.push(f.area); }
  if (f.q) {
    // Every word narrows: a newest-first list isn't ranked, so OR would only widen it.
    const match = ftsQuery(f.q, true);
    if (!match) return false;
    where.push("id IN (SELECT id FROM docs_fts WHERE docs_fts MATCH ?)"); args.push(match);
  }
  return { where, args };
}

export function pageOf(s: Sql, cursor: ArtifactFilter["cursor"], limit = 40) {
  const where = [...s.where], args = [...s.args];
  if (cursor) { where.push("(at < ? OR (at = ? AND id < ?))"); args.push(cursor.at, cursor.at, cursor.id); }
  const n = Math.min(Math.max(limit, 1), 100);
  const rows = all<{ id: string; path: string; data: string; at: number }>(`SELECT id, path, data, at FROM docs WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`, ...args, n + 1);
  const page = rows.slice(0, n), last = page.at(-1);
  return { rows: page, next: rows.length > n && last ? `${last.at}:${last.id}` : null };
}

export const count = (s: Sql, extra?: string) => one<{ n: number }>(`SELECT COUNT(*) n FROM docs WHERE ${[...s.where, ...(extra ? [extra] : [])].join(" AND ")}`, ...s.args)!.n;

/** The web app's list: every active artifact, private scope included (only you have a session). */
export function findArtifacts(f: ArtifactFilter = {}): ArtifactPage {
  const base: Sql = { where: ["kind='artifact'", "status='active'"], args: [] };
  const names = new Map(all<{ id: string; name: string }>("SELECT id, name FROM agents").map((a) => [a.id, a.name]));
  const publishers = all<{ key: string; n: number }>(`SELECT ${PUBLISHER} key, COUNT(*) n FROM docs WHERE ${base.where.join(" AND ")} GROUP BY key ORDER BY n DESC`)
    .map((p) => ({ ...p, label: p.key === "you" ? "You" : p.key === "engram" ? "Engram" : names.get(p.key) ?? "A removed agent" }));
  const counts = { all: count(base), public: count(base, PUBLIC), waiting: count(base, WAITING) };
  const s = filtered(base, f);
  if (!s) return { artifacts: [], next: null, total: 0, counts, publishers };
  const { rows, next } = pageOf(s, f.cursor, f.limit);
  return { artifacts: artifacts(rows), next, total: f.cursor ? -1 : count(s), counts, publishers };
}
