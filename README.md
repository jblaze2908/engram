# Engram

A self-hosted memory and context layer for all your agents. Claude Code, Codex, ChatGPT and your own bots connect to
one MCP endpoint and get the same profile, memories, skills and tools. Single-user: you run your own instance.

## What it does

- **Profile and memories.** How you work, your rules and preferences, and facts worth keeping, stored as markdown in a
  git-backed vault (it opens in Obsidian). Agents read them through `profile`, `search` and `get`.
- **Proposals, not writes.** Agents `propose` a memory or entity; you accept it in the Inbox. Every change is a commit.
- **Search.** Hybrid keyword and local-embedding search; nothing leaves the box for indexing.
- **MCP gateway.** Add upstream MCP servers once (registry catalog, OAuth, per-agent tool grants) and every agent gets
  them through Engram. Credentials stay encrypted on your server. Google (Gmail, Calendar, Drive) is built in.
- **Artifacts.** `publish` a markdown, HTML, PDF or image file and get a private link on a separate origin, sandboxed
  with no network access.
- **Per-agent access.** Each agent has its own token or OAuth client and scoped grants (read/propose per area). Every
  call is logged.
- **Digest and notifications.** Optional daily digest and phone pushes through ntfy.

## Architecture

- `app/src` — Node 22, TypeScript, Hono, `node:sqlite`, MCP TypeScript SDK. One process serves the web API, the web
  app and `/mcp`.
- `app/src/artifacts/server.ts` — the artifacts host, a second container that sees only published files.
- `app/web` — React 19, Vite, Tailwind.
- `deploy/` — Docker Compose plus a systemd timer that pulls `main`, builds, runs the tests, health-checks and rolls
  back on failure. Nightly restic backup.

## Quickstart (local)

```sh
cd app && npm ci && npm run build
ENGRAM_ROOT=../.data PORT=8340 npm start
```

Open http://localhost:8340, paste the setup token from `.data/setup-token`, and choose a password.

## Self-host

Any machine with Docker: a laptop, a home server, any VPS or cloud VM. In short:

```sh
docker build -t engram-app:1 app
docker compose -p engram -f deploy/compose.yml up -d
```

with config in `/etc/engram/{hosts,engram}.env` (from `.env.example`) and a TLS proxy in front of the app and
artifacts hosts. **[docs/deploy.md](docs/deploy.md)** covers it end to end: requirements, the two origins, Caddy,
nginx and Traefik examples, agent tokens and OAuth, notifications, backups, updates, optional auto-deploy from git,
troubleshooting.

## Connect an agent

Create an agent in **Agents**; it shows the endpoint (`https://<your host>/mcp`) and a bearer token. For Claude Code:

```sh
claude mcp add --transport http engram https://engram.example.com/mcp --header "Authorization: Bearer <token>"
```

ChatGPT and other clients that support MCP OAuth can connect with the URL alone.

## Docs

`docs/deploy.md` (deploying), `docs/build.md` (build plan and layout) and `docs/milestones.md` (what each milestone shipped).

## License

MIT
