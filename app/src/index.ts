// The SQLite index of the vault: every read comes from here. Rebuilt at boot, kept fresh by our own writes and by a
// 60 s mtime scan that picks up hand edits (one readdir walk + stat per file per minute, nothing per request).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import type { Scope, MemoryStatus, SourceKind, Source } from "../shared/types.js";
import { SCOPES, UNTRUSTED } from "../shared/types.js";
import { VAULT, now, norm } from "./config.js";
import { all, run, tx, setSetting } from "./db.js";
import { parseDoc } from "./vault.js";
import { pruneTrace } from "./trace.js";

export const CONFLICT = /\.conflict-\d+\.md$/;
const STATUSES: MemoryStatus[] = ["active", "superseded", "held", "forgotten"];
const SOURCE_KINDS: SourceKind[] = ["you", "agent", "email", "web", "file", "calendar", "other"];
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : v == null ? "" : String(v).slice(0, max));
const opt = (v: unknown) => (v == null || v === "" ? null : str(v, 200));
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v && !isNaN(Date.parse(v)) ? Date.parse(v) : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.slice(0, 120)) : []);
// Missing or unknown scope reads as private: a hand-written file is never exposed to agents by accident.
const scopeOf = (v: unknown, d: Scope = "private"): Scope => (SCOPES.includes(v as Scope) ? (v as Scope) : d);
export function sourceOf(v: any): Source {
  const kind = SOURCE_KINDS.includes(v?.kind) ? v.kind : "other";
  return { kind, label: str(v?.label, 200) || kind, agent: opt(v?.agent), ref: opt(v?.ref), at: typeof v?.at === "number" ? v.at : null };
}

type Indexed = { id: string; kind: string; title: string; body: string; area: string; project: string | null; scope: Scope; status: string; norm: string | null; source_ref: string | null; at: number; valid_until: string | null; data: Record<string, unknown> };

// Maps one vault file to its record, by where it lives. Unknown paths are not indexed.
export function toRecord(rel: string, src: string, mtime: number): Indexed | null {
  const p = rel.split("/"), { fm, body } = parseDoc(src), name = basename(rel, ".md");
  const base = { body, area: str(fm.area, 60), project: opt(fm.project), status: "active", norm: null, source_ref: null, valid_until: null };
  if (p[0] === "profile" && p.length === 2) {
    const scope = scopeOf(fm.scope);
    return { ...base, id: `profile:${name}`, kind: "profile", title: name, area: "", scope, at: mtime, data: { name, scope, lines: body ? body.split("\n").length : 0, body } };
  }
  if (p[0] === "areas" && p.length === 2)
    return { ...base, id: `area:${name}`, kind: "area", title: str(fm.name, 80) || name, area: name, scope: "personal", at: mtime, data: { slug: name, name: str(fm.name, 80) || name, summary: str(fm.summary, 300) } };
  if (p[0] === "projects" && p.length === 2) {
    const data = { slug: name, name: str(fm.name, 80) || name, area: str(fm.area, 60), summary: str(fm.summary, 300), status: fm.status === "done" ? "done" : "open", ends: opt(fm.ends) };
    return { ...base, id: `project:${name}`, kind: "project", title: data.name, scope: "personal", at: mtime, data };
  }
  if (p[0] === "entities" && p.length === 3) {
    const scope = scopeOf(fm.scope), id = str(fm.id, 60) || `ent_${p[1]}_${name}`;
    const data = { id, kind: p[1], name: str(fm.name, 120) || name, summary: str(fm.summary, 500), area: base.area, scope, slug: name };
    return { ...base, id, kind: "entity", title: data.name, body: `${data.summary}\n${body}`.trim(), scope, at: num(fm.created_at, mtime), data };
  }
  if (p[0] === "memories" && p.length === 4) {
    const scope = scopeOf(fm.scope), id = str(fm.id, 60) || name, source = sourceOf(fm.source), text = body;
    const status = STATUSES.includes(fm.status) ? fm.status : "active";
    const data = {
      id, text, area: base.area, project: base.project, entities: strs(fm.entities), scope, source,
      trust: UNTRUSTED.includes(source.kind) ? "untrusted" : "trusted", status,
      observed_at: num(fm.observed_at, mtime), valid_from: opt(fm.valid_from), valid_until: opt(fm.valid_until),
      supersedes: opt(fm.supersedes), superseded_by: opt(fm.superseded_by), created_at: num(fm.created_at, mtime), accepted_at: typeof fm.accepted_at === "number" ? fm.accepted_at : null,
    };
    return { ...base, id, kind: "memory", title: text.slice(0, 80), scope, status, norm: norm(text), source_ref: source.ref ?? null, at: data.created_at, valid_until: data.valid_until, data };
  }
  if (p[0] === "artifacts" && p.length === 2) {
    const scope = scopeOf(fm.scope), id = str(fm.id, 60) || name, source = sourceOf(fm.source);
    const sha = /^[a-f0-9]{64}$/.test(fm.sha256) ? fm.sha256 : null, ext = /^[a-z0-9]{1,5}$/.test(fm.ext) ? fm.ext : "bin";
    const kept = !!sha && existsSync(join(VAULT, "artifacts/files", `${sha}.${ext}`));
    const data = { id, title: str(fm.title, 200) || name, kind: str(fm.kind, 20) || "document", area: base.area, scope, source, mime: opt(fm.mime), size: typeof fm.size === "number" ? fm.size : null, sha256: sha, ext, kept, url: kept ? `/api/artifacts/${encodeURIComponent(id)}/file` : null, created_at: num(fm.created_at, mtime) };
    return { ...base, id, kind: "artifact", title: data.title, scope, status: fm.status === "forgotten" ? "forgotten" : "active", source_ref: source.ref ?? null, at: data.created_at, data };
  }
  if (p[0] === "journal" && p.length === 5) {
    const id = str(fm.id, 60) || name, at = num(fm.at, mtime);
    const outputs = Array.isArray(fm.outputs) ? fm.outputs.slice(0, 20).map((o: any) => ({ kind: str(o?.kind, 40), ref: str(o?.ref, 200), label: str(o?.label, 200) })) : [];
    const data = { id, at, who: str(fm.who, 80) || "you", text: body, area: base.area, project: base.project, outputs };
    return { ...base, id, kind: "episode", title: body.slice(0, 80), scope: scopeOf(fm.scope, "personal"), at, data };
  }
  if (p[0] === "skills" && p.length === 3 && p[2] === "SKILL.md") {
    const data = { name: p[1], description: str(fm.description, 300), area: base.area, body, version: typeof fm.version === "number" ? fm.version : 1, updated_at: num(fm.updated_at, mtime) };
    return { ...base, id: `skill:${p[1]}`, kind: "skill", title: p[1], body: `${data.description}\n${body}`.trim(), scope: scopeOf(fm.scope, "personal"), at: data.updated_at, data };
  }
  return null;
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name), rel = relative(VAULT, p);
    if (e.isDirectory()) { if (e.name !== ".git" && rel !== join("artifacts", "files")) yield* walk(p); }
    // A vault-sync conflict copy carries the original's id; indexing it would shadow the real record.
    else if (e.isFile() && e.name.endsWith(".md") && !CONFLICT.test(e.name)) yield rel.split("\\").join("/");
  }
}

function put(rel: string, mtime: number) {
  const r = toRecord(rel, readFileSync(join(VAULT, rel), "utf8"), mtime);
  for (const old of all<{ id: string }>("SELECT id FROM docs WHERE path=? OR id=?", rel, r?.id ?? "")) run("DELETE FROM docs_fts WHERE id=?", old.id);
  run("DELETE FROM docs WHERE path=? OR id=?", rel, r?.id ?? "");
  if (!r) return;
  run(`INSERT INTO docs(id,kind,path,title,body,area,project,scope,status,norm,source_ref,at,valid_until,data,mtime) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    r.id, r.kind, rel, r.title, r.body, r.area, r.project, r.scope, r.status, r.norm, r.source_ref, r.at, r.valid_until, JSON.stringify(r.data), mtime);
  run("INSERT INTO docs_fts(id,title,body) VALUES(?,?,?)", r.id, r.title, r.body);
}
const drop = (rel: string) => { for (const d of all<{ id: string }>("SELECT id FROM docs WHERE path=?", rel)) run("DELETE FROM docs_fts WHERE id=?", d.id); run("DELETE FROM docs WHERE path=?", rel); };

// After our own write: index those files now so the next read sees them.
export function indexPaths(rels: string[]) {
  tx(() => { for (const rel of rels) if (rel.endsWith(".md")) existsSync(join(VAULT, rel)) ? put(rel, Math.round(statSync(join(VAULT, rel)).mtimeMs)) : drop(rel); });
}

// Reindex what changed on disk since the last pass; force reindexes everything (boot).
export function scan(force = false) {
  const known = new Map(all<{ path: string; mtime: number }>("SELECT path, mtime FROM docs").map((r) => [r.path, r.mtime]));
  let changed = 0;
  tx(() => {
    for (const rel of walk(VAULT)) {
      const m = Math.round(statSync(join(VAULT, rel)).mtimeMs);
      if (force || known.get(rel) !== m) { put(rel, m); changed++; }
      known.delete(rel);
    }
    for (const rel of known.keys()) { drop(rel); changed++; }
  });
  setSetting("last_index", now());
  return changed;
}

export function startScanner() {
  const t = setInterval(() => { try { scan(); pruneTrace(); } catch (e) { console.error("index scan failed:", (e as Error).message); } }, 60000);
  t.unref();
}
