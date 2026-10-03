import { createHash } from "node:crypto";
import type { Scope, Source } from "../shared/types.js";
import { all, one, run, json, marks } from "./db.js";
import { MODEL_REV, loadModel, embed, dot } from "./embed.js";
import { privateUrl, publicUrl } from "./artifacts/shares.js";

export const SEARCHABLE = ["memory", "entity", "artifact", "episode", "skill", "profile"] as const;
export type SearchKind = (typeof SEARCHABLE)[number];
export type Hit = { kind: SearchKind; id: string; title: string; snippet: string; area: string; scope: Scope; source: Source | null; valid_until: string | null; url?: string; public_url?: string | null };

const RRF_K = 60, POOL = 100;
// potion-base-8M cosine under 0.2 is mostly unrelated text (swept on tests/search-eval.json: 0.15–0.25 all beat BM25).
export const FLOOR = 0.2;

export function ftsQuery(q: string, every = false) {
  const toks = (q.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);
  return toks.length ? toks.map((t) => `"${t}"*`).join(every ? " AND " : " OR ") : null;
}

/** Reciprocal rank fusion: each list adds 1 / (60 + rank) to an item's score. */
export function fuse<T>(lists: T[][]): T[] {
  const score = new Map<T, number>();
  for (const l of lists) l.forEach((x, i) => score.set(x, (score.get(x) ?? 0) + 1 / (RRF_K + i + 1)));
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)!);
}

// Every stored vector, loaded on the first query so a search never reads blobs; the indexer keeps it current.
let cache: Map<string, Float32Array> | null = null;
const f32 = (u: Uint8Array) => (u.byteOffset % 4 ? new Float32Array(u.slice().buffer) : new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4));
const vectors = () => (cache ??= new Map(all<{ id: string; v: Uint8Array }>("SELECT id, v FROM vecs").map((r) => [r.id, f32(r.v)])));

/** Indexer hook per written doc: one hash lookup, and an embed only when the model or the text changed. */
export function putVec(id: string, title: string, body: string) {
  if (!loadModel()) return;
  // A title alone (an empty profile file, a bare name) embeds as noise; BM25 still finds it.
  if (!body.trim()) return dropVec(id);
  const text = `${title}\n${body}`.slice(0, 4000), hash = createHash("sha256").update(`${MODEL_REV}\0${text}`).digest("base64url");
  if (one<{ hash: string }>("SELECT hash FROM vecs WHERE id=?", id)?.hash === hash) return;
  const v = embed(text);
  if (!v) return dropVec(id);
  run("INSERT INTO vecs(id,hash,v) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, v=excluded.v", id, hash, new Uint8Array(v.buffer));
  cache?.set(id, v);
}
export function dropVec(id: string) { run("DELETE FROM vecs WHERE id=?", id); cache?.delete(id); }

function nearest(qv: Float32Array, ids: string[]) {
  const vs = vectors(), out: { id: string; s: number }[] = [];
  for (const id of ids) { const v = vs.get(id); if (v) { const s = dot(qv, v); if (s >= FLOOR) out.push({ id, s }); } }
  return out.sort((a, b) => b.s - a.s).slice(0, POOL).map((x) => x.id);
}

// Tool descriptions change rarely; embedded once per text so ranking tools costs one query embed plus dot products.
const textVecs = new Map<string, Float32Array | null>();
/** Indexes of texts with cosine ≥ FLOOR to the query, best first; [] without a model. */
export function nearestTexts(query: string, texts: string[]) {
  const qv = embed(query);
  if (!qv) return [];
  if (textVecs.size > 5000) textVecs.clear();
  return texts.map((t, i) => {
    if (!textVecs.has(t)) textVecs.set(t, embed(t));
    const v = textVecs.get(t);
    return { i, s: v ? dot(qv, v) : -1 };
  }).filter((x) => x.s >= FLOOR).sort((a, b) => b.s - a.s).map((x) => x.i);
}

const excerpt = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > 120 ? `${t.slice(0, 120)}…` : t; };
// An artifact hit carries its links, so an agent can hand the user one without a second call (one share lookup per hit).
const toHit = (r: any): Hit => ({ kind: r.kind, id: r.id, title: r.title, snippet: r.snip || r.title, area: r.area, scope: r.scope, source: json<{ source?: Source }>(r.data, {}).source ?? null, valid_until: r.valid_until ?? null,
  ...(r.kind === "artifact" ? { url: privateUrl(r.id), public_url: publicUrl(r.id) } : {}) });

/** BM25 over FTS5, fused with cosine over the caller's readable docs when the model is loaded (lexical forces BM25 alone). */
export function search(f: { query: string; kind?: SearchKind; area?: string; project?: string; scopes?: Scope[]; limit?: number; lexical?: boolean }) {
  const match = ftsQuery(f.query), limit = f.limit ?? 10;
  if (!match) return { hits: [] as Hit[], withheld: 0 };
  const where = [`d.kind IN (${marks(SEARCHABLE.length)})`, "d.status='active'"], args: (string | number)[] = [...SEARCHABLE];
  if (f.kind) { where.push("d.kind=?"); args.push(f.kind); }
  if (f.area) { where.push("d.area=?"); args.push(f.area); }
  if (f.project) { where.push("d.project=?"); args.push(f.project); }
  const filter = where.join(" AND "), scoped = f.scopes ? ` AND d.scope IN (${marks(f.scopes.length) || "''"})` : "", sargs = f.scopes || [];
  const qv = f.lexical ? null : embed(f.query);
  const fts = `FROM docs_fts JOIN docs d ON d.id=docs_fts.id WHERE docs_fts MATCH ? AND ${filter}`, cols = "d.id, d.kind, d.title, d.area, d.scope, d.valid_until, d.data";
  const snip = "snippet(docs_fts, 2, '', '', '…', 16) snip";
  if (!qv) return { hits: all(`SELECT ${cols}, ${snip} ${fts}${scoped} ORDER BY bm25(docs_fts, 0, 3.0, 1.0) LIMIT ?`, match, ...args, ...sargs, limit).map(toHit), withheld: withheld() };
  // Rank ids only; snippets (the costly part) are cut for the final page.
  const lex = all<{ id: string }>(`SELECT d.id ${fts}${scoped} ORDER BY bm25(docs_fts, 0, 3.0, 1.0) LIMIT ${POOL}`, match, ...args, ...sargs).map((r) => r.id);
  const near = nearest(qv, all<{ id: string }>(`SELECT d.id FROM docs d WHERE ${filter}${scoped}`, ...args, ...sargs).map((r) => r.id));
  const ids = fuse([lex, near]).slice(0, limit), inLex = new Set(lex), lexIds = ids.filter((id) => inLex.has(id)), rest = ids.filter((id) => !inLex.has(id));
  const byId = new Map<string, Hit>();
  if (lexIds.length) for (const r of all(`SELECT ${cols}, ${snip} ${fts} AND d.id IN (${marks(lexIds.length)})`, match, ...args, ...lexIds)) byId.set(r.id, toHit(r));
  if (rest.length) for (const r of all(`SELECT ${cols}, d.body FROM docs d WHERE d.id IN (${marks(rest.length)})`, ...rest)) byId.set(r.id, toHit({ ...r, snip: excerpt(r.body) }));
  return { hits: ids.map((id) => byId.get(id)!), withheld: withheld() };
  function withheld() { return f.scopes ? one<{ n: number }>(`SELECT COUNT(*) n ${fts} AND d.scope NOT IN (${marks(f.scopes.length) || "''"})`, match, ...args, ...sargs)!.n : 0; }
}
