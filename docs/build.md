# Engram v0.1 — build plan

Spec of record: Obsidian `Projects/Engram/Engram - Spec.md`. Designs: Draft canvas `kbyr_xhuW7`, system C1.
This first cut is milestone **M1** (profile + memories + search + inbox, one MCP endpoint) with every screen
built. The gateway (upstream OAuth, M2), Pitcrew migration (M3), digest delivery (M4), skills sync to disk (M5)
and Code Mode (M6) come later; their screens show an honest empty state.

## Layout

- `app/src/` server (TypeScript, Hono, node:sqlite, MCP TS SDK v2). Entry `app/src/server.ts`, port `PORT` (8340).
- `app/shared/types.ts` the API contract. Change it here first.
- `app/web/` React 19 + Vite 8 + Tailwind 4 web app, built into `app/dist/web`, served by the server at `/`.
- `app/tests/*.test.mjs` node:test against `app/dist/src/*.js`; they also run in the Docker build, so a failure blocks the deploy.
- `deploy/` pull-based deploy on the host, same shape as Pitcrew.

## Data

`ENGRAM_ROOT` (default `/srv/engram`, locally `./.data`):

- `vault/` a git repo of markdown files with YAML frontmatter. **Source of truth.** Every write is one commit.
  - `profile/<name>.md` (frontmatter `scope`)
  - `areas/<slug>.md`, `projects/<slug>.md`
  - `entities/<kind>/<slug>.md`
  - `memories/YYYY/MM/<id>.md` (append-only; a correction is a new file with `supersedes`, the old one gets `status: superseded`)
  - `artifacts/<id>.md` + `artifacts/files/<sha256>.<ext>` (kept copy, never rewritten)
  - `journal/YYYY/MM/DD/<id>.md`
  - `skills/<name>/SKILL.md`
- `engram.db` SQLite: FTS5 index of the vault (derived, rebuilt at boot and by a 60 s mtime scan), plus state
  that isn't knowledge: agents, token hashes, grants, proposals, trace, sessions, settings, read counts.
- `master.key` (32 random bytes, 0600) for upstream credentials in M2. `setup-token` gates first-run password.

First boot seeds `areas/` with Home, Money, Health, Car, Travel, Building and empty `profile/` files
(working-style, voice, rules, preferences, money [finance], health [health]). **No work data, ever.**

## Auth

- Web: one password (scrypt), sessions as random tokens stored hashed, httpOnly SameSite=Strict cookie,
  global login limiter — copy the pattern of Pitcrew's `app/src/auth.ts`. First run needs the setup token from
  `ENGRAM_ROOT/setup-token`.
- Agents: `Authorization: Bearer eg_<43 base64url chars>`. Stored as sha256 only; prefix kept for display.
  Revocable. One token per agent. Same-origin + CSRF header (`x-engram: 1`) on cookie-authed mutations.

## Scopes and grants

Scopes `personal | finance | health | private`. A grant is `(agent, scope, read, write: none|propose)`.
`private` is never granted to an agent. Every MCP read filters by the caller's read grants; a request for a
record outside them is refused and traced (`result: "refused"`). Never cross scopes implicitly.

## Write path (spec §7)

`propose` creates a Proposal. Rules, in order:
1. Episodes (journal) from an authenticated agent are accepted directly — they describe, they don't assert.
2. Anything whose source kind is `email` or `web` is **held** (quarantined): reasons include
   "Email content is never trusted on its own" / "Web pages are never trusted on their own".
3. A memory that would replace one you wrote yourself adds "It would replace something you added yourself".
4. A finance memory about accounts, IFSC, UPI or payments adds "It changes where money goes".
5. Dedupe: same text + area + scope as an active memory → no proposal, return the existing id.
6. Never re-extract recalled memories: a proposal whose text matches a memory this agent read in the last
   24 h is rejected with a clear error.
Decisions: `accept` (writes file, commit), `keep` (= reject, keeps current), `reject`, `reject_and_forget_source`
(reject + mark every memory with the same `source.ref` as `forgotten`). Forgetting never deletes a file; it sets
`status: forgotten` and commits. Everything is in the trace.

## MCP endpoint `/mcp`

Streamable HTTP, stateless, via `@modelcontextprotocol/server` + `@modelcontextprotocol/hono`, bearer auth.
Tools (keep descriptions short; this is the whole surface):
- `search({ query, kind?, area?, project?, limit? })` → ranked memories, entities, artifacts, journal entries,
  skills, profile sections the caller may read. Each hit: `{ kind, id, title, snippet, area, scope, source, valid_until }`.
- `get({ id })` → the full record (memory, entity view, artifact, episode, skill, profile file).
- `propose({ kind: "memory"|"entity"|"artifact"|"skill"|"episode", ... })` → `{ status: "accepted"|"open"|"held", id, reasons }`.
- `profile()` → the compiled profile for this agent's target, within its read grants.
Each call writes a trace row and bumps read counts for returned memories.

## Web API (cookie session)

`GET /healthz` · `GET /api/session` · `POST /api/setup {token,password}` · `POST /api/login {password}` · `POST /api/logout`
`GET /api/status` → Status · `GET /api/inbox` → Proposal[] · `POST /api/inbox/:id {decision}`
`GET /api/context` → ContextHome · `GET /api/areas/:slug` → AreaView
`GET /api/entities?kind=` → Entity[] · `GET /api/entities/:id` → EntityView
`GET /api/memories?status=&area=&q=` → Memory[] · `GET /api/memories/:id` → Memory · `POST /api/memories/:id/forget` · `GET /api/memories/:id/provenance` → Provenance
`GET /api/artifacts?kind=` → Artifact[] · `GET /api/artifacts/:id` · `GET /api/artifacts/:id/file`
`GET /api/journal?day=YYYY-MM-DD` → JournalView
`GET /api/profile` → { files: ProfileFile[], compiled: CompiledProfile[] }
`GET /api/skills` → Skill[] · `GET /api/skills/:name` → Skill
`GET /api/agents` → Agent[] · `POST /api/agents {name,kind,profile,grants}` → NewToken · `PATCH /api/agents/:id {grants,skills,name}` · `POST /api/agents/:id/token` → NewToken · `POST /api/agents/:id/revoke`
`GET /api/trace?who=&result=&day=` → TraceRow[]
`GET /api/connections` → Connection[] (empty until M2)
`POST /api/memories {text,area,scope,valid_until?}` — "Add to Engram" from the UI (source kind `you`, accepted directly)

## Rules

- Pinned exact versions, famous packages only, nothing published in the last 7 days.
- Comments 1–2 lines, the why only. No secrets in logs; tokens only as prefixes.
- Performance: no disk scans or git calls per request except the write that needs them; the index is in SQLite.
