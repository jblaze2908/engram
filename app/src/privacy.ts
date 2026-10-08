// The public privacy policy Google's consent screen links to (required to publish the OAuth app). Static, no auth.
// Google OAuth verification needs a public privacy page; ENGRAM_OWNER_NAME names who runs this instance.
const esc = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const OWNER = esc(process.env.ENGRAM_OWNER_NAME?.trim() || "its owner");

export const PRIVACY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Engram privacy policy</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--ink:#18181b;--muted:#52525b}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--ink:#ececef;--muted:#a1a1aa}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,sans-serif}
main{max-width:680px;margin:0 auto;padding:48px 16px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}p,li{color:var(--ink)}.muted{color:var(--muted)}
</style></head><body><main>
<h1>Engram privacy policy</h1>
<p class="muted">Last updated 8 October 2026</p>

<h2>What Engram is</h2>
<p>Engram is a personal, single-user application that ${OWNER} runs on their own server for their own use. It is not offered to anyone else, and no one else can sign in to it.</p>

<h2>Google data it uses</h2>
<p>Only after the owner signs in with their own Google account, Engram can:</p>
<ul>
<li>search and read their Gmail messages, and create drafts (it never sends mail);</li>
<li>read their Google Calendar events and free/busy times;</li>
<li>search and read their Google Drive files.</li>
</ul>

<h2>How it is used</h2>
<p>Engram passes this data, on request, to the AI agents the owner runs for themselves, so they can answer the owner's questions and prepare drafts. Each agent is limited to the tools the owner grants it, and every call is recorded in Engram's own log. To do that work, the content an agent reads is processed by the AI model provider the owner has chosen for that agent.</p>

<h2>What is stored</h2>
<p>Google sign-in tokens are stored encrypted on the owner's server. Engram does not keep copies of mail, events or files; a fact is saved only when the owner chooses to keep it. Call logs keep the tool name and redacted arguments, not message contents.</p>

<h2>Sharing</h2>
<p>Google user data is not sold, not used for advertising, and not shared with anyone except the AI model providers that process the owner's own requests. Engram does not use it to train or improve AI models.</p>
<p>Engram's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Removing access</h2>
<p>Disconnecting Google in Engram deletes the stored tokens. Access can also be revoked at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
</main></body></html>`;
