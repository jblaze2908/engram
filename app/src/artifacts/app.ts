// Publishing (engram-app side): one file in, one private artifact out, versioned in the vault; public links on request.
// After every change the serving manifest is rewritten, so the artifacts server never reads the DB or the vault index.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Scope, Source } from "../../shared/types.js";
import { ROOT, VAULT, now, uid, httpErr } from "../config.js";
import { one, all, run, json, type Row } from "../db.js";
import { readDoc, writeDoc, writeRaw, commit, withVault } from "../vault.js";
import { indexPaths } from "../index.js";
import { docById, areaExists } from "../store.js";
import { canPropose } from "../agents.js";
import { trace, type Actor } from "../trace.js";
import { proposed } from "../notify.js";
import { MAX_FILE, VIEW_MS, extOf, mimeOf, mintToken, versionsOf, type Manifest, type Version } from "./shared.js";
import { privateUrl, publicUrl, liveShares, newShare, revokeShare } from "./shares.js";

export const SERVE = join(ROOT, "artifacts-serve");
const SCOPE_AREA: Partial<Record<Scope, string>> = { finance: "money", health: "health" };
const short = (s: string) => s.replace(/\s+/g, " ").slice(0, 60);

export type PublishInput = {
  title: string; filename: string; text?: string; content_base64?: string; id?: string | null; description?: string;
  area?: string; project?: string | null; scope?: Scope; public?: boolean; kind?: string;
};
export type PublishResult = { id: string; version: number; url: string; public_url: string | null; status: "published" | "share_pending" };
/** Who publishes: an agent (needs a propose grant for the scope, may only version its own), or you (agent null). */
export type Publisher = { agent: Agent | null; actor: Actor; source: Source };

function bytesOf(i: PublishInput) {
  if ((i.text === undefined) === (i.content_base64 === undefined)) throw httpErr(400, "Send the file as text or content_base64, not both");
  const b = i.text !== undefined ? Buffer.from(i.text, "utf8") : Buffer.from(i.content_base64!, "base64");
  if (!b.length) throw httpErr(400, "The file is empty");
  if (b.length > MAX_FILE) throw httpErr(413, "Files must be under 10 MB");
  return b;
}

export async function publish(p: Publisher, i: PublishInput): Promise<PublishResult> {
  const r = await withVault(() => write(p, i));
  if (i.public && !r.public_url) return { ...r, status: (await requestShare(r.id, p)) ? "share_pending" : "published", public_url: publicUrl(r.id) };
  return r;
}

async function write(p: Publisher, i: PublishInput): Promise<PublishResult> {
  const bytes = bytesOf(i), t = now(), ext = extOf(i.filename), sha = createHash("sha256").update(bytes).digest("hex");
  const by = p.source.label, title = i.title.trim().slice(0, 200) || i.filename.slice(0, 200);
  let rel: string, fm: Record<string, any>, body: string, versions: Version[];
  if (i.id) {
    const d = docById(i.id), doc = d && d.kind === "artifact" ? readDoc(d.path) : null;
    if (!d || !doc || doc.fm.status === "forgotten") throw httpErr(404, "No such artifact");
    if (p.agent && doc.fm.source?.agent !== p.agent.id) { trace(p.actor, "publish", i.id, "refused", d.scope, "not its own"); throw httpErr(403, "Only the agent that published an artifact can publish a new version of it"); }
    rel = d.path; versions = versionsOf(doc.fm, Number(doc.fm.created_at) || t, String(doc.fm.source?.label || by));
    const last = versions.at(-1);
    // A republish of the same bytes is the same version: nothing to commit.
    if (last && last.sha256 === sha && (!i.description || i.description === doc.body) && title === doc.fm.title)
      return { id: d.id, version: last.v, url: privateUrl(d.id), public_url: publicUrl(d.id), status: "published" };
    const { sha256: _s, ext: _e, mime: _m, size: _z, ...rest } = doc.fm;
    fm = { ...rest, title, updated_at: t };
    body = i.description ?? doc.body;
  } else {
    const scope = i.scope || "personal";
    if (p.agent && !canPropose(p.agent, scope)) { trace(p.actor, "publish", "artifact", "refused", scope, `no propose grant for ${scope}`); throw httpErr(403, `No propose grant for ${scope}`); }
    const own = SCOPE_AREA[scope], area = i.area || (own && areaExists(own) ? own : "home");
    if (!areaExists(area)) throw httpErr(400, `Unknown area: ${area}`);
    const id = uid("art");
    rel = `artifacts/${id}.md`; versions = [];
    fm = { id, title, kind: (i.kind || "document").slice(0, 30), area, project: i.project ?? null, scope, source: p.source, status: "active", created_at: t, updated_at: t };
    body = i.description || "";
  }
  if (versions.at(-1)?.sha256 !== sha) versions.push({ v: (versions.at(-1)?.v ?? 0) + 1, sha256: sha, ext, mime: mimeOf(ext), size: bytes.length, at: t, by });
  const file = `artifacts/files/${sha}.${ext}`, paths = [rel];
  if (!existsSync(join(VAULT, file))) { writeRaw(file, bytes); paths.push(file); }
  writeDoc(rel, { fm: { ...fm, versions }, body });
  const v = versions.at(-1)!.v;
  await commit(paths, `artifact: ${short(title)} v${v}`);
  indexPaths([rel]);
  trace(p.actor, "publish", fm.id, "ok", fm.scope, `v${v} ${short(i.filename)}`);
  writeManifest();
  return { id: fm.id, version: v, url: privateUrl(fm.id), public_url: publicUrl(fm.id), status: "published" };
}

// ---------- public links ----------
const activeArtifact = (id: string) => { const d = docById(id); return d && d.kind === "artifact" && d.status === "active" ? d : null; };

/** An agent asking for a public link: one held inbox item per artifact (deciding it in Engram or Pitcrew closes it). */
async function requestShare(id: string, p: Publisher): Promise<boolean> {
  if (!p.agent) { share(id, p.actor); return false; }
  const d = activeArtifact(id)!;
  if (one("SELECT 1 FROM proposals WHERE status='open' AND kind='share' AND json_extract(data,'$.artifact_id')=?", id)) return true;
  const pid = uid("p"), reasons = ["Anyone with the link can open it"];
  run("INSERT INTO proposals(id,kind,agent,title,scope,area,data,norm,source,source_ref,reasons,held,replaces,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    pid, "share", p.agent.name, `Make public: ${d.title}`.slice(0, 200), d.scope, d.area, JSON.stringify({ artifact_id: id, title: d.title, url: privateUrl(id) }), null,
    JSON.stringify(p.source), id, JSON.stringify(reasons), 1, JSON.stringify(null), "open", now());
  trace(p.actor, "share.request", id, "held", d.scope, short(d.title));
  proposed();
  return true;
}

export function share(id: string, who: Actor) {
  const d = activeArtifact(id);
  if (!d) throw httpErr(404, "No such artifact");
  const existing = publicUrl(id);
  if (existing) return existing;
  newShare(id);
  writeManifest();
  trace(who, "share", id, "ok", d.scope, short(d.title));
  return publicUrl(id)!;
}
export function unshare(id: string, who: Actor) {
  const d = docById(id);
  if (!d || d.kind !== "artifact") throw httpErr(404, "No such artifact");
  if (revokeShare(id)) { writeManifest(); trace(who, "unshare", id, "ok", d.scope, short(d.title)); }
}
/** A share proposal decided in the inbox: accept makes the link, reject leaves the artifact private. */
export function decideShare(r: Row, accept: boolean, who: Actor) {
  const id = json<{ artifact_id?: string }>(r.data, {}).artifact_id || "";
  if (accept && !activeArtifact(id)) throw httpErr(409, "That artifact was forgotten");
  run("UPDATE proposals SET status=?, decided_at=? WHERE id=?", accept ? "accepted" : "rejected", now(), r.id);
  if (accept) share(id, who); else trace(who, "reject", r.id, "ok", r.scope, short(r.title));
}

// ---------- what the artifacts server reads ----------
let key: Buffer | null = null;
export function viewKey() {
  if (key) return key;
  mkdirSync(SERVE, { recursive: true, mode: 0o700 });
  const p = join(SERVE, "view.key");
  if (!existsSync(p)) writeFileSync(p, randomBytes(32), { mode: 0o600 });
  return (key = readFileSync(p));
}
export const viewToken = (id: string) => mintToken(viewKey(), id, now() + VIEW_MS);

// Per artifact or share change: one read of the active artifacts' index rows and one atomic file write.
export function writeManifest() {
  viewKey();
  const m: Manifest = { artifacts: {}, shares: {} };
  for (const r of all<{ id: string; title: string; data: string }>("SELECT id, title, data FROM docs WHERE kind='artifact' AND status='active'")) {
    const vs = json<{ versions?: Version[] }>(r.data, {}).versions || [];
    if (vs.length) m.artifacts[r.id] = { title: r.title, versions: vs.map(({ v, sha256, ext, mime }) => ({ v, sha256, ext, mime })) };
  }
  for (const s of liveShares()) if (m.artifacts[s.artifact_id]) m.shares[s.slug] = s.artifact_id;
  const p = join(SERVE, "manifest.json");
  writeFileSync(`${p}.tmp`, JSON.stringify(m), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  return m;
}
