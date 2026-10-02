// "Add from catalog": hand-picked servers (catalog.json, each URL checked against the vendor's docs) first, then the
// official MCP Registry's streamable-http remotes. Registry results go through the SSRF guard and are cached 24 h per query.
import { discoverOAuthServerInfo, extractWWWAuthenticateParams } from "@modelcontextprotocol/client";
import type { CatalogEntry, ConnectionAuth } from "../../shared/types.js";
import curated from "./catalog.json" with { type: "json" };
import { now, slugify, httpErr } from "../config.js";
import { all, db, one, run } from "../db.js";
import { assertPublicUrl, checkUrl, safeFetch } from "./net.js";
import { connRows } from "./store.js";

// The registry's search answers in 20–25 s uncached (measured 2026-10-02), so the whole list is synced daily and searched here.
db.exec(`DROP TABLE IF EXISTS catalog_cache;
CREATE TABLE IF NOT EXISTS catalog_registry (name TEXT PRIMARY KEY, body TEXT NOT NULL, text TEXT NOT NULL);`);

const TTL = 24 * 3600_000;
const CURATED = (curated as Omit<CatalogEntry, "source">[]).map((e): CatalogEntry => ({ ...e, source: "curated" }));
// Read per call so tests can point it at a local mock.
const registry = () => (process.env.ENGRAM_REGISTRY_URL || "https://registry.modelcontextprotocol.io").replace(/\/+$/, "");
const same = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ""); } catch { return u; } };
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

// No templated URLs ({tenant}); scheme and literal-address rules as for a connection, re-checked when you add it.
const fetchable = (u: unknown) => {
  if (typeof u !== "string" || u.length > 500 || /[{}\s]/.test(u)) return false;
  try { checkUrl(new URL(u)); return true; } catch { return false; }
};
type Remote = { type?: string; url?: string; headers?: { name?: string; isRequired?: boolean }[] };
type Listed = { server?: { name?: string; title?: string; description?: string; websiteUrl?: string; remotes?: Remote[]; icons?: { src?: string }[] }; _meta?: Record<string, { status?: string }> };

/** Publisher text is untrusted: clipped, and shown only as text. auth is a guess until you probe it on pick. */
function fromRegistry(list: Listed[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const { server: s, _meta } of list) {
    if (!s?.name || _meta?.["io.modelcontextprotocol.registry/official"]?.status === "deleted") continue;
    // A required header other than Authorization (or a templated URL) is something Engram can't send.
    const r = (s.remotes || []).find((x) => x.type === "streamable-http" && fetchable(x.url)
      && !(x.headers || []).some((h) => h.isRequired && !/^authorization$/i.test(h.name || "")));
    if (!r) continue;
    const bearer = (r.headers || []).some((h) => h.isRequired && /^authorization$/i.test(h.name || ""));
    const icon = s.icons?.find((i) => typeof i.src === "string" && /^https:\/\//.test(i.src))?.src;
    out.push({
      id: slugify(s.title || s.name.split("/").pop() || s.name).slice(0, 12).replace(/-+$/, ""), name: clip(s.title || s.name, 80),
      description: clip(s.description, 200), url: r.url!, auth: bearer ? "bearer" : "oauth", dcr: null, untrusted: true,
      publisher: s.name.slice(0, 200), docs: typeof s.websiteUrl === "string" && /^https:\/\//.test(s.websiteUrl) ? s.websiteUrl.slice(0, 500) : null, tokenHelp: null, icon: icon?.slice(0, 500) ?? null, source: "registry",
    });
  }
  return out;
}

const SYNC_EVERY = 24 * 3600_000, PAGES = 200;
let syncing: Promise<number> | null = null;

/** Pages through every latest server (100 a page, cursor-based); keeps the old list if any page fails. */
async function syncRegistry(): Promise<number> {
  const found: CatalogEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    const qs = new URLSearchParams({ limit: "100", version: "latest", ...(cursor ? { cursor } : {}) });
    const r = await safeFetch(`${registry()}/v0.1/servers?${qs}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw httpErr(502, `registry answered ${r.status}`); }
    const body = await r.json() as { servers?: Listed[]; metadata?: { nextCursor?: string } };
    found.push(...fromRegistry(Array.isArray(body.servers) ? body.servers : []));
    cursor = typeof body.metadata?.nextCursor === "string" ? body.metadata.nextCursor : undefined;
    if (!cursor) break;
  }
  db.exec("BEGIN");
  try {
    run("DELETE FROM catalog_registry");
    for (const e of found) run("INSERT OR REPLACE INTO catalog_registry(name,body,text) VALUES(?,?,?)", e.url, JSON.stringify(e), `${e.id} ${e.name} ${e.description}`.toLowerCase());
    run("INSERT INTO settings(key,value) VALUES('catalog_synced',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(now()));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return found.length;
}

/** One sync at a time; called at boot and hourly, a no-op until the list is a day old. */
export function refreshRegistry(force = false) {
  const last = Number(one<{ value: string }>("SELECT value FROM settings WHERE key='catalog_synced'")?.value || 0);
  if (syncing || (!force && now() - last < SYNC_EVERY)) return syncing;
  syncing = syncRegistry().then((n) => { console.log(`catalog: ${n} registry servers synced`); return n; })
    .catch((e) => { console.error("catalog: registry sync failed:", (e as Error).message); return 0; })
    .finally(() => { syncing = null; });
  return syncing;
}

/** A verified namespace like com.notion/… owning the URL's host (mcp.notion.com) is the strongest signal an entry is the vendor's own. */
const ownsHost = (e: CatalogEntry) => {
  const ns = (e.publisher || "").split("/")[0].split(".").reverse().join(".");
  try { const h = new URL(e.url).hostname; return !!ns && ns.includes(".") && (h === ns || h.endsWith(`.${ns}`)); } catch { return false; }
};

/** Every word must appear; then title hits beat description hits, and publisher-owned hosts rank first. */
function registryHits(words: string[]): CatalogEntry[] {
  if (!words.length) return [];
  const where = words.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
  const like = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const score = (e: CatalogEntry) => {
    const title = `${e.id} ${e.name}`.toLowerCase(), desc = e.description.toLowerCase();
    return words.reduce((n, w) => n + (title.includes(w) ? 3 : desc.includes(w) ? 1 : 0), 0) + (ownsHost(e) ? 4 : 0);
  };
  return all<{ body: string }>(`SELECT body FROM catalog_registry WHERE ${where} LIMIT 500`, ...like)
    .map((r) => JSON.parse(r.body) as CatalogEntry)
    .map((e) => ({ e, n: score(e) })).sort((a, b) => b.n - a.n || a.e.name.localeCompare(b.e.name)).slice(0, 30).map((x) => ({ ...x.e, verified: ownsHost(x.e) }));
}

/** Curated matches; registry results (unreviewed) only when asked for, for 2+ characters, minus servers already curated. */
export async function catalog(raw: string, community = false): Promise<CatalogEntry[]> {
  const q = raw.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60), words = q.split(" ").filter(Boolean);
  const mine = CURATED.filter((e) => words.every((w) => `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(w)));
  const curatedUrls = new Set(CURATED.map((e) => same(e.url)));
  const reg = community && q.length >= 2 ? registryHits(words).filter((e) => !curatedUrls.has(same(e.url))) : [];
  const have = new Set(connRows().map((c) => same(c.url)));
  return [...mine, ...reg].map((e) => ({ ...e, connected: have.has(same(e.url)) }));
}

/** How a server wants to be signed in to: an unauthenticated initialize, then RFC 9728 and RFC 8414/OIDC metadata. */
export async function probe(raw: string): Promise<{ auth: ConnectionAuth; dcr: boolean | null; scopes: string[] }> {
  const url = await assertPublicUrl(raw);
  const res = await safeFetch(url, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engram", version: "0.2.0" } } }),
  });
  await res.body?.cancel().catch(() => {});
  if (res.ok) return { auth: "none", dcr: null, scopes: [] };
  if (res.status !== 401 && res.status !== 403) throw httpErr(400, `It didn't answer like an MCP server (HTTP ${res.status})`);
  const info = await discoverOAuthServerInfo(url, { resourceMetadataUrl: extractWWWAuthenticateParams(res).resourceMetadataUrl, fetchFn: safeFetch }).catch(() => null);
  const as = info?.authorizationServerMetadata, prm = info?.resourceMetadata;
  if (!as) return { auth: "bearer", dcr: null, scopes: [] };
  const scopes = (prm?.scopes_supported ?? as.scopes_supported ?? []).filter((s): s is string => typeof s === "string").slice(0, 50).map((s) => s.slice(0, 100));
  return { auth: "oauth", dcr: !!as.registration_endpoint, scopes };
}
