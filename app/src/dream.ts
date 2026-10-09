// Dreaming: a nightly pass that proposes merging duplicates, superseding a value a newer memory contradicts, and retiring
// memories whose valid_until has passed. It only proposes; the inbox decides. Model: the local embedding model finds
// candidate pairs, a lexical judge decides, and anything it can't call cleanly is left alone.
import type { Proposal, Scope, Source } from "../shared/types.js";
import { now, uid, norm, httpErr, dayKey } from "./config.js";
import { one, all, run, json, getSetting, setSetting } from "./db.js";
import { loadModel, dot, MODEL_DIR } from "./embed.js";
import { readDoc, writeDoc } from "./vault.js";
import { docById } from "./store.js";
import { trace, type Actor } from "./trace.js";

export const DREAM_HOUR = 3;
// Per night: fresh memories examined, proposals made. Whatever is left waits behind the watermark for tomorrow.
export const BATCH = 200, MAX_PROPOSALS = 20;
// potion-base-8M cosine: the gate-code contradiction pair measured 0.705, unrelated memories under 0.2.
const CANDIDATE = 0.6, DUP = 0.85, TOP = 8;
const ENGRAM: Actor = { id: null, name: "engram" };
const SOURCE: Source = { kind: "other", label: "Engram's nightly tidy-up", agent: null, ref: null, at: null };

export type DreamAction = "merge" | "supersede" | "retire";
type Mem = { id: string; path: string; text: string; scope: Scope; area: string; source: Source; trust: string; observed_at: number; valid_until: string | null; mtime: number };
type Mark = { mtime: number; id: string; day: string };
export type DreamResult = { skipped: string | null; scanned: number; expired: number; proposed: number; more: boolean };

// ---------- the judge ----------

const STOP = new Set("a an the is are was were be been am my our your his her their its it this that these those of to in on at for with and or by from as into about every each has have had do does will shall would should can could".split(" "));
const MONTHS = ["jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
// "may" is left out: as a word it is more often the verb than the month.
const CAL = new RegExp(`^(${MONTHS.join("|")}|${DAYS.join("|")})`);
const CAL_WORD = /^(january|february|march|april|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)$/;
const stem = (w: string) => w.length > 5 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 4 && w.endsWith("ed") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;

/** Splits a claim into content words (stemmed, no stopwords) and values (numbers, dates, months, weekdays). */
export function claimParts(text: string) {
  const words = new Set<string>(), values = new Set<string>();
  const toks = text.toLowerCase().normalize("NFKD").replace(/\p{Mn}/gu, "").match(/\d[\d,.:/-]*\d|\d|\p{L}+/gu) || [];
  for (const t of toks) {
    if (/\d/.test(t)) values.add(t.replace(/,/g, ""));
    else if (CAL_WORD.test(t)) values.add(t.match(CAL)![1]);
    else if (t.length > 1 && !STOP.has(t)) words.add(stem(t));
  }
  return { words, values };
}
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const jaccard = (a: Set<string>, b: Set<string>) => { const i = [...a].filter((x) => b.has(x)).length; return i / (a.size + b.size - i || 1); };
const rank = (m: Mem) => (m.source.kind === "you" ? 2 : m.trust === "trusted" ? 1 : 0);

export type Verdict = { action: "merge" | "supersede"; keep: Mem; drop: Mem; why: string } | null;
/** Two memories of one scope: the same claim, one value replacing another, or null when it can't tell. */
export function judge(a: Mem, b: Mem, cos: number): Verdict {
  if (a.scope !== b.scope) return null;
  const pa = claimParts(a.text), pb = claimParts(b.text);
  if (pa.words.size + pb.words.size < 4) return null;
  // Same values, nearly the same words: one claim said twice. Keep yours, then trusted, then the fuller, then the newer.
  if (cos >= DUP && same(pa.values, pb.values) && jaccard(pa.words, pb.words) >= 0.75) {
    const [keep, drop] = [a, b].sort((x, y) => rank(y) - rank(x) || claimParts(y.text).words.size - claimParts(x.text).words.size || y.observed_at - x.observed_at || (x.id < y.id ? -1 : 1));
    return { action: "merge", keep, drop, why: `It says the same as “${clip(keep.text)}”` };
  }
  // Identical words, different values: the newer value replaces the older, unless only an untrusted source says so.
  if (pa.values.size && pb.values.size && !same(pa.values, pb.values) && same(pa.words, pb.words) && pa.words.size >= 2 && a.observed_at !== b.observed_at) {
    const [keep, drop] = a.observed_at > b.observed_at ? [a, b] : [b, a];
    if (keep.trust === "untrusted" && drop.trust !== "untrusted") return null;
    return { action: "supersede", keep, drop, why: `A newer memory gives a different value: “${clip(keep.text)}”` };
  }
  return null;
}
const clip = (s: string, n = 120) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ---------- the pass ----------

const toMem = (r: { id: string; path: string; data: string; mtime: number }): Mem => {
  const d = json<Record<string, any>>(r.data, {});
  return { id: r.id, path: r.path, text: d.text || "", scope: d.scope, area: d.area || "home", source: d.source || { kind: "other", label: "" }, trust: d.trust, observed_at: d.observed_at || 0, valid_until: d.valid_until ?? null, mtime: r.mtime };
};
const f32 = (u: Uint8Array) => (u.byteOffset % 4 ? new Float32Array(u.slice().buffer) : new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4));

// Every earlier tidy-up, read once per pass: a pair proposed before (open or decided, either way round) is never
// proposed again, and a memory named in an open one waits for that decision so accepted proposals never chain.
function history() {
  const pairs = new Set<string>(), open = new Set<string>();
  for (const r of all<{ status: string; d: string; k: string | null }>("SELECT status, json_extract(data,'$.drop') d, json_extract(data,'$.keep') k FROM proposals WHERE kind='dream'")) {
    pairs.add(`${r.d}|${r.k ?? ""}`);
    if (r.status === "open") { open.add(r.d); if (r.k) open.add(r.k); }
  }
  return { pairs, open, seen: (drop: string, keep: string | null) => pairs.has(`${drop}|${keep ?? ""}`) || (!!keep && pairs.has(`${keep}|${drop}`)) };
}
type History = ReturnType<typeof history>;

function proposeTidy(h: History, action: DreamAction, drop: Mem, keep: Mem | null, why: string, t: number) {
  h.pairs.add(`${drop.id}|${keep?.id ?? ""}`); h.open.add(drop.id); if (keep) h.open.add(keep.id);
  const reasons = [why];
  if (drop.source.kind === "you") reasons.push(action === "retire" ? "It would retire something you added yourself" : "It would replace something you added yourself");
  const title = { merge: "Duplicate", supersede: "Newer value", retire: "Ran out" }[action] + `: ${clip(drop.text, 100)}`;
  const text = keep ? keep.text : `Retire it: valid until ${drop.valid_until}, now past`;
  const data = { action, drop: drop.id, keep: keep?.id ?? null, text, drop_norm: norm(drop.text), keep_norm: keep ? norm(keep.text) : null };
  // Never held: a tidy-up is low priority and shouldn't push a notification at 3 am. Scope and area are the dropped memory's.
  run("INSERT INTO proposals(id,kind,agent,title,scope,area,data,norm,source,source_ref,reasons,held,replaces,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    uid("p"), "dream", "engram", title, drop.scope, drop.area, JSON.stringify(data), null, JSON.stringify({ ...SOURCE, at: t }), null,
    JSON.stringify(reasons), 0, JSON.stringify({ id: drop.id, text: drop.text, source: drop.source }), "open", t);
}

/**
 * One pass. Per night: one query for memories past the watermark (≤ batch), one per scope they touch for that scope's
 * active memories and stored vectors, one for earlier tidy-ups, then batch × pool dot products (256 dims). No vault
 * writes, no network.
 */
export function dream(o: { t?: number; batch?: number; max?: number } = {}): DreamResult {
  const t = o.t ?? now(), batch = o.batch ?? BATCH, max = o.max ?? MAX_PROPOSALS;
  if (!loadModel()) {
    console.log(`dream: no embedding model in ${MODEL_DIR}; nothing done (set ENGRAM_MODEL_DIR or run scripts/fetch-model.sh)`);
    return { skipped: "no embedding model", scanned: 0, expired: 0, proposed: 0, more: false };
  }
  const today = dayKey(t), wm: Mark = { mtime: 0, id: "", day: "", ...json<Partial<Mark>>(getSetting("dream_watermark"), {}) };
  const h = history();
  let proposed = 0, expired = 0, more = false;

  // Run-outs since the last pass, whether or not the memory changed: time moved, the file didn't.
  const ran = all<{ id: string; path: string; data: string; mtime: number }>(
    "SELECT id, path, data, mtime FROM docs WHERE kind='memory' AND status='active' AND valid_until IS NOT NULL AND valid_until<? AND valid_until>=? ORDER BY valid_until, id", today, wm.day).map(toMem);
  for (const m of ran) {
    if (proposed >= max) { more = true; break; }
    expired++;
    if (h.seen(m.id, null) || h.open.has(m.id)) continue;
    proposeTidy(h, "retire", m, null, `Its valid-until date, ${m.valid_until}, has passed`, t);
    proposed++;
  }
  if (!more) wm.day = today;

  const fresh = all<{ id: string; path: string; data: string; mtime: number }>(
    "SELECT id, path, data, mtime FROM docs WHERE kind='memory' AND status='active' AND (mtime>? OR (mtime=? AND id>?)) ORDER BY mtime, id LIMIT ?", wm.mtime, wm.mtime, wm.id, batch + 1).map(toMem);
  if (fresh.length > batch) { fresh.length = batch; more = true; }
  const pools = new Map<Scope, { m: Mem; v: Float32Array }[]>();
  // Scope is the boundary: a memory is only ever compared with memories of its own scope.
  const pool = (s: Scope) => pools.get(s) ?? pools.set(s, all<{ id: string; path: string; data: string; mtime: number; v: Uint8Array }>(
    "SELECT d.id, d.path, d.data, d.mtime, v.v FROM docs d JOIN vecs v ON v.id=d.id WHERE d.kind='memory' AND d.status='active' AND d.scope=?", s).map((r) => ({ m: toMem(r), v: f32(r.v) }))).get(s)!;

  let scanned = 0;
  for (const f of fresh) {
    if (proposed >= max) { more = true; break; }
    scanned++;
    Object.assign(wm, { mtime: f.mtime, id: f.id });
    if (h.open.has(f.id)) continue;
    if (f.valid_until && f.valid_until < today) {
      if (!h.seen(f.id, null)) { proposeTidy(h, "retire", f, null, `Its valid-until date, ${f.valid_until}, has passed`, t); proposed++; }
      continue;
    }
    const p = pool(f.scope), self = p.find((x) => x.m.id === f.id);
    if (!self) continue;
    const near = p.filter((x) => x.m.id !== f.id).map((x) => ({ m: x.m, s: dot(self.v, x.v) })).filter((x) => x.s >= CANDIDATE).sort((a, b) => b.s - a.s).slice(0, TOP);
    for (const c of near) {
      if (h.open.has(c.m.id)) continue;
      const v = judge(f, c.m, c.s);
      if (!v || h.seen(v.drop.id, v.keep.id)) continue;
      proposeTidy(h, v.action, v.drop, v.keep, v.why, t);
      proposed++;
      break;
    }
  }
  setSetting("dream_watermark", JSON.stringify(wm));
  trace(ENGRAM, "dream", `${proposed} proposed`, "ok", null, `${scanned} new or changed, ${expired} ran out${more ? ", more tomorrow" : ""}`);
  console.log(`dream: ${scanned} new or changed memories, ${expired} ran out, ${proposed} proposed${more ? " (cap reached; the rest tomorrow)" : ""}`);
  return { skipped: null, scanned, expired, proposed, more };
}

/** From the minute job: once per local day, from DREAM_HOUR on. */
export function dreamCheck(t = now()) {
  if (new Date(t).getHours() < DREAM_HOUR || getSetting("dream_day") === dayKey(t)) return null;
  setSetting("dream_day", dayKey(t));
  return dream({ t });
}

/** Accepting a tidy-up, from the write path (inside the vault lock): the dropped memory is superseded or retired. */
export function applyDream(p: Proposal): { paths: string[]; msg: string } {
  const d = p.data as { action?: DreamAction; drop?: string; keep?: string | null; drop_norm?: string; keep_norm?: string | null };
  const changed = () => httpErr(409, "That memory has changed since the nightly pass; reject this one");
  const drop = d.drop ? docById(d.drop) : null, doc = drop && drop.kind === "memory" ? readDoc(drop.path) : null;
  if (!drop || !doc || doc.fm.status !== "active" || norm(doc.body) !== d.drop_norm) throw changed();
  if (d.action === "retire") {
    writeDoc(drop.path, { fm: { ...doc.fm, status: "forgotten" }, body: doc.body });
    return { paths: [drop.path], msg: `tidy: retired ${clip(doc.body, 60)}` };
  }
  if (d.action !== "merge" && d.action !== "supersede") throw httpErr(400, "Bad tidy-up record");
  const keep = d.keep ? docById(d.keep) : null, kdoc = keep && keep.kind === "memory" ? readDoc(keep.path) : null;
  if (!keep || !kdoc || kdoc.fm.status !== "active" || norm(kdoc.body) !== d.keep_norm) throw changed();
  // Checked again here, not only when proposed: a hand edit may have moved one of them since.
  if (keep.scope !== drop.scope) throw httpErr(409, "Those memories are in different scopes now; reject this one");
  writeDoc(drop.path, { fm: { ...doc.fm, status: "superseded", superseded_by: keep.id }, body: doc.body });
  return { paths: [drop.path], msg: `tidy: ${d.action === "merge" ? "merged" : "superseded"} ${clip(doc.body, 60)}` };
}
