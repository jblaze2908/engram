// The built-in Google connection against a stand-in for Google's OAuth and APIs on 127.0.0.1: sign-in with PKCE and a
// pasted client, refresh, the tools agents see, and what each sends to Google.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const G = { challenge: null, verifier: null, codes: 0, refreshes: 0, drafts: [], queries: [], access: "at-1", scope: null };
const ALL = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/drive.readonly"];
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const google = createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const u = new URL(req.url, "http://x"), send = (s, o, type = "application/json") => { res.writeHead(s, { "content-type": type }); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
  if (u.pathname === "/token") {
    const f = new URLSearchParams(raw);
    if (f.get("client_id") !== "cid-1.apps.googleusercontent.com" || f.get("client_secret") !== "csecret-1") return send(401, { error: "invalid_client" });
    if (f.get("grant_type") === "authorization_code") {
      const ok = f.get("code") === "code-1" && createHash("sha256").update(f.get("code_verifier") || "").digest("base64url") === G.challenge;
      if (!ok) return send(400, { error: "invalid_grant" });
      G.codes++;
      return send(200, { access_token: "at-1", expires_in: 3600, refresh_token: "rt-1", scope: (G.scope || ALL).join(" "), token_type: "Bearer" });
    }
    if (f.get("refresh_token") !== "rt-1") return send(400, { error: "invalid_grant" });
    G.refreshes++; G.access = "at-2";
    return send(200, { access_token: "at-2", expires_in: 3600, scope: ALL.join(" ") });
  }
  if (req.headers.authorization !== `Bearer ${G.access}`) return send(401, { error: { message: "secret upstream detail" } });
  G.queries.push(`${req.method} ${u.pathname}${u.search}`);
  const msg = (full) => ({ id: "m1", threadId: "t1", labelIds: ["INBOX"], snippet: "Your bill", payload: { headers: [{ name: "From", value: "BESCOM <bills@bescom.example>" }, { name: "Subject", value: "September bill" }, { name: "Date", value: "Wed, 1 Oct 2026 09:00:00 +0530" }, { name: "Message-ID", value: "<abc@bescom.example>" }],
    ...(full ? { mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", body: { data: b64("Amount due: ₹1,240") } }, { mimeType: "application/pdf", filename: "bill.pdf", body: { attachmentId: "a1", size: 2048 } }] } : {}) } });
  if (u.pathname === "/gmail/v1/users/me/messages") return send(200, { messages: [{ id: "m1", threadId: "t1" }] });
  if (u.pathname === "/gmail/v1/users/me/messages/m1") return send(200, msg(u.searchParams.get("format") === "full"));
  if (u.pathname === "/gmail/v1/users/me/drafts" && req.method === "POST") { G.drafts.push(JSON.parse(raw)); return send(200, { id: "d1", message: { id: "m9", threadId: "t1" } }); }
  if (u.pathname === "/calendar/v3/calendars/primary/events") return send(200, { items: [{ id: "e1", summary: "Dentist", start: { dateTime: "2026-10-03T10:00:00+05:30" }, end: { dateTime: "2026-10-03T10:30:00+05:30" }, status: "confirmed" }] });
  if (u.pathname === "/drive/v3/files") return send(200, { files: [{ id: "f1", name: "Rent 2026", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://docs.example/f1" }] });
  if (u.pathname === "/drive/v3/files/f1") return send(200, { id: "f1", name: "Rent 2026", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://docs.example/f1" });
  if (u.pathname === "/drive/v3/files/f1/export") return send(200, "month,paid\nSep,yes\n", "text/csv");
  send(404, { error: "nope" });
});
await new Promise((ok) => google.listen(0, "127.0.0.1", ok));
const GURL = `http://127.0.0.1:${google.address().port}`;
Object.assign(process.env, { ENGRAM_DEV_ALLOW_LOCAL: "1", ENGRAM_GOOGLE_OAUTH: GURL, ENGRAM_GOOGLE_TOKEN: `${GURL}/token`, ENGRAM_GOOGLE_API: GURL, ENGRAM_GOOGLE_GMAIL: GURL });
const { ROOT, req, close, signIn, makeAgent, g, mcp } = await import("./_env.mjs");

let cookie, agent;
before(async () => { cookie = await signIn(); agent = await makeAgent(cookie, "Bills", [g("personal", true, "propose")]); });
after(async () => { google.close(); await close(); });
const raw = async (name, args) => (await mcp(agent.token, "tools/call", { name, arguments: args })).msg.result;
const json = (r) => JSON.parse(r.content.at(-1).text);
const secretsBlob = () => { const d = new DatabaseSync(join(ROOT, "engram.db")); try { return d.prepare("SELECT group_concat(blob, ' ') b FROM secrets").get().b || ""; } finally { d.close(); } };

async function signInToGoogle() {
  const r = await req("POST", "/api/connections/google/connect", {}, { cookie });
  const url = new URL(r.json.authorize_url);
  assert.equal(url.origin + url.pathname, `${GURL}/o/oauth2/v2/auth`);
  for (const [k, v] of [["access_type", "offline"], ["prompt", "consent"], ["code_challenge_method", "S256"], ["client_id", "cid-1.apps.googleusercontent.com"]]) assert.equal(url.searchParams.get(k), v);
  assert.deepEqual(url.searchParams.get("scope").split(" "), ALL);
  G.challenge = url.searchParams.get("code_challenge");
  return req("POST", "/api/connections/oauth/finish", { state: url.searchParams.get("state"), code: "code-1" }, { cookie });
}

test("connect needs your client; sign-in uses PKCE and an offline refresh token; nothing stored in clear", async () => {
  assert.equal((await req("POST", "/api/connections", { name: "Google", url: "builtin:google", auth: "oauth", client_id: "cid-1.apps.googleusercontent.com" }, { cookie })).status, 400, "the secret is required");
  const r = await req("POST", "/api/connections", { name: "Google (Gmail, Calendar, Drive)", url: "builtin:google", auth: "oauth", untrusted: true, client_id: "cid-1.apps.googleusercontent.com", client_secret: "csecret-1" }, { cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.connection.id, "google");
  assert.match(r.json.authorize_url, /\/o\/oauth2\/v2\/auth\?/);
  const done = await signInToGoogle();
  assert.equal(done.status, 200, done.text);
  assert.equal(G.codes, 1);
  const c = done.json.connection;
  assert.equal(c.status, "ok");
  assert.deepEqual(Object.fromEntries(c.tools.map((t) => [t.name, t.kind])), {
    calendar_events: "read", calendar_freebusy: "read", calendar_list: "read", drive_read: "read", drive_search: "read", gmail_create_draft: "write", gmail_read: "read", gmail_search: "read",
  });
  assert.equal(c.tools.find((t) => t.name === "gmail_create_draft").policy, "ask", "drafts ask you first");
  const blob = secretsBlob();
  for (const s of ["csecret-1", "rt-1", "at-1"]) assert.ok(!blob.includes(s) && !done.text.includes(s), `${s} never in clear`);
});

test("granted tools reach Google with the token; results are marked untrusted; Google's error text never shows", async () => {
  await req("PUT", `/api/agents/${agent.agent.id}/tools`, { tools: ["google/gmail_search", "google/gmail_read", "google/calendar_events", "google/drive_search", "google/drive_read", "google/gmail_create_draft"] }, { cookie });
  const s = await raw("google__gmail_search", { query: "from:bescom newer_than:30d", max: 5 });
  assert.match(s.content[0].text, /^Untrusted content/);
  assert.deepEqual(json(s).messages[0], { id: "m1", thread_id: "t1", from: "BESCOM <bills@bescom.example>", to: null, subject: "September bill", date: "Wed, 1 Oct 2026 09:00:00 +0530", snippet: "Your bill", labels: ["INBOX"] });
  assert.ok(G.queries.some((q) => q.startsWith("GET /gmail/v1/users/me/messages?q=from%3Abescom")));
  const m = json(await raw("google__gmail_read", { id: "m1" }));
  assert.equal(m.body, "Amount due: ₹1,240");
  assert.deepEqual(m.attachments, [{ filename: "bill.pdf", mime: "application/pdf", size: 2048 }]);
  assert.equal(json(await raw("google__calendar_events", { from: "2026-10-01T00:00:00+05:30", to: "2026-10-08T00:00:00+05:30" })).events[0].summary, "Dentist");
  await raw("google__drive_search", { text: "rent' or trashed = true or '" });
  const dq = G.queries.filter((q) => q.startsWith("GET /drive/v3/files?")).map((q) => new URLSearchParams(q.split("?")[1]).get("q"));
  assert.ok(dq.includes("fullText contains 'rent\\' or trashed = true or \\'' and trashed = false"), `quotes stay inside the literal: ${dq}`);
  assert.equal(json(await raw("google__drive_read", { id: "f1" })).text, "month,paid\nSep,yes\n");
  const bad = await raw("google__gmail_read", { id: "nope" });
  assert.equal(bad.isError, true);
  assert.ok(!JSON.stringify(bad).includes("secret upstream detail"));
});

test("a draft is plain text, can't smuggle a header, and asks you first", async () => {
  // A fresh agent: one that just read untrusted mail would have every write held for 10 minutes (D17).
  const w = await makeAgent(cookie, "Drafter", [g("personal", true, "propose")]);
  await req("PUT", `/api/agents/${w.agent.id}/tools`, { tools: ["google/gmail_create_draft"] }, { cookie });
  const raw = async (name, args) => (await mcp(w.token, "tools/call", { name, arguments: args })).msg.result;
  const ask = await raw("google__gmail_create_draft", { to: ["owner@example.com"], subject: "Rent", body: "Paid." });
  assert.equal(G.drafts.length, 0, "ask: nothing reaches Google before you decide");
  assert.ok(!ask.isError && /approv|ask|waiting/i.test(JSON.stringify(ask)), JSON.stringify(ask));
  await req("PATCH", "/api/connections/google/tools/gmail_create_draft", { policy: "allow" }, { cookie });
  const ok = json(await raw("google__gmail_create_draft", { to: ["owner@example.com"], subject: "Re: September bill ₹", body: "Paid on the 1st.", reply_to: "m1" }));
  assert.equal(ok.draft_id, "d1");
  const d = G.drafts.at(-1), mime = Buffer.from(d.message.raw, "base64url").toString("utf8");
  assert.equal(d.message.threadId, "t1");
  assert.match(mime, /^To: owner@example\.com\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\nIn-Reply-To: <abc@bescom\.example>\r\nReferences: <abc@bescom\.example>\r\n/);
  assert.ok(!/^Bcc:/m.test(mime));
  assert.equal(Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString("utf8"), "Paid on the 1st.");
  // Any result from an untrusted connection, a draft's included, holds that agent's writes for 10 minutes: a new agent.
  const w2 = await makeAgent(cookie, "Drafter 2", [g("personal", true, "propose")]);
  await req("PUT", `/api/agents/${w2.agent.id}/tools`, { tools: ["google/gmail_create_draft"] }, { cookie });
  const inj = (await mcp(w2.token, "tools/call", { name: "google__gmail_create_draft", arguments: { to: ["a@example.com"], subject: "Hi\r\nBcc: evil@example.com", body: "x" } })).msg.result;
  assert.equal(inj.isError, true, "a line break in the subject is refused");
  assert.equal(G.drafts.length, 1);
  await req("PATCH", "/api/connections/google/tools/gmail_create_draft", { policy: null }, { cookie });
});

test("an expired access token is refreshed once; a revoked refresh token asks you to sign in again", async () => {
  G.access = "at-2"; // Google now only accepts a refreshed token
  const before = G.refreshes;
  const { accessToken } = await import("../dist/src/gateway/google.js");
  const { putJson, getJson } = await import("../dist/src/gateway/secrets.js");
  putJson("conn:google:tokens", { ...getJson("conn:google:tokens"), expires_at: Date.now() - 1 });
  const [a, b] = await Promise.all([accessToken("google"), accessToken("google")]);
  assert.equal(a.access_token, "at-2"); assert.equal(b.access_token, "at-2");
  assert.equal(G.refreshes - before, 1, "concurrent callers share one refresh");
  assert.equal(json(await raw("google__calendar_events", { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" })).events.length, 1);
  putJson("conn:google:tokens", { ...getJson("conn:google:tokens"), refresh_token: "revoked", expires_at: Date.now() - 1 });
  const r = await req("POST", "/api/connections/google/refresh", {}, { cookie });
  assert.equal(r.status, 502);
  const c = (await req("GET", "/api/connections/google", undefined, { cookie })).json;
  assert.equal(c.detail, "Needs you to sign in");
});
