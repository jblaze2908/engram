// People briefs (spec §11): before a calendar event with someone Engram knows, a private artifact with what it knows
// about them, and one ntfy push. Runs from the minute job but asks Google at most every 10 minutes (one request each).
import type { Scope } from "../shared/types.js";
import { now, DAY } from "./config.js";
import { db, all, one, run, getSetting, setSetting } from "./db.js";
import { entityView } from "./views.js";
import { publish } from "./artifacts/app.js";
import { send } from "./notify.js";
import { trace, YOU } from "./trace.js";
import { BUILTIN_GOOGLE, upcomingEvents, type UpcomingEvent } from "./gateway/google.js";

db.exec("CREATE TABLE IF NOT EXISTS briefs (event_id TEXT PRIMARY KEY, artifact TEXT, at INTEGER NOT NULL)");

const EVERY_MS = 10 * 60000, AHEAD_MS = 60 * 60000;
// Every scope: the brief is a private artifact, so no agent reads it, whatever it quotes.
const ALL: Scope[] = ["personal", "finance", "health", "household", "private"];
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z]{2,}/g) || [];

type Person = { id: string; name: string; tokens: string[] };
const people = (): Person[] => all<{ id: string; title: string }>("SELECT id, title FROM docs WHERE kind='entity' AND status='active' AND json_extract(data,'$.kind')='person'")
  .map((r) => ({ id: r.id, name: r.title, tokens: words(r.title) })).filter((p) => p.tokens.length);

/** People named in the title or among the other attendees (display name, or the words of an email's local part). */
export function peopleIn(e: UpcomingEvent, list = people()): Person[] {
  const hay = new Set([...words(e.summary), ...e.attendees.filter((a) => !a.self).flatMap((a) => [...words(a.name || ""), ...words(a.email.split("@")[0])])]);
  return list.filter((p) => p.tokens.every((t) => hay.has(t)));
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

export function briefText(e: UpcomingEvent, who: Person[]) {
  const out = [`# Before: ${e.summary || "a meeting"}`, "", `${time(e.start)} IST${e.location ? ` · ${e.location}` : ""}`];
  for (const p of who) {
    const v = entityView(p.id, ALL);
    if (!v) continue;
    out.push("", `## ${v.entity.name}`);
    if (v.entity.summary) out.push("", v.entity.summary);
    const active = v.memories.filter((m) => m.status === "active");
    if (active.length) out.push("", ...active.slice(0, 20).map((m) => `- ${m.text}${m.valid_until ? ` (until ${m.valid_until})` : ""}`));
    else out.push("", "Nothing remembered about them yet.");
  }
  return out.join("\n") + "\n";
}

export async function briefCheck(t = now()) {
  const last = Number(getSetting("brief_at") || 0);
  if (t - last < EVERY_MS) return 0;
  setSetting("brief_at", t);
  const conn = one<{ id: string }>("SELECT id FROM connections WHERE url=? AND state='ok' ORDER BY created_at LIMIT 1", BUILTIN_GOOGLE);
  if (!conn) return 0;
  const events = await upcomingEvents(conn.id, new Date(t).toISOString(), new Date(t + AHEAD_MS).toISOString()).catch((e) => { console.error("brief: calendar read failed:", (e as Error).message); return null; });
  if (!events?.length) return 0;
  run("DELETE FROM briefs WHERE at<?", t - 30 * DAY);
  const list = people();
  let made = 0;
  for (const e of events) {
    if (one("SELECT 1 FROM briefs WHERE event_id=?", e.id)) continue;
    const who = peopleIn(e, list);
    run("INSERT INTO briefs(event_id,artifact,at) VALUES(?,?,?)", e.id, null, t);
    if (!who.length) continue;
    const r = await publish({ agent: null, actor: YOU, source: { kind: "calendar", label: "Engram brief", agent: null, ref: `gcal:${e.id}`, at: t } },
      { title: `Before ${e.summary || "a meeting"} (${time(e.start)})`, filename: "brief.md", text: briefText(e, who), scope: "private", kind: "report" })
      .catch((err) => { run("DELETE FROM briefs WHERE event_id=?", e.id); console.error("brief: publish failed:", (err as Error).message); return null; });
    if (!r) continue;
    run("UPDATE briefs SET artifact=? WHERE event_id=?", r.id, e.id);
    trace(YOU, "brief", r.id, "ok", "private", `${who.length} people`);
    // Names only: the brief's contents stay behind sign-in.
    await send({ text: `${time(e.start)} ${e.summary.slice(0, 80)}: a brief on ${who.map((p) => p.name).join(", ").slice(0, 120)}`, click: `/#/context/artifacts/${r.id}`, tags: "busts_in_silhouette" });
    made++;
  }
  return made;
}
