// Push notifications through ntfy (M4). One line each, and never memory text from finance, health or private scope.
// A no-op unless ENGRAM_NTFY_URL is set; the token only ever goes in the Authorization header.
import type { Digest, Scope } from "../shared/types.js";
import { HOST, now, DAY, dayKey } from "./config.js";
import { one, all, getSetting, setSetting } from "./db.js";

const URL_ = process.env.ENGRAM_NTFY_URL || "";
const TOKEN = process.env.ENGRAM_NTFY_TOKEN || "";
const PUBLIC = (process.env.ENGRAM_PUBLIC_URL || `https://${HOST}`).replace(/\/+$/, "");
export const HELD_EVERY_MS = 10 * 60000;
export const enabled = () => /^https?:\/\//.test(URL_);

type Note = { text: string; click: string; tags?: string; priority?: number };
let outbox: Promise<unknown> = Promise.resolve();
// Serialised, so a burst arrives in order; resolves even when ntfy is down (a missed push is logged, never thrown).
export function send(n: Note): Promise<unknown> {
  if (!enabled()) return Promise.resolve();
  const headers: Record<string, string> = { Title: "Engram", Click: `${PUBLIC}${n.click}`, "Content-Type": "text/plain; charset=utf-8" };
  if (n.tags) headers.Tags = n.tags;
  if (n.priority) headers.Priority = String(n.priority);
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  outbox = outbox.then(() => fetch(URL_, { method: "POST", headers, body: n.text.slice(0, 300), signal: AbortSignal.timeout(10000) })
    .then((r) => { if (!r.ok) console.error("ntfy refused a notification:", r.status); })
    .catch((e: Error) => console.error("ntfy unreachable:", e.name)));
  return outbox;
}

/** A proposal or memory as a notification may name it: personal text is fine, other scopes only by kind. */
export function safeTitle(scope: Scope, kind: string, title: string) {
  const t = title.replace(/\s+/g, " ").trim();
  return scope === "personal" && t ? (t.length > 80 ? `${t.slice(0, 79)}…` : t) : `a ${scope} ${kind.replace(/_/g, " ")}`;
}

type Row = { rid: number; id: string; kind: string; title: string; scope: Scope; held: number };
let pending: Row[] = [], lastHeld = 0, timer: ReturnType<typeof setTimeout> | undefined;

/** Sends what's batched: one held item by name, several as a count. */
export function flushHeld(t = now()) {
  clearTimeout(timer); timer = undefined;
  if (!pending.length) return Promise.resolve();
  const p = pending; pending = []; lastHeld = t;
  return p.length === 1
    ? send({ text: `Held for review: ${safeTitle(p[0].scope, p[0].kind, p[0].title)}`, click: `/#/inbox/${encodeURIComponent(p[0].id)}`, tags: "warning" })
    : send({ text: `${p.length} proposals are held for review`, click: "/#/inbox", tags: "warning" });
}

// Reads new rows by rowid, so held and tool_change proposals made on any path (the M2 gateway too) are seen once.
// Called right after a proposal is made and by the minute job; one indexed query either way.
export function sweepProposals(t = now()) {
  if (!enabled()) return Promise.resolve();
  const seen = getSetting("notify_rowid");
  if (seen === null) { setSetting("notify_rowid", one<{ n: number }>("SELECT COALESCE(MAX(rowid),0) n FROM proposals")!.n); return Promise.resolve(); }
  const rows = all<Row>("SELECT rowid rid, id, kind, title, scope, held FROM proposals WHERE rowid>? AND status='open' AND (held=1 OR kind='tool_change') ORDER BY rowid", Number(seen));
  const top = one<{ n: number }>("SELECT COALESCE(MAX(rowid),0) n FROM proposals")!.n;
  setSetting("notify_rowid", Math.max(top, Number(seen)));
  const sent: Promise<unknown>[] = [];
  for (const r of rows) {
    // A tool_change title is the tool's name, never record text.
    if (r.kind === "tool_change") sent.push(send({ text: `A tool changed its description and is blocked: ${r.title.slice(0, 80)}`, click: `/#/inbox/${encodeURIComponent(r.id)}`, tags: "lock", priority: 4 }));
    // A tool_call title is "<agent> wants to run <conn>/<tool>"; arguments never reach it. An agent is waiting, so no batching.
    else if (r.kind === "tool_call") sent.push(send({ text: `Approve? ${r.title.slice(0, 120)}`, click: `/#/inbox/${encodeURIComponent(r.id)}`, tags: "hand", priority: 4 }));
    else pending.push(r);
  }
  if (pending.length) {
    const wait = lastHeld + HELD_EVERY_MS - t;
    if (wait <= 0) sent.push(flushHeld(t));
    else if (!timer) { timer = setTimeout(() => void flushHeld(), wait); timer.unref(); }
  }
  return Promise.all(sent);
}
/** The hook in the write path: fire and forget. */
export const proposed = () => { void sweepProposals(); };

export const notifyDigest = (d: Digest) => send({
  text: `Your week in Engram: ${d.waiting.open + d.waiting.held} waiting, ${d.runningOut.length} running out, ${d.openLoops.length} open loops`,
  click: `/#/digest?week=${d.week}`, tags: "calendar",
});

/** Once a day: memories whose valid_until is three days out. */
export function runningOutCheck(t = now()) {
  const today = dayKey(t);
  if (!enabled() || getSetting("notify_runout_day") === today) return Promise.resolve();
  setSetting("notify_runout_day", today);
  const rows = all<{ scope: Scope; data: string }>("SELECT scope, data FROM docs WHERE kind='memory' AND status='active' AND valid_until=?", dayKey(t + 3 * DAY));
  if (!rows.length) return Promise.resolve();
  const text = rows.length === 1
    ? `Runs out in 3 days: ${safeTitle(rows[0].scope, "memory", (JSON.parse(rows[0].data) as { text: string }).text)}`
    : `${rows.length} memories run out in 3 days`;
  return send({ text, click: "/#/context", tags: "hourglass" });
}
