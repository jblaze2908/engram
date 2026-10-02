// "Add from catalog": hand-picked servers (catalog.json, each URL checked against the vendor's docs) first, then the
// official MCP Registry's streamable-http remotes. Registry results go through the SSRF guard and are cached 24 h per query.
import { discoverOAuthServerInfo, extractWWWAuthenticateParams } from "@modelcontextprotocol/client";
import type { CatalogEntry, ConnectionAuth } from "../../shared/types.js";
import curated from "./catalog.json" with { type: "json" };
import { now, slugify, httpErr } from "../config.js";
import { db, one, run } from "../db.js";
import { assertPublicUrl, checkUrl, safeFetch } from "./net.js";
import { connRows } from "./store.js";

db.exec("CREATE TABLE IF NOT EXISTS catalog_cache (q TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)");

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
  for (const { server: s, _meta } of list.slice(0, 50)) {
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
      docs: typeof s.websiteUrl === "string" && /^https:\/\//.test(s.websiteUrl) ? s.websiteUrl.slice(0, 500) : null, tokenHelp: null, icon: icon?.slice(0, 500) ?? null, source: "registry",
    });
  }
  return out;
}

async function fetchRegistry(q: string) {
  const r = await safeFetch(`${registry()}/v0.1/servers?${new URLSearchParams({ search: q, limit: "30", version: "latest" })}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw httpErr(502, `registry answered ${r.status}`); }
  const body = await r.json() as { servers?: Listed[] };
  return fromRegistry(Array.isArray(body.servers) ? body.servers : []);
}

// One fetch per query a day: concurrent asks share it, a failure isn't cached and falls back to a stale copy.
const inflight = new Map<string, Promise<CatalogEntry[]>>();
async function registryHits(q: string): Promise<CatalogEntry[]> {
  const row = one<{ body: string; at: number }>("SELECT body, at FROM catalog_cache WHERE q=?", q);
  if (row && now() - row.at < TTL) return JSON.parse(row.body);
  let p = inflight.get(q);
  if (!p) {
    p = fetchRegistry(q).then((e) => {
      run("INSERT INTO catalog_cache(q,body,at) VALUES(?,?,?) ON CONFLICT(q) DO UPDATE SET body=excluded.body, at=excluded.at", q, JSON.stringify(e), now());
      run("DELETE FROM catalog_cache WHERE at<?", now() - TTL);
      return e;
    }).finally(() => inflight.delete(q));
    inflight.set(q, p);
  }
  try { return await p; } catch (e) {
    console.error("catalog: registry unavailable:", (e as Error).message);
    return row ? JSON.parse(row.body) : [];
  }
}

/** Curated matches first; registry results only for 2+ characters, minus servers already curated. */
export async function catalog(raw: string): Promise<CatalogEntry[]> {
  const q = raw.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60), words = q.split(" ").filter(Boolean);
  const mine = CURATED.filter((e) => words.every((w) => `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(w)));
  const curatedUrls = new Set(CURATED.map((e) => same(e.url)));
  const reg = q.length >= 2 ? (await registryHits(q)).filter((e) => !curatedUrls.has(same(e.url))) : [];
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
