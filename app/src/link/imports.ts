// "Move memories to Engram": Pitcrew's memories and Library receipts, accepted directly. Pitcrew is trusted, and you
// already saw each of these when the crew member made it there.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ArtifactKind, Memory, Source } from "../../shared/types.js";
import { now, uid, norm, httpErr, VAULT } from "../config.js";
import { one } from "../db.js";
import { writeDoc, writeRaw, commit, withVault } from "../vault.js";
import { indexPaths } from "../index.js";
import { MIMES, memoryFm, memoryPath } from "../proposals.js";
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
      const dup = made.get(key) ?? one<{ id: string }>("SELECT id FROM docs WHERE kind='memory' AND norm=? AND area=? AND scope='personal' ORDER BY status='active' DESC LIMIT 1", key, m.area)?.id;
      if (dup) { duplicates++; ids.push(dup); continue; }
      const t = when(it.created_at);
      const mem: Omit<Memory, "reads"> = {
        id: uid("m"), text, area: m.area, project: null, entities: [], scope: "personal", source: sourceFor(m, t), trust: "trusted", status: "active",
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
    trace(actorOf(link), "import", "memories", "ok", "personal", `${paths.length} from ${m.agent.name}, ${duplicates} already known`);
    return { accepted: paths.length, duplicates, ids };
  });
}

export function importArtifact(link: Agent, m: Member, a: { title: string; kind: ArtifactKind; mime: string; content_base64: string; created_at?: number }) {
  return withVault(async () => {
    const bytes = Buffer.from(a.content_base64, "base64");
    if (!bytes.length || bytes.length > MAX_FILE) throw httpErr(413, "File must be under 6 MB");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const dup = one<{ id: string }>("SELECT id FROM docs WHERE kind='artifact' AND json_extract(data,'$.sha256')=?", sha);
    if (dup) return { status: "accepted" as const, id: dup.id, reasons: [] as string[] };
    const mime = MIMES[a.mime] ? a.mime : "application/octet-stream", ext = MIMES[mime] || "bin", t = when(a.created_at);
    const id = uid("art"), rel = `artifacts/${id}.md`, file = `artifacts/files/${sha}.${ext}`;
    if (!existsSync(join(VAULT, file))) writeRaw(file, bytes);
    writeDoc(rel, { fm: { id, title: a.title, kind: a.kind, area: m.area, scope: "personal", source: sourceFor(m, t), mime, size: bytes.length, sha256: sha, ext, created_at: t }, body: "" });
    await commit([rel, file], `artifact: ${a.title.replace(/\s+/g, " ").slice(0, 60)}`);
    indexPaths([rel]);
    trace(actorOf(link), "import", id, "ok", "personal", `artifact from ${m.agent.name}`);
    return { status: "accepted" as const, id, reasons: [] as string[] };
  });
}
