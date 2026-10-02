// The write path (docs/build.md, spec §7). Agents propose; you decide in the inbox. Every vault change is one commit.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UNTRUSTED } from "../shared/types.js";
import type { Agent, Decision, Memory, Proposal, ProposalKind, Scope, Source, EntityKind, ArtifactKind } from "../shared/types.js";
import { now, uid, norm, slugify, httpErr, PENDING, VAULT, DAY } from "./config.js";
import { one, all, run, json, type Row } from "./db.js";
import { readDoc, writeDoc, writeRaw, commit, withVault } from "./vault.js";
import { indexPaths, sourceOf } from "./index.js";
import { trace, YOU, type Actor } from "./trace.js";
import { canPropose, readScopes } from "./agents.js";
import { memoryById, areaExists, docById, docData } from "./store.js";
import { proposed } from "./notify.js";
import { useRemoteVersion } from "./vaultsync.js";
import { decideToolChange } from "./gateway/store.js";
import { decideToolCall } from "./gateway/gate.js";

export type ProposeInput = {
  kind: ProposalKind | "episode"; text?: string; title?: string; name?: string; summary?: string; description?: string; body?: string;
  area?: string; project?: string | null; scope?: Scope; entity_kind?: EntityKind; artifact_kind?: ArtifactKind; entities?: string[];
  valid_from?: string | null; valid_until?: string | null; supersedes?: string | null; observed_at?: number;
  source?: Partial<Source>; content_base64?: string; mime?: string; outputs?: { kind: string; ref: string; label: string }[];
};
export type ProposeResult = { status: "accepted" | "open" | "held"; id: string; reasons: string[] };

const MONEY = /\b(accounts?|a\/c|ifsc|upi|vpa|payments?|pay(ee|ing)?|bank|iban|swift|routing number|transfer)\b/i;
// Extensions come from this list only, so a kept file can never be served as HTML or script.
export const MIMES: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "text/plain": "txt", "text/csv": "csv" };
const MAX_FILE = 6 << 20;
const ym = (t: number) => { const d = new Date(t); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")]; };
const short = (s: string) => s.replace(/\s+/g, " ").slice(0, 60);

export function toProposal(r: Row): Proposal {
  return {
    id: r.id, kind: r.kind, agent: r.agent ?? null, title: r.title, scope: r.scope, area: r.area, data: json(r.data, {}),
    source: json(r.source, {}), reasons: json(r.reasons, []), held: !!r.held, replaces: json(r.replaces, null),
    status: r.status, created_at: r.created_at, decided_at: r.decided_at ?? null,
  };
}
export const listProposals = (status = "open") => all("SELECT * FROM proposals WHERE status=? ORDER BY held DESC, created_at DESC LIMIT 500", status).map(toProposal);

export const memoryFm = (m: Omit<Memory, "text" | "reads">) => ({
  id: m.id, area: m.area, project: m.project ?? null, entities: m.entities, scope: m.scope, source: m.source, status: m.status,
  observed_at: m.observed_at, valid_from: m.valid_from ?? null, valid_until: m.valid_until ?? null,
  supersedes: m.supersedes ?? null, superseded_by: m.superseded_by ?? null, created_at: m.created_at, accepted_at: m.accepted_at ?? null,
});
export const memoryPath = (m: { id: string; created_at: number }) => { const [y, mo] = ym(m.created_at); return `memories/${y}/${mo}/${m.id}.md`; };

function refuse(who: Actor, action: string, target: string, scope: Scope | null, msg: string, result: "refused" | "blocked" = "refused"): never {
  trace(who, action, target, result, scope, msg);
  throw httpErr(result === "refused" ? 403 : 409, msg);
}

const SCOPE_AREA: Partial<Record<Scope, string>> = { finance: "money", health: "health" };
export function propose(agent: Agent, input: ProposeInput): Promise<ProposeResult> {
  return withVault(() => proposeLocked(agent, input));
}

async function proposeLocked(agent: Agent, input: ProposeInput): Promise<ProposeResult> {
  const who: Actor = { id: agent.id, name: agent.name }, t = now();
  // An agent can't claim to be you: "you" is what makes a memory yours for rule 3 and for trust.
  const raw = input.source || {};
  const source = sourceOf({ ...raw, kind: !raw.kind || raw.kind === "you" ? "agent" : raw.kind, label: raw.label || agent.name, agent: agent.id, at: raw.at ?? t });
  // No area named: the scope's own area when there is one (finance → money, health → health), else home.
  const own = input.kind === "episode" ? null : SCOPE_AREA[input.scope || "personal"];
  const area = input.area || (own && areaExists(own) ? own : "home");
  if (!areaExists(area)) throw httpErr(400, `Unknown area: ${area}`);

  // Rule 1: episodes describe, they don't assert, so an authenticated agent's go straight in.
  if (input.kind === "episode") {
    if (!input.text) throw httpErr(400, "An episode needs text");
    const id = uid("j"), [y, m, d] = ym(t), rel = `journal/${y}/${m}/${d}/${id}.md`;
    writeDoc(rel, { fm: { id, at: t, who: agent.name, area, project: input.project ?? null, outputs: input.outputs || [] }, body: input.text });
    await commit([rel], `journal: ${short(input.text)}`);
    indexPaths([rel]);
    trace(who, "propose", id, "ok", "personal", "episode");
    return { status: "accepted", id, reasons: [] };
  }

  const scope = input.scope || "personal";
  if (!canPropose(agent, scope)) refuse(who, "propose", input.kind, scope, `No propose grant for ${scope}`);
  const reasons: string[] = [];
  // Rule 2: untrusted sources are quarantined whatever they say.
  if (source.kind === "email") reasons.push("Email content is never trusted on its own");
  if (source.kind === "web") reasons.push("Web pages are never trusted on their own");

  let data: Record<string, unknown>, title: string, replaces: Proposal["replaces"] = null, key: string | null = null;
  if (input.kind === "memory") {
    const text = (input.text || "").trim();
    if (!text) throw httpErr(400, "A memory needs text");
    key = norm(text);
    if (input.supersedes) {
      const old = memoryById(input.supersedes);
      if (!old || old.status !== "active") throw httpErr(400, "The memory it replaces isn't active");
      if (!readScopes(agent).includes(old.scope)) refuse(who, "propose", old.id, old.scope, "Outside this agent's read grants");
      replaces = { id: old.id, text: old.text, source: old.source };
      // Rule 3.
      if (old.source.kind === "you") reasons.push("It would replace something you added yourself");
    }
    // Rule 4.
    if (scope === "finance" && MONEY.test(text)) reasons.push("It changes where money goes");
    // Rule 5: an exact restatement of an active memory (or of one already waiting) is the same claim.
    const dup = one<{ id: string }>("SELECT id FROM docs WHERE kind='memory' AND status='active' AND norm=? AND area=? AND scope=?", key, area, scope);
    if (dup) { trace(who, "propose", dup.id, "ok", scope, "already known"); return { status: "accepted", id: dup.id, reasons: [] }; }
    const waiting = one<Row>("SELECT * FROM proposals WHERE status='open' AND kind='memory' AND norm=? AND area=? AND scope=?", key, area, scope);
    if (waiting) return { status: waiting.held ? "held" : "open", id: waiting.id, reasons: json(waiting.reasons, []) };
    // Rule 6: never re-extract what Engram just told this agent.
    if (one("SELECT 1 FROM reads r JOIN docs d ON d.id=r.memory_id WHERE r.agent=? AND r.last_at>? AND d.norm=?", agent.id, t - DAY, key))
      refuse(who, "propose", "memory", scope, "This repeats a memory you read from Engram in the last 24 h; recalled memories are never proposed back", "blocked");
    const m: Omit<Memory, "reads"> = {
      id: uid("m"), text, area, project: input.project ?? null, entities: input.entities || [], scope, source,
      trust: UNTRUSTED.includes(source.kind) ? "untrusted" : "trusted", status: "active",
      observed_at: input.observed_at ?? t, valid_from: input.valid_from ?? null, valid_until: input.valid_until ?? null,
      supersedes: input.supersedes ?? null, superseded_by: null, created_at: t, accepted_at: null,
    };
    data = m; title = text.slice(0, 120);
  } else if (input.kind === "entity") {
    if (!input.name) throw httpErr(400, "An entity needs a name");
    data = { id: uid("ent"), kind: input.entity_kind || "thing", name: input.name, summary: input.summary || "", area, scope };
    title = input.name;
  } else if (input.kind === "artifact") {
    if (!input.title) throw httpErr(400, "An artifact needs a title");
    data = { id: uid("art"), title: input.title, kind: input.artifact_kind || "document", area, scope, source, mime: null, size: null, sha256: null };
    title = input.title;
  } else {
    const name = slugify(input.name || "");
    if (!input.name || !input.body) throw httpErr(400, "A skill needs a name and a body");
    data = { name, description: input.description || "", area, body: input.body };
    title = name;
  }

  const id = uid("p");
  if (input.kind === "artifact" && input.content_base64) {
    const bytes = Buffer.from(input.content_base64, "base64");
    if (!bytes.length || bytes.length > MAX_FILE) throw httpErr(413, "File must be under 6 MB");
    const mime = input.mime && MIMES[input.mime] ? input.mime : "application/octet-stream";
    Object.assign(data, { mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    writeFileSync(join(PENDING, id), bytes, { mode: 0o600 });
  }
  const held = reasons.length > 0;
  run("INSERT INTO proposals(id,kind,agent,title,scope,area,data,norm,source,source_ref,reasons,held,replaces,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, input.kind, agent.name, title, scope, area, JSON.stringify(data), key, JSON.stringify(source), source.ref ?? null, JSON.stringify(reasons), held ? 1 : 0, JSON.stringify(replaces), "open", t);
  trace(who, "propose", id, held ? "held" : "ok", scope, `${input.kind}: ${short(title)}`);
  proposed();
  return { status: held ? "held" : "open", id, reasons };
}

// Writes the accepted record; returns the vault paths it touched and the commit message.
function write(p: Proposal, t: number): { paths: string[]; msg: string } {
  if (p.kind === "vault_conflict") return useRemoteVersion(p);
  const d = p.data as Record<string, any>;
  if (p.kind === "memory") {
    const m = { ...(d as Memory), accepted_at: t }, paths = [memoryPath(m)];
    if (m.supersedes) {
      const old = docById(m.supersedes), doc = old && readDoc(old.path);
      if (!old || !doc || doc.fm.status !== "active") throw httpErr(409, "The memory it replaces has changed; reject this and propose again");
      writeDoc(old.path, { fm: { ...doc.fm, status: "superseded", superseded_by: m.id }, body: doc.body });
      paths.push(old.path);
    }
    writeDoc(paths[0], { fm: memoryFm(m), body: m.text });
    return { paths, msg: `memory: ${short(m.text)}` };
  }
  if (p.kind === "entity") {
    let slug = slugify(d.name), n = 1;
    while (existsSync(join(VAULT, `entities/${d.kind}/${slug}.md`))) slug = `${slugify(d.name)}-${++n}`;
    const rel = `entities/${d.kind}/${slug}.md`;
    writeDoc(rel, { fm: { id: d.id, name: d.name, summary: d.summary, area: d.area, scope: d.scope, created_at: t }, body: "" });
    return { paths: [rel], msg: `entity: ${short(d.name)}` };
  }
  if (p.kind === "artifact") {
    const rel = `artifacts/${d.id}.md`, paths = [rel], ext = MIMES[d.mime] || "bin";
    if (d.sha256) {
      const file = `artifacts/files/${d.sha256}.${ext}`;
      if (!existsSync(join(VAULT, file))) writeRaw(file, readFileSync(join(PENDING, p.id)));
      paths.push(file);
    }
    writeDoc(rel, { fm: { id: d.id, title: d.title, kind: d.kind, area: d.area, scope: d.scope, source: p.source, mime: d.mime, size: d.size, sha256: d.sha256, ext, created_at: t }, body: "" });
    return { paths, msg: `artifact: ${short(d.title)}` };
  }
  const rel = `skills/${d.name}/SKILL.md`, prev = docById(`skill:${d.name}`);
  const was = prev ? docData<{ version: number; description: string }>(prev) : null, version = was ? (was.version || 1) + 1 : 1;
  writeDoc(rel, { fm: { description: d.description || was?.description || "", area: d.area, version, updated_at: t }, body: d.body });
  return { paths: [rel], msg: `skill: ${d.name} v${version}` };
}

export async function decide(id: string, decision: Decision, who: Actor = YOU): Promise<Proposal> {
  // A tool call touches no vault file and may wait on the upstream for a minute, so it runs outside the vault lock.
  if (one("SELECT 1 FROM proposals WHERE id=? AND kind='tool_call'", id)) { await decideToolCall(id, decision, who); return toProposal(one("SELECT * FROM proposals WHERE id=?", id)!); }
  return withVault(async () => {
    const r = one("SELECT * FROM proposals WHERE id=?", id);
    if (!r) throw httpErr(404, "No such proposal");
    if (r.status !== "open") throw httpErr(409, "Already decided");
    const p = toProposal(r), t = now();
    if (p.kind === "tool_change") { decideToolChange(p, decision, who); return toProposal(one("SELECT * FROM proposals WHERE id=?", id)!); }
    if (decision === "accept") {
      const { paths, msg } = write(p, t);
      await commit(paths, msg);
      indexPaths(paths);
      run("UPDATE proposals SET status='accepted', decided_at=? WHERE id=?", t, id);
      trace(who, "accept", id, "ok", p.scope, short(p.title));
    } else {
      run("UPDATE proposals SET status='rejected', decided_at=? WHERE id=?", t, id);
      trace(who, decision, id, "ok", p.scope, short(p.title));
      if (decision === "reject_and_forget_source" && p.source.ref) await forgetWhere(p.source, who);
    }
    rmSync(join(PENDING, id), { force: true });
    return toProposal(one("SELECT * FROM proposals WHERE id=?", id)!);
  });
}

// Forgetting never deletes: the file stays, with status forgotten, and the commit says why.
async function forgetWhere(source: Source, who: Actor) {
  const rows = all<{ id: string; path: string }>("SELECT id, path FROM docs WHERE kind='memory' AND source_ref=? AND status!='forgotten'", source.ref!);
  const paths: string[] = [];
  for (const r of rows) {
    const doc = readDoc(r.path);
    if (!doc) continue;
    writeDoc(r.path, { fm: { ...doc.fm, status: "forgotten" }, body: doc.body });
    paths.push(r.path);
  }
  if (!paths.length) return 0;
  await commit(paths, `forget: ${paths.length} from ${short(source.label)}`);
  indexPaths(paths);
  trace(who, "forget", source.ref!, "ok", null, `${paths.length} memories`);
  return paths.length;
}

export function forgetMemory(id: string, who: Actor = YOU) {
  return withVault(async () => {
    const d = docById(id);
    if (!d || d.kind !== "memory") throw httpErr(404, "No such memory");
    const doc = readDoc(d.path);
    if (!doc) throw httpErr(404, "No such memory");
    if (doc.fm.status !== "forgotten") {
      writeDoc(d.path, { fm: { ...doc.fm, status: "forgotten" }, body: doc.body });
      await commit([d.path], `forget: ${short(doc.body)}`);
      indexPaths([d.path]);
      trace(who, "forget", id, "ok", d.scope);
    }
    return memoryById(id)!;
  });
}

// "Add to Engram" from the web app: you are the source, so it's accepted directly.
export function addMemory(a: { text: string; area: string; scope: Scope; valid_until?: string | null }) {
  return withVault(async () => {
    if (!areaExists(a.area)) throw httpErr(400, `Unknown area: ${a.area}`);
    const dup = one<{ id: string }>("SELECT id FROM docs WHERE kind='memory' AND status='active' AND norm=? AND area=? AND scope=?", norm(a.text), a.area, a.scope);
    if (dup) return memoryById(dup.id)!;
    const t = now();
    const m: Omit<Memory, "reads"> = {
      id: uid("m"), text: a.text.trim(), area: a.area, project: null, entities: [], scope: a.scope, source: { kind: "you", label: "Added in Engram", agent: null, ref: null, at: t },
      trust: "trusted", status: "active", observed_at: t, valid_from: null, valid_until: a.valid_until ?? null, supersedes: null, superseded_by: null, created_at: t, accepted_at: t,
    };
    const rel = memoryPath(m);
    writeDoc(rel, { fm: memoryFm(m), body: m.text });
    await commit([rel], `memory: ${short(m.text)}`);
    indexPaths([rel]);
    trace(YOU, "add", m.id, "ok", m.scope);
    return memoryById(m.id)!;
  });
}
