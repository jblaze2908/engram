// The one in-process scheduler: a minute tick for the digest, notifications, the backup marker and the nightly dream
// pass. Nothing here runs per request.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, now } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import { digestDue, loadDigests } from "./digest.js";
import { notifyDigest, runningOutCheck, sweepProposals } from "./notify.js";
import { briefCheck } from "./brief.js";
import { dreamCheck } from "./dream.js";

// deploy/backup.sh writes the epoch ms of its last good run here; Status reads the cached value.
const MARKER = join(ROOT, "backups", "last-backup");
let backupAt: number | null = null;
const readMarker = () => { try { const n = existsSync(MARKER) ? Number(readFileSync(MARKER, "utf8").trim()) : NaN; backupAt = Number.isFinite(n) && n > 0 ? n : null; } catch { backupAt = null; } };
export const lastBackup = () => backupAt;

const RUNOUT_HOUR = 9;
export async function tick(t = now()) {
  readMarker();
  await sweepProposals(t);
  const d = await digestDue(t);
  if (d) await notifyDigest(d);
  if (new Date(t).getHours() >= RUNOUT_HOUR) await runningOutCheck(t);
  await briefCheck(t);
  dreamCheck(t);
}

export function startJobs() {
  if (!getSetting("installed_at")) setSetting("installed_at", now());
  loadDigests();
  readMarker();
  void sweepProposals();
  const t = setInterval(() => { tick().catch((e) => console.error("jobs tick failed:", (e as Error).message)); }, 60000);
  t.unref();
}
