// The weekly digest (M4): waiting items, what runs out, what changed, open loops and the week's journal. Built live
// for the current week; Sundays 19:00 local time (TZ) it is written to vault/digests/YYYY-Www.md and kept. Never private scope,
// because Pitcrew shows it too.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Digest } from "../shared/types.js";
import { now, httpErr, DAY, VAULT, dayKey } from "./config.js";
import { db, one, all, run, json, getSetting } from "./db.js";
import { parseDoc, writeDoc, commit, withVault } from "./vault.js";
import { areaRecord } from "./store.js";

db.exec("CREATE TABLE IF NOT EXISTS digests (week TEXT PRIMARY KEY, data TEXT NOT NULL, built_at INTEGER NOT NULL)");

export const WEEK_RE = /^\d{4}-W\d{2}$/;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const shift = (t: number) => t - new Date(t).getTimezoneOffset() * 60000;
/** Hour h on the local clock on the UTC calendar date u; built from fields so DST changes land right. */
const localAt = (u: number, h = 0) => { const d = new Date(u); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h).getTime(); };

export function isoWeek(t: number): string {
  const d = new Date(shift(t)), dow = (d.getUTCDay() + 6) % 7;
  const thu = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 3), y = new Date(thu).getUTCFullYear();
  return `${y}-W${String(1 + Math.floor((thu - Date.UTC(y, 0, 1)) / (7 * DAY))).padStart(2, "0")}`;
}
/** Monday 00:00 to the next Monday 00:00, local time, as epoch ms. */
export function weekRange(week: string) {
  const [y, w] = week.split("-W").map(Number), jan4 = Date.UTC(y, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY + (w - 1) * 7 * DAY;
  return { start: localAt(monday), end: localAt(monday + 7 * DAY), from: iso(monday), to: iso(monday + 6 * DAY) };
}
/** The latest week whose Sunday 19:00 local time has passed. */
export function dueWeek(t: number) {
  const w = isoWeek(t);
  return t >= localAt(Date.parse(weekRange(w).to), 19) ? w : isoWeek(t - 7 * DAY);
}

const dayLabel = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const areaName = (slug: string) => areaRecord(slug)?.name || slug;
const LOOP = /(^|\s)#loop\b/i;

export function buildDigest(week: string, t = now()): Digest {
  const { start, end, from, to } = weekRange(week);
  const ref = Math.min(t, end), soon = dayKey(ref + 30 * DAY);
  const n = (sql: string) => one<{ n: number }>(sql)!.n;
  const runningOut = all<{ valid_until: string; area: string; data: string }>(
    "SELECT valid_until, area, data FROM docs WHERE kind='memory' AND status='active' AND scope!='private' AND valid_until IS NOT NULL AND valid_until<=? ORDER BY valid_until LIMIT 20", soon,
  ).map((r) => ({ date: r.valid_until, text: json<{ text: string }>(r.data, { text: "" }).text, area: r.area }));
  const changed = all<{ at: number; status: string; data: string }>(
    "SELECT at, status, data FROM docs WHERE kind='memory' AND scope!='private' AND at>=? AND at<? ORDER BY at DESC LIMIT 20", start, end,
  ).map((r) => {
    const m = json<{ text: string; area: string; source: { kind: string; label: string } }>(r.data, { text: "", area: "", source: { kind: "other", label: "" } });
    const who = m.source.kind === "you" ? "You" : m.source.label || m.source.kind, bad = r.status === "forgotten";
    return { text: bad ? `Forgot: ${m.text}` : m.text, detail: `${who} · ${dayLabel(r.at)} · ${areaName(m.area)}`, tone: (bad ? "bad" : "normal") as "bad" | "normal" };
  });
  const projects = all<{ data: string }>("SELECT data FROM docs WHERE kind='project'").map((r) => json<{ name: string; area: string; status: string; ends?: string | null }>(r.data, { name: "", area: "", status: "done" }))
    .filter((p) => p.status === "open").map((p) => ({ text: p.ends ? `${p.name}, ends ${p.ends}` : p.name, area: p.area }));
  const loops = all<{ area: string; data: string }>("SELECT area, data FROM docs WHERE kind='memory' AND status='active' AND scope!='private' AND body LIKE '%#loop%' ORDER BY at DESC LIMIT 30")
    .map((r) => ({ text: json<{ text: string }>(r.data, { text: "" }).text, area: r.area })).filter((l) => LOOP.test(l.text))
    .map((l) => ({ ...l, text: l.text.replace(/(^|\s)#loop\b/gi, " ").replace(/\s+/g, " ").trim() }));
  const days = new Map<string, string[]>();
  for (const r of all<{ at: number; data: string }>("SELECT at, data FROM docs WHERE kind='episode' AND scope!='private' AND at>=? AND at<? ORDER BY at", start, end)) {
    const e = json<{ who: string; text: string }>(r.data, { who: "", text: "" }), line = e.text.split("\n")[0].trim();
    if (!line) continue;
    const day = dayKey(r.at);
    days.set(day, [...(days.get(day) || []), `${e.who === "you" ? "You" : e.who}: ${line}`]);
  }
  return {
    week, from, to, built_at: t,
    waiting: { open: n("SELECT COUNT(*) n FROM proposals WHERE status='open' AND held=0"), held: n("SELECT COUNT(*) n FROM proposals WHERE status='open' AND held=1") },
    runningOut, changed, openLoops: [...projects, ...loops], journal: [...days].map(([day, lines]) => ({ day, lines })),
  };
}

export const storedDigest = (week: string) => { const r = one<{ data: string }>("SELECT data FROM digests WHERE week=?", week); return r ? json<Digest>(r.data, null) : null; };

// Stored when the week has been written; otherwise built from the index now. Future weeks don't exist yet.
export function digest(week?: string): Digest {
  const cur = isoWeek(now()), w = week || cur;
  if (!WEEK_RE.test(w) || w > cur) throw httpErr(404, "No digest for that week");
  return storedDigest(w) || buildDigest(w);
}
export function digestWeeks(): string[] {
  const kept = all<{ week: string }>("SELECT week FROM digests ORDER BY week DESC").map((r) => r.week), cur = isoWeek(now());
  return kept.includes(cur) ? kept : [cur, ...kept];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function renderDigest(d: Digest): string {
  const out = [`# The week of ${d.from} to ${d.to}`, ""];
  const waiting = d.waiting.open + d.waiting.held;
  out.push(waiting ? `${plural(waiting, "thing is", "things are")} waiting in the inbox${d.waiting.held ? `, ${d.waiting.held} held for review` : ""}.` : "Nothing is waiting in the inbox.", "");
  const section = (title: string, lines: string[], none: string) => out.push(`## ${title}`, "", ...(lines.length ? lines : [none]), "");
  section("Running out", d.runningOut.map((r) => `- ${r.date}: ${r.text} (${areaName(r.area)})`), "Nothing runs out in the next 30 days.");
  section("What changed", d.changed.map((c) => `- ${c.text} (${c.detail})`), "No memories changed this week.");
  section("Open loops", d.openLoops.map((l) => `- ${l.text} (${areaName(l.area)})`), "No open loops.");
  section("Journal", d.journal.flatMap((j) => [`### ${dayLabel(Date.parse(`${j.day}T12:00:00`))}`, ...j.lines.map((l) => `- ${l}`), ""]), "Nothing in the journal this week.");
  return out.join("\n").trim();
}

// One commit per week; a second build of the same week (a restart around 19:00) rewrites the same file.
export function storeDigest(week: string, t = now()) {
  return withVault(async () => {
    const d = buildDigest(week, t), rel = `digests/${week}.md`;
    writeDoc(rel, { fm: { kind: "digest", week, digest: d }, body: renderDigest(d) });
    await commit([rel], `digest: ${week}`);
    run("INSERT INTO digests(week,data,built_at) VALUES(?,?,?) ON CONFLICT(week) DO UPDATE SET data=excluded.data, built_at=excluded.built_at", week, JSON.stringify(d), d.built_at);
    return d;
  });
}

// Boot: the digests table is a copy of the vault files, so a rebuilt database gets the past weeks back.
export function loadDigests() {
  const dir = join(VAULT, "digests");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const week = f.replace(/\.md$/, "");
    if (!WEEK_RE.test(week) || storedDigest(week)) continue;
    const d = parseDoc(readFileSync(join(dir, f), "utf8")).fm.digest as Digest | undefined;
    if (d && d.week === week) run("INSERT OR IGNORE INTO digests(week,data,built_at) VALUES(?,?,?)", week, JSON.stringify(d), Number(d.built_at) || 0);
  }
}

/** Scheduler step: write the latest due week once, never for weeks that ended before Engram was installed. */
export async function digestDue(t = now()) {
  const week = dueWeek(t), installed = Number(getSetting("installed_at") || t);
  if (storedDigest(week) || weekRange(week).end <= installed) return null;
  return storeDigest(week, t);
}
