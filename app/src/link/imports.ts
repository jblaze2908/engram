// "Move memories to Engram": Pitcrew's memories and Library receipts, accepted directly. Pitcrew is trusted, and you
// already saw each of these when the crew member made it there.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ArtifactKind, LinkArtifactFilter, LinkArtifactPage, Memory, Source } from "../../shared/types.js";
import { now, uid, norm, httpErr, VAULT } from "../config.js";
import { one, all } from "../db.js";
import { artifacts } from "../store.js";
import { filtered, pageOf, count, WAITING } from "../artifacts/list.js";
import { writeDoc, writeRaw, commit, withVault } from "../vault.js";
import { indexPaths } from "../index.js";
import { memoryFm, memoryPath } from "../proposals.js";
import { publish } from "../artifacts/app.js";
import { MIME, extOf } from "../artifacts/shared.js";
import { trace } from "../trace.js";
import { actorOf, type Member } from "./members.js";

const MAX_FILE = 6 << 20;
const EARLIEST = Date.UTC(2000, 0, 1);
// A bad clock on the Pitcrew side must not file a memory under year 2100 or 1970.
const when = (t: number | undefined) => (t && t >= EARLIEST && t <= now() ? t : now());
const sourceFor = (m: Member, at: number): Source => ({ kind: "agent", label: `pitcrew:${m.agent.name}`, agent: m.agent.id, ref: null, at });

// ids lines up with items: the new memory, or the one it duplicates. Dedupe also covers forgotten memories, so a
// second migration can't bring back something you forgot.
export function importMemories(link: Agent, m: Member, items: { text: string; created_at?: number }[]) {
  return withVault(async () => {
    const paths: string[] = [], ids: string[] = [], made = new Map<string, string>();
    let duplicates = 0;
    for (const it of items) {
      const text = it.text.trim(), key = norm(text);
      const dup = made.get(key) ?? one<{ id: string }>("SELECT id FROM docs WHERE kind='memory' AND norm=? AND area=? AND scope=? ORDER BY status='active' DESC LIMIT 1", key, m.area, m.scope)?.id;
      if (dup) { duplicates++; ids.push(dup); continue; }
      const t = when(it.created_at);
      const mem: Omit<Memory, "reads"> = {
        id: uid("m"), text, area: m.area, project: null, entities: [], scope: m.scope, source: sourceFor(m, t), trust: "trusted", status: "active",
        observed_at: t, valid_from: null, valid_until: null, supersedes: null, superseded_by: null, created_at: t, accepted_at: now(),
      };
      const rel = memoryPath(mem);
      writeDoc(rel, { fm: memoryFm(mem), body: text });
      paths.push(rel); ids.push(mem.id); made.set(key, mem.id);
    }
    if (paths.length) {
      await commit(paths, `import: ${paths.length} memories from pitcrew:${m.agent.name}`);
      indexPaths(paths);
    }
    trace(actorOf(link), "import", "memories", "ok", m.scope, `${paths.length} from ${m.agent.name}, ${duplicates} already known`);
    return { accepted: paths.length, duplicates, ids };
  });
}

// The one-shot move: a Library file Engram already holds (any version of an active artifact) isn't published twice.
export async function importArtifact(link: Agent, m: Member, a: { title: string; kind: ArtifactKind; mime: string; content_base64: string; created_at?: number }) {
  const sha = createHash("sha256").update(Buffer.from(a.content_base64, "base64")).digest("hex");
  const dup = one<{ id: string }>("SELECT d.id FROM docs d, json_each(d.data,'$.versions') v WHERE d.kind='artifact' AND d.status='active' AND json_extract(v.value,'$.sha256')=?", sha);
  if (dup) return { status: "accepted" as const, id: dup.id, reasons: [] as string[] };
  const ext = Object.entries(MIME).find(([, x]) => x === a.mime)?.[0];
  const filename = extOf(a.title) !== "bin" || !ext ? a.title : `${a.title}.${ext}`;
  const r = await linkPublish(link, m, { title: a.title, filename, content_base64: a.content_base64, kind: a.kind });
  return { status: "accepted" as const, id: r.id, reasons: [] as string[] };
}

// POST /link/artifacts: the member agent publishes into its home scope and area; versions only its own artifacts.
export function linkPublish(link: Agent, m: Member, b: { title: string; filename: string; content_base64: string; id?: string | null; description?: string; public?: boolean; kind?: string; ref?: string }) {
  const source: Source = { kind: "agent", label: `pitcrew:${m.agent.name}`, agent: m.agent.id, ref: b.ref ?? null, at: now() };
  trace(actorOf(link), "link.publish", b.id || "artifact", "ok", m.scope, `${m.agent.name}: ${b.filename.slice(0, 60)}`);
  return publish({ agent: m.agent, actor: actorOf(m.agent), source }, { ...b, scope: m.scope, area: m.area });
}

// What Pitcrew members published, newest first, a page at a time; private scope never leaves Engram (artifacts/list.ts).
// Imported = moved from Pitcrew's old Library: no thread behind it.
const IMPORTED = "json_extract(data,'$.source.ref') IS NULL";

export function linkArtifacts(f: LinkArtifactFilter = {}): LinkArtifactPage {
  const members = new Map(all<{ agent_id: string; pitcrew_id: string }>("SELECT agent_id, pitcrew_id FROM link_members").map((r) => [r.agent_id, r.pitcrew_id]));
  const empty = { artifacts: [], next: null, counts: { total: 0, waiting: 0, imported: 0 } };
  if (!members.size) return empty;
  const ids = [...members.keys()];
  const base = [`kind='artifact'`, `status='active'`, `scope!='private'`, `json_extract(data,'$.source.agent') IN (${ids.map(() => "?").join(",")})`];
  const all_ = { where: base, args: ids };
  const counts = { total: count(all_, `NOT ${IMPORTED}`), waiting: count(all_, WAITING), imported: count(all_, IMPORTED) };
  let by: string | undefined;
  if (f.member) {
    by = [...members].find(([, pid]) => pid === f.member)?.[0];
    if (!by) return { ...empty, counts };
  }
  // Library "kind" is the file format (artifacts/list.ts TYPES).
  const s = filtered({ where: [...base, f.imported ? IMPORTED : `NOT ${IMPORTED}`], args: ids }, { q: f.q, by, status: f.status, type: f.kind });
  if (!s) return { ...empty, counts };
  const { rows: page, next } = pageOf(s, f.cursor, f.limit ?? 40);
  const pending = new Set(all<{ ref: string }>("SELECT source_ref ref FROM proposals WHERE kind='share' AND status='open'").map((r) => r.ref));
  return {
    artifacts: artifacts(page).map((a) => {
      const v = a.versions?.at(-1);
      return { id: a.id, title: a.title, kind: String(a.kind), pitcrew_id: members.get(a.source.agent || "")!, version: a.version || a.versions?.length || 1,
        mime: v?.mime ?? a.mime ?? null, size: v?.size ?? a.size ?? null, url: a.url, public_url: a.public_url, share_pending: !a.public_url && pending.has(a.id),
        ref: a.source.ref ?? null, created_at: a.created_at, updated_at: v?.at ?? a.updated_at ?? a.created_at };
    }),
    next,
    counts,
  };
}
