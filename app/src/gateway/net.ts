// Every upstream request (MCP calls, OAuth discovery, registration, tokens) goes through safeFetch. https only; any
// address that resolves to private, loopback, link-local or reserved space is refused. The check runs inside the
// socket's DNS lookup, so the address that was checked is the one connected to (no rebinding window).
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { httpErr } from "../config.js";

const BLOCKED = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const)
  BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
  BLOCKED.addSubnet(net, bits, "ipv6");

// Tests run a mock upstream on http://127.0.0.1; nothing else is ever let through.
const devLocal = (host: string) => process.env.ENGRAM_DEV_ALLOW_LOCAL === "1" && host === "127.0.0.1";
const refused = (host: string) => httpErr(400, `Refused ${host}: Engram only connects to public https servers`);

function blocked(address: string, host: string) {
  if (devLocal(host) && address === "127.0.0.1") return false;
  const v6 = isIP(address) === 6, mapped = v6 ? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) : null;
  if (mapped) return BLOCKED.check(mapped[1], "ipv4");
  return BLOCKED.check(address, v6 ? "ipv6" : "ipv4");
}

/** Scheme and literal-address rules; hostnames are checked again at connect time by the lookup below. */
export function checkUrl(u: URL) {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.username || u.password) throw httpErr(400, "Put credentials in the auth settings, not the URL");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && devLocal(host))) throw refused(host);
  if (isIP(host) && blocked(host, host)) throw refused(host);
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw refused(host);
}

/** Resolves once at add time so a private address is refused before anything is stored. */
export async function assertPublicUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw httpErr(400, "That isn't a URL"); }
  checkUrl(u);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return u;
  const addrs = await new Promise<LookupAddress[]>((ok, no) => lookup(host, { all: true }, (e, a) => (e ? no(httpErr(400, `Can't find ${host}`)) : ok(a))));
  if (!addrs.length || addrs.some((a) => blocked(a.address, host))) throw refused(host);
  return u;
}

function guardedLookup(host: string) {
  return (hostname: string, options: object, cb: (...a: any[]) => void) =>
    lookup(hostname, { ...options, all: true }, (err, addrs: LookupAddress[]) => {
      if (err) return cb(err);
      if (!addrs.length || addrs.some((a) => blocked(a.address, host))) return cb(refused(host));
      if ((options as { all?: boolean }).all) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    });
}

// Bounds what one upstream response can make us buffer; long-lived event streams are exempt.
const MAX_BODY = 4 << 20;
const capped = (max: number) => {
  let n = 0;
  return new Transform({ transform(chunk: Buffer, _e, cb) { n += chunk.length; cb(n > max ? httpErr(413, "Upstream response too large") : null, chunk); } });
};
const NULL_BODY = new Set([101, 204, 205, 304]);

function bodyOf(b: RequestInit["body"], headers: Headers): string | Buffer | undefined {
  if (b == null) return undefined;
  if (typeof b === "string") return b;
  if (b instanceof URLSearchParams) { if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded"); return b.toString(); }
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return Buffer.from(b as ArrayBuffer);
  throw httpErr(500, "Unsupported request body");
}

/** A fetch for the MCP client SDK. Redirects are followed by hand (max 5) so each hop is checked too; redirect "manual" returns the 3xx. */
export async function safeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : String(input));
  let method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("accept-encoding", "identity");
  let body = bodyOf(init.body, headers);
  for (let hop = 0; hop < 6; hop++) {
    checkUrl(url);
    const res = await send(url, method, headers, body, init.signal ?? undefined);
    const loc = res.headers.location;
    if (init.redirect !== "manual" && [301, 302, 303, 307, 308].includes(res.statusCode || 0) && loc) {
      res.resume();
      url = new URL(loc, url);
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) { method = "GET"; body = undefined; headers.delete("content-type"); }
      continue;
    }
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
    const status = res.statusCode || 502;
    const stream = h.get("content-type")?.includes("text/event-stream") ? res : res.pipe(capped(MAX_BODY));
    return new Response(NULL_BODY.has(status) ? null : (Readable.toWeb(stream) as ReadableStream), { status, statusText: res.statusMessage, headers: h });
  }
  throw httpErr(502, "Too many redirects");
}

function send(url: URL, method: string, headers: Headers, body: string | Buffer | undefined, signal?: AbortSignal) {
  return new Promise<IncomingMessage>((ok, no) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const h: Record<string, string> = {};
    headers.forEach((v, k) => { h[k] = v; });
    if (body !== undefined) h["content-length"] = String(Buffer.byteLength(body));
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method, headers: h, lookup: guardedLookup(host) as any, signal, timeout: 120_000 }, ok);
    req.on("timeout", () => req.destroy(httpErr(504, "Upstream timed out")));
    req.on("error", no);
    req.end(body);
  });
}
