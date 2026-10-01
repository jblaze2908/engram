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

- `GET /api/agent/sync` (bearer, any agent) → `SyncBundle` for the caller.
- `tools/engram-sync.mjs` (no dependencies, Node ≥ 22): reads `~/.config/engram/agents.json`
  (`[{ "name":"claude-code", "token_file":"~/.config/engram/claude-code.token", "skills_dir":"~/.claude/skills",
  "profile_file":"~/.claude/CLAUDE.md" }, …codex → ~/.agents/skills, ~/.codex/AGENTS.md]`), writes each granted skill
  to `<skills_dir>/<name>/SKILL.md` with a `.engram-managed` marker, removes managed skills no longer granted, never
  touches unmanaged ones, and replaces only the block between `<!-- engram:begin -->` and `<!-- engram:end -->` in the
  profile file (adds the block at the end if missing). Dry-run flag. `tools/com.engram.sync.plist` runs it every 15 min.

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
