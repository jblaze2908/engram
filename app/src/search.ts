// Full-text search over the index (FTS5, bm25 with titles weighted up). Scope filtering happens in SQL.
import type { Scope, Source } from "../shared/types.js";
import { all, one, json, marks } from "./db.js";

export const SEARCHABLE = ["memory", "entity", "artifact", "episode", "skill", "profile"] as const;
export type SearchKind = (typeof SEARCHABLE)[number];
export type Hit = { kind: SearchKind; id: string; title: string; snippet: string; area: string; scope: Scope; source: Source | null; valid_until: string | null };

// User text never reaches MATCH syntax: only letter/digit runs survive, each quoted as a prefix term.
export function ftsQuery(q: string) {
  const toks = (q.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);
  return toks.length ? toks.map((t) => `"${t}"*`).join(" OR ") : null;
}

export function search(f: { query: string; kind?: SearchKind; area?: string; project?: string; scopes?: Scope[]; limit?: number }) {
  const match = ftsQuery(f.query);
  if (!match) return { hits: [] as Hit[], withheld: 0 };
  const where = ["docs_fts MATCH ?", `d.kind IN (${marks(SEARCHABLE.length)})`, "d.status='active'"], args: (string | number)[] = [match, ...SEARCHABLE];
  if (f.kind) { where.push("d.kind=?"); args.push(f.kind); }
  if (f.area) { where.push("d.area=?"); args.push(f.area); }
  if (f.project) { where.push("d.project=?"); args.push(f.project); }
  const base = `FROM docs_fts JOIN docs d ON d.id=docs_fts.id WHERE ${where.join(" AND ")}`;
  const scoped = f.scopes ? ` AND d.scope IN (${marks(f.scopes.length) || "''"})` : "";
  const sargs = f.scopes || [];
  const hits = all(`SELECT d.id, d.kind, d.title, d.area, d.scope, d.valid_until, d.data, snippet(docs_fts, 2, '', '', '…', 16) snip ${base}${scoped} ORDER BY bm25(docs_fts, 0, 3.0, 1.0) LIMIT ?`, ...args, ...sargs, f.limit ?? 10)
    .map((r): Hit => ({ kind: r.kind, id: r.id, title: r.title, snippet: r.snip || r.title, area: r.area, scope: r.scope, source: json<{ source?: Source }>(r.data, {}).source ?? null, valid_until: r.valid_until ?? null }));
  const withheld = f.scopes ? one<{ n: number }>(`SELECT COUNT(*) n ${base} AND d.scope NOT IN (${marks(f.scopes.length) || "''"})`, ...args, ...sargs)!.n : 0;
  return { hits, withheld };
}
