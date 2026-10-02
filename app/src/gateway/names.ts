// The name an agent sees for an upstream tool. Clients prefix it as mcp__<server>__<name> and refuse anything past 64
// chars, so a long upstream name is cut and given a 6-char hash of the full name; the registered handler maps it back.
import { sha256 } from "./store.js";

const CLIENT_PREFIX = "mcp__engram__".length;
const MAX = 64;

export function exposedName(conn: string, tool: string) {
  const full = `${conn}__${tool}`;
  if (CLIENT_PREFIX + full.length <= MAX) return full;
  const keep = MAX - CLIENT_PREFIX - conn.length - 2 - 7;
  return `${conn}__${tool.slice(0, Math.max(1, keep))}_${sha256(tool).slice(0, 6)}`;
}

/** exposed name → upstream row, for every tool an agent may see. Names that would collide keep only the first. */
export function byExposed<T extends { conn_id: string; name: string }>(rows: T[]) {
  const m = new Map<string, T>();
  for (const r of rows) { const n = exposedName(r.conn_id, r.name); if (!m.has(n)) m.set(n, r); }
  return m;
}
