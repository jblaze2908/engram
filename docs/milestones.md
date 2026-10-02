# Engram M2–M6 — build plan

v0.1 (M1) is live. This file is the contract for the rest; `app/shared/types.ts` holds the shapes.

## M1 leftovers (with M2)

- Memory **Edit** = a new memory by you that supersedes it. **Mark as wrong** = `status: forgotten`, `wrong: true`, reason in the commit.
- Artifact **Forget this file and its memories** (file stays in git history; record and derived memories → forgotten).
- Skill proposal **Link to profile instead** = reject the edit and add a `see: profile/<file>` line to the skill.
- Trace **Undo accept** = forget the accepted memory and restore the one it superseded to active.
- **Open in Obsidian** links: `obsidian://open?vault=Engram&file=<vault path>` (the vault is cloned on the Mac as `~/Engram`, see Vault sync).
- `GET /api/memories?ids=a,b,c` batch read (Artifacts page uses it).

## M2 — gateway

- Upstream connections: remote MCP servers over Streamable HTTP, via `@modelcontextprotocol/client` (v2.1.0).
  Auth: `oauth` (RFC 9728 discovery + dynamic client registration when offered, else a client id/secret you paste),
  `bearer` (a PAT or API key you paste), or `none`. Tokens and secrets: AES-256-GCM under `master.key`, refresh handled.
  OAuth callback `GET /api/connections/oauth/callback` (state bound to your session; PKCE).
- SSRF: https only; refuse discovered metadata/token URLs that resolve to private, loopback or link-local addresses.
- On connect and every 6 h: `tools/list`. Each tool's description is hashed. First sight → pinned. A changed hash → the tool
  is **blocked for every agent** and a `tool_change` proposal (old vs new text) lands in the inbox. Approve = re-pin.
- `kind` per tool: `read` unless the name/annotations say it writes (create/update/delete/send/merge/pay or `readOnlyHint:false`);
  you can override. Write tools are never granted by default.
- Agent grants gain `tools: ["<conn>/<tool>"]`. The MCP endpoint lists, per caller, Engram's own 4 tools plus each granted
  upstream tool as `<conn>__<tool>` with a trimmed description. Calls are proxied with Engram's credentials; arguments
  are traced redacted; size cap 1 MB and 30 calls/min per agent. Results from connections marked `untrusted`
  (Gmail, web) carry `_meta: { engram: { untrusted: true } }` and a leading line "Untrusted content: …".
- `search` also returns granted tools (kind `tool`), so an agent finds a tool by need.
- UI: Connections list + detail (the frame), Add a connection (URL, auth type, untrusted toggle), the change diff with
  Keep blocked / Approve; Agents screen gets a per-connection tool picker.
- Test against a local mock MCP server (bearer) and the SDK's OAuth flow against a local mock authorization server.

## M3 — Pitcrew link

One Engram agent with `link: true` (kind `pitcrew`, name "Pitcrew") is created in the Agents screen ("Link Pitcrew"),
and its token is pasted into Pitcrew's Settings. Link API (bearer, link tokens only):

- `GET  /link/inbox` → `LinkInbox` (open proposals, never private scope).
- `POST /link/inbox/:id {decision}` → as `/api/inbox/:id`; trace `who: "you (in Pitcrew)"`.
- `GET  /link/digest` → `Digest` (current week).
- `POST /link/members {pitcrew_id, name, hue, area}` → `NewToken`: creates or rotates the Engram agent for that crew
  member (kind `pitcrew`, profile `pitcrew-member`, Crew Chief → `crew-chief`; default grants personal read + propose).
- `POST /link/import/memories {pitcrew_id, items:[{text, created_at}]}` → accepted directly as source
  `{kind:"agent", label:"pitcrew:<name>"}`, trusted, area from the member's `area` (default `home`). Dedupe applies.
- `POST /link/import/artifacts {pitcrew_id, title, kind, mime, content_base64, created_at}` → accepted, kept copy.
- `GET  /link/sync?pitcrew_id=` → `SyncBundle` for that member.
- `GET  /link/artifacts` → `{artifacts: LinkArtifact[]}`: what Pitcrew members published (active, never private scope),
  newest first, ≤ 300, with `url`, `public_url`, `share_pending` and the thread `ref`. Pitcrew's Library reads it per view.
- Link v2 (2026-10-02): `POST /link/members` also takes `scope` (personal | finance | health: the member's home scope,
  where its memories, artifacts and journal land; area follows it) and `connections` (read tools of those connections,
  granted once, on creation). A scope change adds that scope's read + propose grant and never removes one.
  `GET /link/connections` → `{connections:[{id,name,status,detail,read,write}]}`. `/link/sync` adds `memories`
  (the member's own, ≤60) and `scope`. `GET /link/memories?pitcrew_id=` → `{scope, memories:[{id,text,scope,area,created_at,source}]}`
  (own = `source.agent` is the member). `POST /link/memories {pitcrew_id,text,supersedes?,ref?,untrusted?,by?}` →
  accepted directly from a clean turn; `untrusted`, or a member rewriting something you added, goes through the
  write path and is held. `POST /link/memories/:id/forget {pitcrew_id}` (own only). `POST /link/episodes
  {pitcrew_id,text,at?,outputs?}` → a journal entry.
Engram marks `pitcrew_linked: true` in Status once a link token has been used in the last 10 minutes.

Pitcrew side: Settings → Engram (URL + link token, stored encrypted like provider keys); a 60 s poll mirrors
`/link/inbox` as pit stops of kind `engram` (title, reasons, replaces) and sends decisions back; the Pit wall shows the
digest card; each member gets its own Engram token (via `/link/members`) and Engram added to its Codex MCP servers
(`url /mcp`, bearer header) instead of per-member upstream tokens; Crew Chief threads start with `profile()`;
skills from `/link/sync` are written into each member's Codex skills dir at thread start; a one-shot
"Move memories to Engram" migrates each member's memories and Library receipts.

## M4 — bringing things back

- Digest built Sundays 19:00 IST (and on demand): waiting items, running out (30 days), what changed, open loops
  (open projects + memories marked `loop`), the week's journal grouped by day. Stored as `vault/digests/YYYY-Www.md`.
- Notifications through ntfy (`ENGRAM_NTFY_URL`, `ENGRAM_NTFY_TOKEN` from `/etc/engram/engram.env`): a new held
  proposal (batched, at most one per 10 min), a tool description change, the weekly digest, a memory running out in
  3 days. Clicks open the right screen. No secrets or memory text in a notification body beyond its title.
- Web: `/#/digest` (current + past weeks), linked from Status.

## M5 — sync to disk

Dropped 2026-10-02 (see Batch 2): nothing is written to disk; skills reach clients through the MCP server instructions and `get`.

## Vault sync and backups (spec §9, §17)

- The vault mirrors to a private GitHub repo `jblaze2908/engram-vault` (write deploy key on the host, `ENGRAM_VAULT_REMOTE`).
  After each commit (debounced 10 s) Engram pushes; every 60 s it fetches and fast-forwards/rebases your Obsidian edits,
  then reindexes. On a conflict it keeps both (the remote version saved as `<file>.conflict-<ts>.md`) and raises an inbox item.
- Nightly restic backup of the vault + a `VACUUM INTO` copy of the DB to `rclone:tijori-drive:engram-backup`
  (password `/etc/engram/restic.pass`), keep 7 daily / 4 weekly / 12 monthly, monthly restore check. `deploy/backup.sh`.

## M6 — Code Mode (decision D6: measure first)

Measure per agent: number of tools and `tools/list` JSON bytes with every connection attached, and bytes of a typical
bulk read done with direct calls. Record the numbers in the spec. Build `execute` only if tool definitions exceed
~20 tools or 15 KB for any agent; otherwise record the decision not to.

## Batch 2 (2026-10-02): no syncing, catalog, approval gate, OAuth server, hybrid search

Decision: nothing is synced to disk. Skills reach clients as an index in the MCP server `instructions`
(per agent, built from SQLite on each `/mcp` request: a 3-line profile gist from the compiled profile within its grants,
then "Skills you can load with get('skill:<name>'):" with one `name — description` line per granted skill inside its read
scopes, capped at 1,500 characters with an overflow line pointing at search kind "skill", then the `<conn>__<tool>`
naming note when it has tool grants) plus `get("skill:<name>")`; the `search` description names skills and tools.
`/api/agent/sync`, `tools/engram-sync.mjs` and the launchd template are removed; `/link/sync` keeps the profile and
skill names + descriptions (no bodies) for Pitcrew's instructions; Pitcrew stops writing skill files.

- **Gateway fixes**: connection ids ≤ 12 chars; upstream tool names that would push `mcp__engram__<conn>__<tool>` past
  64 chars are shortened with a 6-char hash suffix and mapped back; upstream `annotations` forwarded (Engram's write kind
  forces `readOnlyHint:false`); upstream `outputSchema` cached and declared; UI says grants apply to new client sessions.
- **Catalog**: `GET /api/catalog?q=` → `CatalogEntry[]` = a curated JSON list (verified URLs only) merged with the official MCP
  Registry (`https://registry.modelcontextprotocol.io`, remotes with streamable-http), fetched through the SSRF guard,
  cached 24 h. `POST /api/catalog/probe {url}` reads RFC 9728/8414 metadata to tell OAuth (with or without DCR) from token.
  "Add from catalog" in Connections: search, pick, one click (OAuth) or a token field with a link to where to make one.
- **Approval gate**: `ToolPolicy` per upstream tool (allow | ask | block; write tools default ask). An `ask` call becomes a
  `tool_call` proposal (who, tool, argument shapes; full args stored encrypted, shown to you only) mirrored to Pitcrew
  and pushed via ntfy; the agent gets "Waiting for your approval (call <id>). Call get('call:<id>') later for the result."
  Approve runs it once and keeps the result 1 h for `get`. An agent that read untrusted content in the last 10 min has its
  `allow` write tools treated as `ask`.
- **OAuth server** (for ChatGPT and claude.ai custom connectors; `app/src/oauth/store.ts`, `app/src/routes/oauth.ts`):
  RFC 9728 `/.well-known/oauth-protected-resource/mcp` (and the root path) naming the issuer `https://<ENGRAM_HOST>`
  (`ENGRAM_PUBLIC_URL` overrides), RFC 8414 `/.well-known/oauth-authorization-server`, both via the SDK's
  `oauthMetadataResponse`. DCR (RFC 7591) at `/oauth/register`: redirect URIs https or loopback http, no fragment, matched
  as exact strings later; 30 registrations an hour; unapproved clients pruned after a day. `/oauth/authorize` needs PKCE
  S256, parks the request and redirects to `/#/consent/<id>` (the SameSite=Strict session cookie isn't sent on the
  cross-site hop, so the web app signs you in, then shows the consent screen: client name, redirect host, profile, grants;
  private never). `/oauth/token`: authorization_code + PKCE, refresh_token rotation (a reused refresh token or code deletes
  its whole family); access tokens `ega_` 1 h, refresh `egr_` 30 days, client secrets `egs_`, all stored as sha256.
  `/oauth/revoke` (RFC 7009). `/mcp` 401 carries `WWW-Authenticate: Bearer resource_metadata=…` (SDK challenge). Each
  approved client is one Engram agent (kind other), listed under "Connected apps" in Agents; Revoke there deletes its
  tokens and revokes the agent. `eg_` tokens made in Agents keep working.
- **Hybrid search**: BM25 (FTS5) + Model2Vec `minishlab/potion-base-8M` static embeddings in pure JS (WordPiece tokenizer
  from its tokenizer.json, mean of token vectors, L2-normalised), vectors in SQLite, brute-force cosine, merged by
  reciprocal rank fusion (k = 60). Model files fetched at Docker build from a pinned Hugging Face revision with sha256
  checks (no network at runtime). An eval set (`app/tests/search-eval.json`, ≥ 40 query → expected id pairs incl. synonyms)
  reports recall@5 and MRR for BM25 alone vs hybrid; numbers recorded in the spec.

## Artifacts: shareable single files (2026-10-02)

An artifact is one file (markdown, HTML, PDF, image, anything up to 10 MB), private by default, with its own link.
Receipts and statements from before are simply private artifacts now.

- **Vault:** `artifacts/<id>.md` holds title, kind, area, project, scope, source, `versions: [{ v, sha256, ext, mime, size, at, by }]`
  (current = last) and an optional description as the body; bytes stay in `artifacts/files/<sha>.<ext>`. Older entries
  (top-level `sha256`/`ext`/`mime`) read as version 1. Text artifacts (md, txt, csv, json, html) index up to 20 KB of
  their current version for search.
- **Publishing:** MCP `publish({ title, filename, text | content_base64, id?, description?, area?, project?, scope?, public? })`
  → `{ id, version, url, public_url, status }`. Needs a propose grant for the scope; `id` makes a new version and only
  the publishing agent may use it. Pitcrew: `POST /link/artifacts` (same shape, member scope and area). You: the
  Artifacts screen's "Publish a file" (`POST /api/artifacts`).
- **Public links:** SQLite only (`artifact_shares`; never the vault, which mirrors to GitHub). An agent's `public: true`
  becomes a held `share` inbox item (also a Pitcrew pit stop); you make or revoke a link on the Artifacts screen. A
  revoked slug never comes back; sharing again makes a new 128-bit slug. Forgetting an artifact revokes its link.
- **Serving:** its own container, `engram-artifacts` (`dist/src/artifacts/server.js`, `172.17.0.1:8345`), read-only
  mounts of `vault/artifacts` and `artifacts-serve` (manifest + view key, both written by engram-app). No DB, no master
  key, no env secrets.
  - `/a/<id>`: private. Without a cookie it sends you to `https://engram…/artifacts/<id>/open`, which needs your
    session and comes back with a 12 h view token, swapped for a host-only cookie scoped to `/a/<id>`.
  - `/s/<slug>`: public. `?v=n` any version, `?download=1` a download.
  - HTML runs in a sandbox with an opaque origin and no network (`connect-src 'none'`, images only `data:`/`blob:`,
    scripts and styles inline or from cdnjs, jsDelivr, unpkg, Google Fonts), so a private page can't phone home.
    Markdown is rendered server-side with raw HTML escaped. PDF inline (a sandbox CSP breaks Chrome's viewer), images
    and SVG sandboxed, code and data as plain text, anything else a download.

### On the internet (live 2026-10-02)

Live at https://artifacts.example.com: DNS added by Jai, Traefik route applied (backup
`dynamic_config.yml.bak-before-artifacts-20261002T165433Z`), Let's Encrypt cert issued on first request. Checked:
MCP `publish` returned `/a/<id>`; without a session it redirects to engram's `/open`, which sends you to sign-in;
an unknown `/s/<slug>` is 404. How it was set up, for a rebuild:

1. Cloudflare DNS: `A artifacts.example.com → 203.0.113.10` (the address engram, pitcrew and ntfy resolve to); match their proxy setting.
2. Traefik, `/opt/sso-proxy/config/traefik/dynamic_config.yml` (back it up first, as for the other hosts):

   ```yaml
   # http.routers
       artifacts-router:
         rule: "Host(`artifacts.example.com`)"
         service: artifacts-service
         entryPoints:
           - websecure
         tls:
           certResolver: letsencrypt
   # http.services
       artifacts-service:
         loadBalancer:
           servers:
             - url: "http://172.17.0.1:8345"
   ```

3. A different hostname later: change `ENGRAM_ARTIFACTS_HOST` for both services in `deploy/compose.yml` (engram-app
   reads it for the links it hands out, engram-artifacts for its own redirects) and the router rule. Existing links
   use the old host, so keep the old router until nobody needs them.
