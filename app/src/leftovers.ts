// M1 leftovers on the write path: edit, mark wrong, forget a file, link a skill to the profile, undo an accept.
// Same rules as proposals.ts: one commit per change, nothing deleted from history, everything traced.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Memory } from "../shared/types.js";
import { now, uid, norm, httpErr, VAULT } from "./config.js";
import { one, all, json } from "./db.js";
import { readDoc, writeDoc, commit, withVault } from "./vault.js";
import { indexPaths } from "./index.js";
import { trace, YOU } from "./trace.js";
import { decide, memoryFm, memoryPath, toProposal } from "./proposals.js";
import { docById, memoryById } from "./store.js";
import { versionsOf } from "./artifacts/shared.js";
import { dropLink } from "./artifacts/shares.js";
import { writeManifest } from "./artifacts/app.js";

const short = (s: string) => s.replace(/\s+/g, " ").slice(0, 60);

function memoryDoc(id: string) {
  const d = docById(id), doc = d && d.kind === "memory" ? readDoc(d.path) : null;
  if (!d || !doc) throw httpErr(404, "No such memory");
  return { d, doc };
}

/** Edit = a new memory by you that supersedes the old one, accepted directly (you are the source). */
export function editMemory(id: string, a: { text: string; valid_until?: string | null }) {
  return withVault(async () => {
    const { d, doc } = memoryDoc(id), old = memoryById(id)!;
    if (old.status !== "active") throw httpErr(409, "Only an active memory can be edited");
    const valid_until = a.valid_until === undefined ? old.valid_until ?? null : a.valid_until;
    if (norm(a.text) === norm(old.text) && valid_until === (old.valid_until ?? null)) throw httpErr(400, "Nothing changed");
    const t = now();
    const m: Omit<Memory, "reads"> = {
      id: uid("m"), text: a.text.trim(), area: old.area, project: old.project ?? null, entities: old.entities, scope: old.scope,
      source: { kind: "you", label: "Edited in Engram", agent: null, ref: null, at: t }, trust: "trusted", status: "active",
      observed_at: t, valid_from: old.valid_from ?? null, valid_until, supersedes: id, superseded_by: null, created_at: t, accepted_at: t,
    };
    const rel = memoryPath(m);
    writeDoc(rel, { fm: memoryFm(m), body: m.text });
    writeDoc(d.path, { fm: { ...doc.fm, status: "superseded", superseded_by: m.id }, body: doc.body });
    await commit([rel, d.path], `edit: ${short(m.text)}`);
    indexPaths([rel, d.path]);
    trace(YOU, "edit", m.id, "ok", m.scope, `replaces ${id}`);
    return memoryById(m.id)!;
  });
}

/** Mark as wrong = forgotten, flagged wrong, with your reason in the commit (the vault's own history). */
export function markWrong(id: string, reason: string) {
  return withVault(async () => {
    const { d, doc } = memoryDoc(id);
    if (doc.fm.status === "forgotten") throw httpErr(409, "Already forgotten");
    writeDoc(d.path, { fm: { ...doc.fm, status: "forgotten", wrong: true }, body: doc.body });
    await commit([d.path], `wrong: ${short(doc.body)} (${reason.replace(/\s+/g, " ").trim()})`);
    indexPaths([d.path]);
    trace(YOU, "forget", id, "ok", d.scope, `marked wrong: ${reason}`);
    return memoryById(id)!;
  });
}

/** Forget a file: its record and every memory taken from it become forgotten; the kept copy leaves the tree (git keeps it). */
export function forgetArtifact(id: string) {
  return withVault(async () => {
    const d = docById(id), doc = d && d.kind === "artifact" ? readDoc(d.path) : null;
    if (!d || !doc) throw httpErr(404, "No such artifact");
    if (doc.fm.status === "forgotten") throw httpErr(409, "Already forgotten");
    const paths = [d.path];
    writeDoc(d.path, { fm: { ...doc.fm, status: "forgotten" }, body: doc.body });
    for (const r of all<{ path: string }>("SELECT path FROM docs WHERE kind='memory' AND source_ref=? AND status!='forgotten'", id)) {
      const m = readDoc(r.path);
      if (!m) continue;
      writeDoc(r.path, { fm: { ...m.fm, status: "forgotten" }, body: m.body });
      paths.push(r.path);
    }
    // Two records can share one content-addressed copy; it goes only when no remembered record still points at it.
    for (const { sha256: sha, ext } of versionsOf(doc.fm, 0, "")) {
      if (one("SELECT 1 FROM docs d, json_each(d.data,'$.versions') v WHERE d.kind='artifact' AND d.status='active' AND d.id!=? AND json_extract(v.value,'$.sha256')=?", id, sha)) continue;
      const file = `artifacts/files/${sha}.${ext}`;
      if (existsSync(join(VAULT, file))) { rmSync(join(VAULT, file)); paths.push(file); }
    }
    const n = paths.filter((p) => p.startsWith("memories/")).length;
    await commit(paths, `forget: ${short(String(doc.fm.title || id))} and ${n} ${n === 1 ? "memory" : "memories"}`);
    indexPaths(paths);
    trace(YOU, "forget", id, "ok", d.scope, `file and ${n} memories`);
    // Never served again: its link goes for good and the manifest drops it.
    dropLink(id);
    writeManifest();
    return { id, memories: n };
  });
}

/** Link to profile instead: reject the skill edit, and point the skill at the profile file that already says it. */
export async function linkSkillToProfile(proposalId: string, file: string) {
  const r = one("SELECT * FROM proposals WHERE id=?", proposalId);
  if (!r) throw httpErr(404, "No such proposal");
  if (r.kind !== "skill") throw httpErr(400, "Only a skill proposal can be linked to the profile");
  if (!docById(`profile:${file}`)) throw httpErr(400, "No such profile file");
  const p = toProposal(r), name = String((p.data as { name?: string }).name || "");
  await decide(proposalId, "reject");
  return withVault(async () => {
    const rel = `skills/${name}/SKILL.md`, doc = readDoc(rel), line = `see: profile/${file}`, t = now();
    if (doc && doc.body.split("\n").some((l) => l.trim() === line)) return { proposal: toProposal(one("SELECT * FROM proposals WHERE id=?", proposalId)!), skill: name };
    const fm = doc ? { ...doc.fm, version: (typeof doc.fm.version === "number" ? doc.fm.version : 1) + 1, updated_at: t }
      : { description: String((p.data as { description?: string }).description || ""), area: p.area, version: 1, updated_at: t };
    writeDoc(rel, { fm, body: doc ? `${doc.body.trimEnd()}\n\n${line}` : line });
    await commit([rel], `skill: ${name} → see profile/${file}`);
    indexPaths([rel]);
    trace(YOU, "skill.link", `skill:${name}`, "ok", null, line);
    return { proposal: toProposal(one("SELECT * FROM proposals WHERE id=?", proposalId)!), skill: name };
  });
}

/** Undo accept: forget the memory the accept wrote and put back the one it superseded. */
export function undoAccept(proposalId: string) {
  return withVault(async () => {
    const r = one("SELECT * FROM proposals WHERE id=?", proposalId);
    if (!r) throw httpErr(404, "No such proposal");
    if (r.kind !== "memory" || r.status !== "accepted") throw httpErr(400, "Only an accepted memory can be undone");
    const data = json<{ id: string; supersedes?: string | null }>(r.data, { id: "" });
    const { d, doc } = memoryDoc(data.id);
    if (doc.fm.status !== "active") throw httpErr(409, "Already undone, or it changed since");
    writeDoc(d.path, { fm: { ...doc.fm, status: "forgotten" }, body: doc.body });
    const paths = [d.path];
    let restored: string | null = null;
    const old = data.supersedes ? docById(data.supersedes) : null, od = old ? readDoc(old.path) : null;
    if (old && od && od.fm.status === "superseded" && od.fm.superseded_by === data.id) {
      writeDoc(old.path, { fm: { ...od.fm, status: "active", superseded_by: null }, body: od.body });
      paths.push(old.path); restored = old.id;
    }
    await commit(paths, `undo: ${short(doc.body)}`);
    indexPaths(paths);
    trace(YOU, "undo", proposalId, "ok", d.scope, `forgot ${data.id}${restored ? `, restored ${restored}` : ""}`);
    return { forgotten: memoryById(data.id)!, restored: restored ? memoryById(restored) : null };
  });
}
