# Engram v0.1 — build plan

This first cut is milestone **M1** (profile + memories + search + inbox, one MCP endpoint) with every screen
built. The gateway (upstream OAuth, M2), Pitcrew migration (M3), digest delivery (M4), skills for agents (M5)
and Code Mode (M6) come later; their screens show an honest empty state.

## Layout

- `app/src/` server (TypeScript, Hono, node:sqlite, MCP TS SDK v2). Entry `app/src/server.ts`, port `PORT` (8340).
- `app/shared/types.ts` the API contract. Change it here first.
- `app/web/` React 19 + Vite 8 + Tailwind 4 web app, built into `app/dist/web`, served by the server at `/`.
- `app/tests/*.test.mjs` node:test against `app/dist/src/*.js`; they also run in the Docker build, so a failure blocks the deploy.
- `deploy/` pull-based deploy on one Docker host: a systemd timer pulls `main`, builds, health-checks, rolls back.

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
  global login limiter. First run needs the setup token from
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

## Dreaming (nightly tidy-up)

`app/src/dream.ts`. Once per IST day from 03:00, the minute job (`jobs.ts`) runs one pass over active memories and puts
proposals of kind `dream` in the inbox. It never changes a memory itself; nothing applies until you accept.
- **Merge**: two memories of one scope that say the same thing (cosine ≥ 0.85, same values, word overlap ≥ 0.75). Keeps
  yours, then trusted, then the fuller, then the newer; accepting supersedes the other (`superseded_by` the keeper).
- **Supersede**: same words, different values (numbers, dates, months, weekdays), different `observed_at`. The newer
  wins unless only an untrusted source says it. Accepting supersedes the older.
- **Retire**: `valid_until` has passed. Accepting sets `status: forgotten` (the file stays, like any forget).
- Anything else proposes nothing. Paraphrases with different words, a changed name, values on one side only: left alone.
- Scope is the boundary: a memory is only compared with memories of its own scope, and accept checks again.
- Model: the local embedding model (potion-base-8M, already used by search) finds candidates (cosine ≥ 0.6, top 8),
  a lexical judge decides. No API calls, no cost beyond CPU. Without the model the pass logs
  `dream: no embedding model in …` and does nothing.
- Bounds per night: at most 200 new or changed memories examined and 20 proposals. A watermark (`settings.dream_watermark`:
  file mtime + id, and the last IST day for run-outs) skips what the last pass already saw; leftovers wait for the next
  night. A pair proposed once, either way round, is never proposed again, even after a reject; a memory named in an open
  tidy-up is skipped until you decide.
- Tidy-ups are never held, so they don't push a 3 a.m. notification. Non-private ones mirror to Pitcrew like any proposal.
- Measured on synthetic stores (dev Mac): 200 memories against a 5 000-memory pool ≈ 0.2 s, against 20 000 ≈ 0.8 s,
  synchronous on the event loop.

## MCP endpoint `/mcp`

Streamable HTTP, stateless, via `@modelcontextprotocol/server` + `@modelcontextprotocol/hono`, bearer auth.
Tools (keep descriptions short; this is the whole surface):
- `search({ query, kind?, area?, project?, limit?, agent?, after?, before? })` → ranked memories, entities, artifacts,
  journal entries, skills, profile sections the caller may read. `agent` (name or id) matches `source.agent`, and an
  episode's `who`; `after`/`before` bound `docs.at` (a bare date is midnight server time). Filters only narrow the
  scoped query. Each hit: `{ kind, id, title, snippet, area, scope, source, valid_until, provenance }`, provenance
  `{ trust: user|agent|untrusted, by, review: accepted|not_reviewed, created_at, updated_at, open: {id}|{url} }` from
  stored fields only (null where not stored); `open.id` only when the source record is within the caller's grants.
- `get({ id, offset?, limit? })` → the full record (memory, entity view, artifact, episode, skill, profile file) and its
  provenance. A text artifact adds `text` (its current file). The long field comes in pages (default 20 000 chars):
  `page: { field, offset, limit, total, next_offset }`, `next_offset` null at the end.
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

M1 leftovers: `GET /api/memories?ids=a,b` · `POST /api/memories/:id/edit {text,valid_until?}` · `POST /api/memories/:id/wrong {reason}`
`POST /api/artifacts/:id/forget` · `POST /api/inbox/:id/link-profile {file}` · `POST /api/inbox/:id/undo`

Gateway (M2): `GET|POST /api/connections` → Connection[] / ConnectResult · `GET|PATCH|DELETE /api/connections/:id`
`POST /api/connections/:id/connect|refresh` · `PATCH /api/connections/:id/tools/:tool {kind}` · `POST …/tools/:tool/approve|keep`
`GET /api/connections/oauth/callback` (no cookie → hands off to the web app) · `POST /api/connections/oauth/finish {state,code,iss?}`
`PUT /api/agents/:id/tools {tools}` → Agent. Code in `app/src/gateway/`; tests set `ENGRAM_DEV_ALLOW_LOCAL=1` to reach a mock on
`http://127.0.0.1`, and `ENGRAM_URL` overrides the OAuth redirect base (default `https://$ENGRAM_HOST`).
A server whose authorize answers 400 naming the redirect (Canva allowlists callbacks) is re-registered once with
`http://127.0.0.1/engram/oauth/callback`; the connection turns `paste_back` and you paste the address the sign-in lands on.

## Rules

- Pinned exact versions, famous packages only, nothing published in the last 7 days.
- Comments 1–2 lines, the why only. No secrets in logs; tokens only as prefixes.
- Performance: no disk scans or git calls per request except the write that needs them; the index is in SQLite.
