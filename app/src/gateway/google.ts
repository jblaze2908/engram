// The built-in Google connection: Engram signs in with your own OAuth client and calls the ordinary Gmail, Calendar and
// Drive APIs, which work for personal accounts (Google's own MCP servers are Workspace-only previews). Its tools are an
// MCP server in this process, so the gateway grants, gates, pins and audits them like any upstream's.
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { httpErr, now } from "../config.js";
import { safeFetch } from "./net.js";
import { getJson, putJson, getSecret, putSecret } from "./secrets.js";

export const BUILTIN_GOOGLE = "builtin:google";
// Overridable only so tests can stand in for Google on 127.0.0.1.
const OAUTH = (process.env.ENGRAM_GOOGLE_OAUTH || "https://accounts.google.com").replace(/\/$/, "");
const TOKEN = process.env.ENGRAM_GOOGLE_TOKEN || "https://oauth2.googleapis.com/token";
const API = (process.env.ENGRAM_GOOGLE_API || "https://www.googleapis.com").replace(/\/$/, "");
const GMAIL = (process.env.ENGRAM_GOOGLE_GMAIL || "https://gmail.googleapis.com").replace(/\/$/, "");
const UPLOAD = (process.env.ENGRAM_GOOGLE_UPLOAD || "https://www.googleapis.com/upload").replace(/\/$/, "");

const S = {
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  // compose also covers sending a draft; Engram exposes no send tool, so agents can only create drafts.
  gmailDraft: "https://www.googleapis.com/auth/gmail.compose",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  // Create and delete events; the tools only add attendee-free events and only delete ones Engram made.
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
  drive: "https://www.googleapis.com/auth/drive.readonly",
  // Only files Engram itself creates: it can't change or delete anything else in your Drive.
  driveFile: "https://www.googleapis.com/auth/drive.file",
};
export const GOOGLE_SCOPES = Object.values(S);

type Client = { client_id: string; client_secret?: string };
type Tokens = { access_token: string; refresh_token: string; expires_at: number; scope: string };
const sec = (id: string, k: string) => `conn:${id}:${k}`;
const b64url = (b: Buffer) => b.toString("base64url");

// ---------- sign-in ----------

/** The consent URL for one sign-in; the PKCE verifier waits in the secrets table for the callback. */
export function googleAuthUrl(id: string, redirect: string, state: string) {
  const client = getJson<Client>(sec(id, "client"));
  if (!client?.client_id) throw httpErr(400, "Put credentials: paste your Google OAuth client id and secret");
  const verifier = b64url(randomBytes(32));
  putSecret(sec(id, "verifier"), verifier);
  const u = new URL(`${OAUTH}/o/oauth2/v2/auth`);
  for (const [k, v] of Object.entries({
    client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
    // offline + consent so Google returns a refresh token every time, not only on the first sign-in.
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  })) u.searchParams.set(k, v);
  return u.href;
}

async function tokenCall(id: string, form: Record<string, string>) {
  const client = getJson<Client>(sec(id, "client"));
  if (!client?.client_id) throw httpErr(400, "Put credentials: paste your Google OAuth client id and secret");
  const res = await safeFetch(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) }).toString() });
  const body = await res.json().catch(() => ({})) as Record<string, any>;
  // invalid_grant: the refresh token was revoked or expired (a "Testing" consent screen expires them after 7 days).
  if (!res.ok) throw httpErr(res.status === 400 && body.error === "invalid_grant" ? 401 : 502, body.error === "invalid_grant" ? "Sign in again" : "Google refused the sign-in");
  return body;
}

export async function googleExchange(id: string, code: string, redirect: string) {
  const verifier = getSecret(sec(id, "verifier"));
  if (!verifier) throw httpErr(409, "Start the sign-in again");
  const t = await tokenCall(id, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier });
  if (!t.access_token || !t.refresh_token) throw httpErr(502, "Google sent no refresh token; remove Engram's access in your Google account and sign in again");
  putJson(sec(id, "tokens"), { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now() + (Number(t.expires_in) || 3600) * 1000, scope: String(t.scope || "") } satisfies Tokens);
}

const refreshing = new Map<string, Promise<Tokens>>();
/** A live access token: the stored one until a minute before expiry, then one refresh shared by concurrent callers. */
export async function accessToken(id: string): Promise<Tokens> {
  const t = getJson<Tokens>(sec(id, "tokens"));
  if (!t?.refresh_token) throw httpErr(401, "Sign in again");
  if (t.expires_at - 60_000 > now()) return t;
  let p = refreshing.get(id);
  if (!p) {
    p = tokenCall(id, { grant_type: "refresh_token", refresh_token: t.refresh_token }).then((r) => {
      const next: Tokens = { access_token: r.access_token, refresh_token: r.refresh_token || t.refresh_token, expires_at: now() + (Number(r.expires_in) || 3600) * 1000, scope: String(r.scope || t.scope) };
      putJson(sec(id, "tokens"), next);
      return next;
    }).finally(() => refreshing.delete(id));
    refreshing.set(id, p);
  }
  return p;
}

// ---------- Google API calls ----------

class GoogleError extends Error { constructor(message: string, public status: number) { super(message); } }
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const failed = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });

/** One authenticated call. Google's error text is not passed on: only the status, mapped to a short sentence. */
async function g(id: string, url: string, init: RequestInit = {}, as: "json" | "text" = "json") {
  const t = await accessToken(id);
  const res = await safeFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${t.access_token}` } });
  if (!res.ok) {
    const why = res.status === 401 ? "Google wants you to sign in again" : res.status === 403 ? "Google refused: this sign-in doesn't allow that, or the API isn't enabled in your Cloud project"
      : res.status === 404 ? "Not found" : res.status === 429 ? "Google's rate limit; try again shortly" : `Google answered ${res.status}`;
    throw new GoogleError(why, res.status);
  }
  return as === "json" ? res.json() as Promise<any> : res.text();
}
const guard = <A,>(id: string, need: string, fn: (a: A) => Promise<unknown>) => async (a: A) => {
  if (!(getJson<Tokens>(sec(id, "tokens"))?.scope || "").split(" ").includes(need)) return failed("This Google sign-in didn't grant that; press Connect on the Google connection and allow it");
  try { return text(await fn(a)); } catch (e) { return failed(e instanceof GoogleError ? e.message : (e as Error).message || "Google call failed"); }
};

// ---------- Gmail ----------

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const header = (m: any, n: string) => (m?.payload?.headers || []).find((h: any) => String(h.name).toLowerCase() === n)?.value ?? null;
const summary = (m: any) => ({ id: m.id, thread_id: m.threadId, from: header(m, "from"), to: header(m, "to"), subject: header(m, "subject"), date: header(m, "date"), snippet: m.snippet ?? "", labels: m.labelIds ?? [] });
const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
const BODY_MAX = 50_000;
function bodyOf(part: any): { text: string; html: string; files: { filename: string; mime: string; size: number }[] } {
  const out = { text: "", html: "", files: [] as { filename: string; mime: string; size: number }[] };
  const walk = (p: any) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) out.files.push({ filename: String(p.filename).slice(0, 200), mime: p.mimeType, size: p.body.size ?? 0 });
    else if (p.mimeType === "text/plain" && !out.text) out.text = decode(p.body?.data);
    else if (p.mimeType === "text/html" && !out.html) out.html = decode(p.body?.data);
    for (const c of p.parts || []) walk(c);
  };
  walk(part);
  return out;
}
// Enough to read an HTML-only mail; not a renderer.
const htmlText = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();

// Header values go into a raw RFC 2822 message: no CR/LF, so nothing can add a header (Bcc, say) of its own.
const oneLine = z.string().max(1000).refine((s) => !/[\r\n]/.test(s), "no line breaks");
const Addr = z.string().max(320).regex(/^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/, "a plain email address");
const mime = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

// ---------- for Engram's own jobs ----------

export type Attendee = { email: string; name: string | null; self: boolean };
export type UpcomingEvent = { id: string; summary: string; start: string; location: string | null; attendees: Attendee[] };
/** Timed events on the primary calendar between two times (people briefs). One Google request; null if not signed in for Calendar. */
export async function upcomingEvents(id: string, from: string, to: string): Promise<UpcomingEvent[] | null> {
  if (!(getJson<Tokens>(sec(id, "tokens"))?.scope || "").split(" ").includes(S.calendar)) return null;
  const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "20" });
  const items = (await g(id, `${API}/calendar/v3/calendars/primary/events?${q}`)).items || [];
  return items.filter((e: any) => e.status !== "cancelled" && e.start?.dateTime).map((e: any) => ({
    id: String(e.id), summary: String(e.summary ?? "").slice(0, 200), start: e.start.dateTime, location: e.location ?? null,
    attendees: (e.attendees || []).map((x: any) => ({ email: String(x.email || ""), name: x.displayName ?? null, self: !!x.self })),
  }));
}

// ---------- the server ----------

/** Built per connection client (gateway/upstream.ts caches one), from the scopes this sign-in actually granted. */
export function googleServer(id: string) {
  const s = new McpServer({ name: "google", version: "1.0.0" });
  const ro = { readOnlyHint: true, openWorldHint: true };

  s.registerTool("gmail_search", {
    description: "Search your Gmail with Gmail's own query syntax (from:, subject:, newer_than:7d, has:attachment …). Returns sender, subject, date and a snippet per message.",
    inputSchema: z.object({ query: z.string().max(500).describe("Gmail search, e.g. \"from:bescom newer_than:30d\""), max: z.number().int().min(1).max(20).optional().describe("how many, default 10") }),
    annotations: ro,
  }, guard(id, S.gmailRead, async (a: { query: string; max?: number }) => {
    // Per call: one list plus one metadata read per message (at most 21 Google requests).
    const list = await g(id, `${GMAIL}/gmail/v1/users/me/messages?${new URLSearchParams({ q: a.query, maxResults: String(a.max ?? 10) })}`);
    const meta = new URLSearchParams([["format", "metadata"], ...["From", "To", "Subject", "Date"].map((h) => ["metadataHeaders", h])]);
    const msgs = await Promise.all((list.messages || []).map((m: { id: string }) => g(id, `${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?${meta}`)));
    return { messages: msgs.map(summary) };
  }));

  s.registerTool("gmail_read", {
    description: "Read one Gmail message by id (from gmail_search): headers, the text body and the names of its attachments.",
    inputSchema: z.object({ id: ID }), annotations: ro,
  }, guard(id, S.gmailRead, async (a: { id: string }) => {
    const m = await g(id, `${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(a.id)}?format=full`);
    const b = bodyOf(m.payload), body = (b.text || htmlText(b.html)).slice(0, BODY_MAX);
    return { ...summary(m), cc: header(m, "cc"), body, truncated: (b.text || b.html).length > BODY_MAX, attachments: b.files };
  }));

  s.registerTool("gmail_create_draft", {
    description: "Create a Gmail draft (never sends). Pass reply_to with a message id to draft a reply in that thread.",
    inputSchema: z.object({
      to: z.array(Addr).min(1).max(20), cc: z.array(Addr).max(20).optional(), subject: oneLine, body: z.string().max(50_000).describe("plain text"),
      reply_to: ID.optional().describe("id of the message this answers"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guard(id, S.gmailDraft, async (a: { to: string[]; cc?: string[]; subject: string; body: string; reply_to?: string }) => {
    let thread: string | undefined, refs: string[] = [];
    if (a.reply_to) {
      const o = await g(id, `${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(a.reply_to)}?${new URLSearchParams([["format", "metadata"], ["metadataHeaders", "Message-ID"]])}`);
      thread = o.threadId;
      const mid = header(o, "message-id");
      if (mid && !/[\r\n]/.test(mid)) refs = [`In-Reply-To: ${mid}`, `References: ${mid}`];
    }
    const raw = [`To: ${a.to.join(", ")}`, ...(a.cc?.length ? [`Cc: ${a.cc.join(", ")}`] : []), `Subject: ${mime(a.subject)}`, ...refs,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(a.body, "utf8").toString("base64")].join("\r\n");
    const d = await g(id, `${GMAIL}/gmail/v1/users/me/drafts`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { raw: Buffer.from(raw, "utf8").toString("base64url"), ...(thread ? { threadId: thread } : {}) } }) });
    return { draft_id: d.id, message_id: d.message?.id ?? null, thread_id: d.message?.threadId ?? thread ?? null };
  }));

  // ---------- Calendar ----------
  const Cal = z.string().max(300).optional().describe("calendar id from calendar_list; default your primary calendar");
  const When = z.string().max(40).describe("RFC 3339, e.g. 2026-10-02T00:00:00+05:30");
  const event = (e: any) => ({ id: e.id, summary: e.summary ?? null, start: e.start?.dateTime ?? e.start?.date ?? null, end: e.end?.dateTime ?? e.end?.date ?? null,
    location: e.location ?? null, status: e.status, organizer: e.organizer?.email ?? null, attendees: (e.attendees || []).map((x: any) => ({ email: x.email, response: x.responseStatus })),
    description: typeof e.description === "string" ? e.description.slice(0, 2000) : null, link: e.htmlLink ?? null });

  s.registerTool("calendar_list", { description: "Your Google calendars: id, name and whether it's the primary one.", inputSchema: z.object({}), annotations: ro },
    guard(id, S.calendar, async () => ({ calendars: ((await g(id, `${API}/calendar/v3/users/me/calendarList`)).items || []).map((c: any) => ({ id: c.id, name: c.summary, primary: !!c.primary, access: c.accessRole })) })));

  s.registerTool("calendar_events", {
    description: "Events between two times, soonest first, with recurring events expanded.",
    inputSchema: z.object({ from: When, to: When, query: z.string().max(200).optional().describe("words to match"), calendar: Cal, max: z.number().int().min(1).max(100).optional() }),
    annotations: ro,
  }, guard(id, S.calendar, async (a: { from: string; to: string; query?: string; calendar?: string; max?: number }) => {
    const q = new URLSearchParams({ timeMin: a.from, timeMax: a.to, singleEvents: "true", orderBy: "startTime", maxResults: String(a.max ?? 25), ...(a.query ? { q: a.query } : {}) });
    return { events: ((await g(id, `${API}/calendar/v3/calendars/${encodeURIComponent(a.calendar || "primary")}/events?${q}`)).items || []).map(event) };
  }));

  s.registerTool("calendar_freebusy", {
    description: "When you're busy between two times (no event details).",
    inputSchema: z.object({ from: When, to: When, calendar: Cal }), annotations: ro,
  }, guard(id, S.calendar, async (a: { from: string; to: string; calendar?: string }) => {
    const cal = a.calendar || "primary";
    const r = await g(id, `${API}/calendar/v3/freeBusy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeMin: a.from, timeMax: a.to, items: [{ id: cal }] }) });
    return { busy: r.calendars?.[cal]?.busy ?? [] };
  }));

  // Events Engram makes carry this private property; delete refuses anything without it.
  const MINE = { private: { engram: "1" } };
  s.registerTool("calendar_create_event", {
    description: "Block time on your calendar: an event with no guests (nothing is sent to anyone). Busy and private unless you say otherwise.",
    inputSchema: z.object({
      title: oneLine.pipe(z.string().min(1).max(200)), start: When, end: When, notes: z.string().max(4000).optional(), location: oneLine.optional(),
      free: z.boolean().optional().describe("show as free instead of busy"), calendar: Cal,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guard(id, S.calendarWrite, async (a: { title: string; start: string; end: string; notes?: string; location?: string; free?: boolean; calendar?: string }) => {
    if (!(Date.parse(a.end) > Date.parse(a.start))) throw new Error("end must be after start");
    const e = await g(id, `${API}/calendar/v3/calendars/${encodeURIComponent(a.calendar || "primary")}/events?sendUpdates=none`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: a.title, start: { dateTime: a.start }, end: { dateTime: a.end }, ...(a.notes ? { description: a.notes } : {}), ...(a.location ? { location: a.location } : {}),
        transparency: a.free ? "transparent" : "opaque", visibility: "private", extendedProperties: MINE }) });
    return event(e);
  }));

  s.registerTool("calendar_delete_event", {
    description: "Delete an event that Engram created (from calendar_create_event). Refuses any other event.",
    inputSchema: z.object({ id: ID, calendar: Cal }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, guard(id, S.calendarWrite, async (a: { id: string; calendar?: string }) => {
    const base = `${API}/calendar/v3/calendars/${encodeURIComponent(a.calendar || "primary")}/events/${encodeURIComponent(a.id)}`;
    const e = await g(id, base);
    if (e.extendedProperties?.private?.engram !== "1") throw new Error("Engram didn't create this event, so it won't delete it");
    await g(id, `${base}?sendUpdates=none`, { method: "DELETE" }, "text");
    return { deleted: a.id, title: e.summary ?? null };
  }));

  // ---------- Drive ----------
  const EXPORT: Record<string, string> = { "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv", "application/vnd.google-apps.presentation": "text/plain" };
  const READ_MAX = 200_000;

  s.registerTool("drive_search", {
    description: "Find files in your Google Drive by words in their name or content.",
    inputSchema: z.object({ text: z.string().min(1).max(200), max: z.number().int().min(1).max(50).optional() }), annotations: ro,
  }, guard(id, S.drive, async (a: { text: string; max?: number }) => {
    // Drive's query language: the text is a quoted literal, so quotes and backslashes are escaped and nothing else gets in.
    const lit = a.text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = new URLSearchParams({ q: `fullText contains '${lit}' and trashed = false`, pageSize: String(a.max ?? 20), fields: "files(id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress))" });
    return { files: ((await g(id, `${API}/drive/v3/files?${q}`)).files || []).map((f: any) => ({ id: f.id, name: f.name, mime: f.mimeType, modified: f.modifiedTime, size: f.size ? Number(f.size) : null, owner: f.owners?.[0]?.emailAddress ?? null, link: f.webViewLink })) };
  }));

  s.registerTool("drive_read", {
    description: "Read a Drive file as text: Google Docs and Slides as plain text, Sheets as CSV, and text files as they are. Other types (PDFs, images) return only their details and link.",
    inputSchema: z.object({ id: ID }), annotations: ro,
  }, guard(id, S.drive, async (a: { id: string }) => {
    const f = await g(id, `${API}/drive/v3/files/${encodeURIComponent(a.id)}?fields=id,name,mimeType,size,webViewLink`);
    const as = EXPORT[f.mimeType];
    const plain = /^text\//.test(f.mimeType) || f.mimeType === "application/json";
    if (!as && !plain) return { id: f.id, name: f.name, mime: f.mimeType, link: f.webViewLink, text: null, note: "Not a text type; open the link in the browser" };
    if (plain && Number(f.size) > READ_MAX) return { id: f.id, name: f.name, mime: f.mimeType, link: f.webViewLink, text: null, note: "Larger than 200 KB" };
    const body = String(await g(id, as ? `${API}/drive/v3/files/${encodeURIComponent(a.id)}/export?${new URLSearchParams({ mimeType: as })}` : `${API}/drive/v3/files/${encodeURIComponent(a.id)}?alt=media`, {}, "text"));
    return { id: f.id, name: f.name, mime: f.mimeType, link: f.webViewLink, text: body.slice(0, READ_MAX), truncated: body.length > READ_MAX };
  }));

  const SAVE_TYPES = ["text/plain", "text/markdown", "text/csv", "text/html", "application/json", "application/pdf", "image/png", "image/jpeg"] as const;
  const DOC_OF: Record<string, string> = { "text/plain": "application/vnd.google-apps.document", "text/markdown": "application/vnd.google-apps.document",
    "text/html": "application/vnd.google-apps.document", "text/csv": "application/vnd.google-apps.spreadsheet" };
  const SAVE_MAX = 4 << 20;
  s.registerTool("drive_save_file", {
    description: "Save a new file to the Engram folder in your Google Drive (never changes or deletes other files). Text as is, or a PDF or image as base64; text can become a Google Doc (CSV a Sheet).",
    inputSchema: z.object({
      name: oneLine.pipe(z.string().min(1).max(200)), mime: z.enum(SAVE_TYPES), content: z.string().max(6_000_000).describe("the file's text, or base64 for a PDF or image"),
      as_google_doc: z.boolean().optional().describe("text/plain, markdown or html become a Google Doc; csv a Google Sheet"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guard(id, S.driveFile, async (a: { name: string; mime: string; content: string; as_google_doc?: boolean }) => {
    const binary = a.mime === "application/pdf" || a.mime.startsWith("image/");
    const bytes = binary ? Buffer.from(a.content, "base64") : Buffer.from(a.content, "utf8");
    if (!bytes.length) throw new Error("Nothing to save");
    if (bytes.length > SAVE_MAX) throw new Error("Larger than 4 MB");
    const target = a.as_google_doc ? DOC_OF[a.mime] : undefined;
    if (a.as_google_doc && !target) throw new Error("Only text, markdown, html or csv can become a Google Doc or Sheet");
    const meta = { name: a.name, parents: [await engramFolder(id)], ...(target ? { mimeType: target } : {}) };
    const boundary = `engram-${b64url(randomBytes(12))}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${a.mime}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--`)]);
    const f = await g(id, `${UPLOAD}/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
    return { id: f.id, name: f.name, mime: f.mimeType, link: f.webViewLink };
  }));

  return s;
}

// The Engram folder: found by an app property Engram sets, since drive.file only sees files Engram made. Cached per process.
const folders = new Map<string, string>();
async function engramFolder(id: string) {
  const known = folders.get(id);
  if (known) return known;
  const q = new URLSearchParams({ q: "appProperties has { key='engram' and value='folder' } and trashed = false", fields: "files(id)", pageSize: "1" });
  let fid: string | undefined = (await g(id, `${API}/drive/v3/files?${q}`)).files?.[0]?.id;
  if (!fid) fid = (await g(id, `${API}/drive/v3/files?fields=id`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Engram", mimeType: "application/vnd.google-apps.folder", appProperties: { engram: "folder" } }) })).id;
  if (!fid) throw new Error("Google didn't create the Engram folder");
  folders.set(id, fid);
  return fid;
}
