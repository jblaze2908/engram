// Screen-shaped reads (Status, Context, Area, Entity, Journal, Provenance) and the compiled profiles. SQLite only.
import type { Status, ContextHome, AreaView, EntityView, JournalView, Provenance, CompiledProfile, ProfileTarget, ProfileFile, Scope, Agent } from "../shared/types.js";
import { now, startOfDay, dayKey, DAY, httpErr } from "./config.js";
import { one, all, json, getSetting, marks } from "./db.js";
import { listAgents } from "./agents.js";
import { listProposals } from "./proposals.js";
import { agentCallsSince } from "./trace.js";
import * as S from "./store.js";

const UP_SINCE = now();
const count = (sql: string, ...a: (string | number)[]) => one<{ n: number }>(sql, ...a)!.n;

// ---------- compiled profiles ----------

export const TARGETS: ProfileTarget[] = ["claude-code", "codex", "crew-chief", "pitcrew-member"];
export const BUDGET: Record<ProfileTarget, number> = { "claude-code": 200, codex: 200, "crew-chief": 200, "pitcrew-member": 60 };
// null = every profile file; a Pitcrew member gets only the rules it must not break and how you work.
const FILES: Record<ProfileTarget, string[] | null> = {
  "claude-code": ["working-style", "rules", "preferences"], codex: ["working-style", "rules", "preferences"],
  "crew-chief": null, "pitcrew-member": ["rules", "working-style"],
};

const lintKey = (l: string) => l.replace(/^[-*\d.)\s]+/, "").toLowerCase().replace(/\s+/g, " ").trim();
// A line said in two files gets compiled twice into the same prompt; flag the later copy.
export function duplicateLint(files: ProfileFile[]) {
  const seen = new Map<string, { file: string; line: number }>(), out: CompiledProfile["lint"] = [];
  for (const f of files) f.body.split("\n").forEach((l, i) => {
    const k = lintKey(l);
    if (k.length < 8 || l.trim().startsWith("#")) return;
    const first = seen.get(k);
    if (!first) seen.set(k, { file: f.name, line: i + 1 });
    else if (first.file !== f.name) out.push({ file: f.name, line: i + 1, message: `Repeats ${first.file}.md line ${first.line}` });
  });
  return out;
}

export function compile(target: ProfileTarget, scopes: Scope[], files = S.profileFiles()): CompiledProfile {
  const want = FILES[target];
  const used = files.filter((f) => (!want || want.includes(f.name)) && scopes.includes(f.scope) && f.scope !== "private" && f.body.trim());
  const text = used.map((f) => `## ${f.name}\n${f.body.trim()}`).join("\n\n"), lines = text ? text.split("\n").length : 0;
  const lint = duplicateLint(used);
  if (lines > BUDGET[target]) lint.push({ file: "", line: 0, message: `${lines} lines; the ${target} budget is ${BUDGET[target]}` });
  return { target, text, lines, budget: BUDGET[target], lint };
}

// What the web app shows per target: what the agents using it can actually read (personal when none do yet).
export function compiledForUi(agents: Agent[] = listAgents()) {
  const files = S.profileFiles();
  return TARGETS.map((t) => {
    const scopes = new Set<Scope>(["personal"]);
    for (const a of agents) if (!a.revoked && a.profile === t) for (const g of a.grants) if (g.read) scopes.add(g.scope);
    return compile(t, [...scopes], files);
  });
}

// ---------- screens ----------

export function status(): Status {
  const today = startOfDay(), agents = listAgents().filter((a) => !a.revoked);
  const byHour = Array(24).fill(0);
  for (const r of all<{ h: number; n: number }>("SELECT (at-?)/3600000 h, COUNT(*) n FROM trace WHERE at>=? AND agent IS NOT NULL GROUP BY h", today, today)) if (r.h >= 0 && r.h < 24) byHour[r.h] = r.n;
  const calls = new Map(agentCallsSince(today).map((r) => [r.agent, r.n]));
  const open = count("SELECT COUNT(*) n FROM proposals WHERE status='open' AND held=0"), held = count("SELECT COUNT(*) n FROM proposals WHERE status='open' AND held=1");
  const lint = compiledForUi(agents).reduce((n, c) => n + c.lint.length, 0);
  const attention: Status["attention"] = [];
  if (held) attention.push({ level: "signal", title: `${held} held for review`, detail: "Untrusted or sensitive changes are waiting for you.", action: "Review", href: "/inbox" });
  if (open) attention.push({ level: "warn", title: `${open} waiting in the inbox`, detail: "Agents proposed changes to what Engram knows.", action: "Open inbox", href: "/inbox" });
  if (lint) attention.push({ level: "warn", title: `${lint} profile lint ${lint === 1 ? "issue" : "issues"}`, detail: "Duplicate lines or a target over its line budget.", action: "Fix", href: "/profile" });
  if (!agents.length) attention.push({ level: "warn", title: "No agents yet", detail: "Make a token so an agent can connect to /mcp.", action: "Add agent", href: "/agents" });
  const lastIndex = getSetting("last_index");
  return {
    up_since: UP_SINCE, calls_today: count("SELECT COUNT(*) n FROM trace WHERE at>=? AND agent IS NOT NULL", today),
    refused_today: count("SELECT COUNT(*) n FROM trace WHERE at>=? AND result='refused'", today), calls_by_hour: byHour,
    memories: count("SELECT COUNT(*) n FROM docs WHERE kind='memory' AND status='active'"),
    new_this_week: count("SELECT COUNT(*) n FROM docs WHERE kind='memory' AND status='active' AND at>=?", now() - 7 * DAY),
    last_index: lastIndex ? Number(lastIndex) : null, last_backup: null,
    // Linking Pitcrew (mirrored inbox and digest) is milestone M3; a Pitcrew-kind agent token alone isn't a link.
    pitcrew_linked: false, inbox: { open, held }, attention,
    agents: agents.map((a) => ({ id: a.id, name: a.name, hue: a.hue ?? null, last_used_at: a.last_used_at ?? null, calls_today: calls.get(a.id) || 0 })),
  };
}

const firstLine = (body: string) => body.split("\n").map((l) => l.replace(/^[-*\s]+/, "").trim()).find((l) => l && !l.startsWith("#")) || "";

export function contextHome(): ContextHome {
  const files = S.profileFiles(), weekAgo = now() - 7 * DAY;
  const soon = new Date(now() + 30 * DAY).toISOString().slice(0, 10);
  const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const changed = all<{ at: number; data: string; status: string }>("SELECT at, data, status FROM docs WHERE kind='memory' AND at>=? ORDER BY at DESC LIMIT 8", weekAgo)
    .map((r) => {
      const m = json<{ text: string; area: string; source: { kind: string; label: string } }>(r.data, { text: "", area: "", source: { kind: "other", label: "" } });
      const who = m.source.kind === "you" ? "You" : m.source.label || m.source.kind;
      return { text: r.status === "forgotten" ? `Forgot: ${m.text}` : m.text, detail: `${who} · ${day(r.at)} · ${S.areaRecord(m.area)?.name || m.area}`, tone: (r.status === "forgotten" ? "bad" : "normal") as "bad" | "normal" };
    });
  return {
    you: { files: files.length, targets: TARGETS.length, lint: compiledForUi().reduce((n, c) => n + c.lint.length, 0), highlights: files.filter((f) => f.scope === "personal").map((f) => firstLine(f.body)).filter(Boolean).slice(0, 3) },
    areas: S.areas(), projects: S.projects(), changed,
    runningOut: all<{ valid_until: string; title: string; area: string; data: string }>("SELECT valid_until, area, data FROM docs WHERE kind='memory' AND status='active' AND valid_until IS NOT NULL AND valid_until<=? ORDER BY valid_until LIMIT 20", soon)
      .map((r) => ({ date: r.valid_until, text: json<{ text: string }>(r.data, { text: "" }).text, area: r.area })),
    counts: {
      people: count("SELECT COUNT(*) n FROM docs WHERE kind='entity' AND json_extract(data,'$.kind')='person'"),
      memories: count("SELECT COUNT(*) n FROM docs WHERE kind='memory' AND status='active'"),
      artifacts: count("SELECT COUNT(*) n FROM docs WHERE kind='artifact'"),
      journalWeek: count("SELECT COUNT(*) n FROM docs WHERE kind='episode' AND at>=?", weekAgo),
      skills: count("SELECT COUNT(*) n FROM docs WHERE kind='skill'"),
    },
  };
}

export function areaView(slug: string): AreaView {
  const area = S.areas().find((a) => a.slug === slug);
  if (!area) throw httpErr(404, "No such area");
  return {
    area, now: S.listMemories({ status: "active", area: slug, limit: 50 }), people: S.listEntities({ kind: "person", area: slug }),
    files: S.listArtifacts({ area: slug }), lately: S.episodes("AND area=?", slug).slice(0, 20),
    held: listProposals("open").filter((p) => p.held && p.area === slug),
    readers: all<{ name: string }>("SELECT DISTINCT a.name FROM reads r JOIN docs d ON d.id=r.memory_id JOIN agents a ON a.id=r.agent WHERE d.area=? ORDER BY a.name", slug).map((r) => r.name),
  };
}

// scopes narrows everything for an agent; the web app (you) passes none and sees all.
export function entityView(id: string, scopes?: Scope[]): EntityView | null {
  const [entity] = S.listEntities({ ids: [id], scopes });
  if (!entity) return null;
  const memories = S.listMemories({ entity: id, scopes, status: scopes ? "active" : "all" });
  const linked: EntityView["linked"] = [];
  const refs = [...new Set(memories.map((m) => m.source.ref).filter((r): r is string => !!r))];
  for (const a of refs.length ? all<{ id: string; title: string }>(`SELECT id, title FROM docs WHERE kind='artifact' AND id IN (${marks(refs.length)})${scopes ? ` AND scope IN (${marks(scopes.length) || "''"})` : ""}`, ...refs, ...(scopes || [])) : [])
    linked.push({ kind: "artifact", id: a.id, label: a.title });
  const co = [...new Set(memories.flatMap((m) => m.entities).filter((e) => e !== id))];
  for (const e of S.listEntities({ ids: co, scopes })) linked.push({ kind: "entity", id: e.id, label: e.name });
  const ids = memories.map((m) => m.id);
  const readers = ids.length ? all<{ agent: string; count: number }>(`SELECT a.name agent, SUM(r.n) count FROM reads r JOIN agents a ON a.id=r.agent WHERE r.memory_id IN (${marks(ids.length)}) GROUP BY a.name ORDER BY count DESC`, ...ids) : [];
  return { entity, memories, linked, readers };
}

export function journalView(day?: string): JournalView {
  const start = day ? startOfDay(new Date(`${day}T00:00:00`).getTime()) : startOfDay(), key = dayKey(start);
  const counts = new Map<string, number>();
  for (const r of all<{ at: number }>("SELECT at FROM docs WHERE kind='episode' AND at>=?", start - 60 * DAY)) counts.set(dayKey(r.at), (counts.get(dayKey(r.at)) || 0) + 1);
  const monday = start - ((new Date(start).getDay() + 6) % 7) * DAY;
  return {
    days: [...counts].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([d, n]) => ({ day: d, count: n })), day: key,
    entries: S.episodes("AND at>=? AND at<?", start, start + DAY),
    week: Array.from({ length: 7 }, (_, i) => dayKey(startOfDay(monday + i * DAY + 12 * 3600000))),
  };
}

export function provenance(id: string): Provenance {
  const memory = S.memoryById(id);
  if (!memory) throw httpErr(404, "No such memory");
  const steps: Provenance["steps"] = [{ at: memory.observed_at, text: `Seen in ${memory.source.label}`, detail: memory.source.kind + (memory.source.ref ? ` · ${memory.source.ref}` : "") }];
  const p = one("SELECT * FROM proposals WHERE json_extract(data,'$.id')=?", id);
  if (p) {
    const reasons = json<string[]>(p.reasons, []);
    steps.push({ at: p.created_at, text: `Proposed by ${p.agent || "an agent"}`, detail: p.held ? `Held: ${reasons.join("; ")}` : "Waiting for review" });
  }
  if (memory.supersedes) steps.push({ at: memory.created_at, text: "Replaces an earlier memory", detail: memory.supersedes });
  if (memory.accepted_at) steps.push({ at: memory.accepted_at, text: memory.source.kind === "you" ? "Added by you" : "Accepted by you", detail: "" });
  const readers = all<{ name: string; n: number; last_at: number }>("SELECT a.name, r.n, r.last_at FROM reads r JOIN agents a ON a.id=r.agent WHERE r.memory_id=? ORDER BY r.last_at DESC", id);
  if (readers.length) steps.push({ at: readers[0].last_at, text: `Read ${memory.reads} ${memory.reads === 1 ? "time" : "times"}`, detail: readers.map((r) => `${r.name} ×${r.n}`).join(", ") });
  if (memory.superseded_by) steps.push({ at: null, text: "Superseded", detail: memory.superseded_by });
  if (memory.status === "forgotten") {
    const f = one<{ at: number; who: string }>("SELECT at, who FROM trace WHERE action='forget' AND (target=? OR target=?) ORDER BY id DESC LIMIT 1", id, memory.source.ref || "");
    steps.push({ at: f?.at ?? null, text: "Forgotten", detail: f ? `by ${f.who}` : "" });
  }
  return { memory, steps };
}
