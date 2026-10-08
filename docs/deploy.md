# Deploying Engram

Engram runs on any machine with Docker: a laptop, a home server, or any VPS or cloud VM. It is single-user: one
instance, one owner, as many agents as you like.

## Requirements

- Docker with the Compose plugin, and git.
- About 1 GB of RAM (the app container is capped at 768 MB, the artifacts container at 256 MB).
- For agents outside your machine: two hostnames with TLS, one for the app and one for artifacts (see below). On a
  laptop used only by local agents, `localhost` is enough.

## 1. Configure

Instance config lives outside the repo, by default in `/etc/engram` (set `ENGRAM_CONFIG_DIR` to move it). Copy
`.env.example` and split it in two:

- `/etc/engram/hosts.env`: `ENGRAM_HOST`, `ENGRAM_ARTIFACTS_HOST`, `ENGRAM_OWNER_NAME`, and `TZ` if the server's
  timezone isn't yours (journal days and bare dates follow it). Public values; both containers read it.
- `/etc/engram/engram.env`: everything else (vault remote, ntfy, backups). `chmod 600`. Only the app container reads it.

Both files must exist, even if `engram.env` is empty.

## 2. Start

```sh
git clone <this repo> /opt/engram && cd /opt/engram
sudo install -d -o 1600 -g 1600 -m 700 /srv/engram /srv/engram/home /srv/engram/artifacts-serve \
  /srv/engram/vault /srv/engram/vault/artifacts /srv/engram/vault/artifacts/files
docker build -t engram-app:1 app          # runs the test suite; a failing test fails the build
docker compose -p engram -f deploy/compose.yml up -d
curl -s http://172.17.0.1:8340/healthz    # {"ok":true}
```

The containers run as uid 1600, read-only, with all capabilities dropped; `/srv/engram` is the only writable path
(vault, SQLite index, master key). The ports are published on the Docker bridge address `172.17.0.1`, not on the
public interface, so only a proxy on the same host can reach them. Change `ports:` in `deploy/compose.yml` if your
bridge address differs.

Open the app, paste the setup token from `/srv/engram/setup-token`, and choose a password.

## 3. Two hosts, two origins

| Host | Port | Serves |
|---|---|---|
| `ENGRAM_HOST` | 8340 | Web app, `/api`, `/mcp`, `/oauth`, `/privacy` |
| `ENGRAM_ARTIFACTS_HOST` | 8345 | Published files only |

Published files are often HTML written by an agent. Served from the app's origin, that HTML could read your session
and call the API as you. On its own origin it can't, and it also runs under a CSP sandbox with no network access.
The artifacts container mounts only the published files, read-only: no database, no master key, no secrets. An
unknown link returns 404. A private link sends you to the app's `/open` to sign in, then back with a short-lived view
cookie.

## 4. Reverse proxy and TLS

Point both hostnames at the server, then put a TLS proxy in front. MCP responses can stream, so turn off response
buffering.

**Caddy** (gets certificates by itself):

```caddyfile
engram.example.com {
  reverse_proxy 172.17.0.1:8340 { flush_interval -1 }
}
artifacts.example.com {
  reverse_proxy 172.17.0.1:8345
}
```

**nginx** (certificates from certbot or similar):

```nginx
server {
  listen 443 ssl; server_name engram.example.com;
  ssl_certificate /etc/letsencrypt/live/engram.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/engram.example.com/privkey.pem;
  client_max_body_size 20m;
  location / {
    proxy_pass http://172.17.0.1:8340;
    proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto https;
    proxy_http_version 1.1; proxy_buffering off; proxy_read_timeout 300s;
  }
}
# Same block for artifacts.example.com → 172.17.0.1:8345.
```

**Traefik** (file provider):

```yaml
http:
  routers:
    engram:    { rule: "Host(`engram.example.com`)",    service: engram,    entryPoints: [websecure], tls: { certResolver: letsencrypt } }
    artifacts: { rule: "Host(`artifacts.example.com`)", service: artifacts, entryPoints: [websecure], tls: { certResolver: letsencrypt } }
  services:
    engram:    { loadBalancer: { servers: [{ url: "http://172.17.0.1:8340" }] } }
    artifacts: { loadBalancer: { servers: [{ url: "http://172.17.0.1:8345" }] } }
```

No public IP (laptop or home server)? A tunnel such as Cloudflare Tunnel or Tailscale Funnel can provide the two
HTTPS hostnames instead.

Session cookies are `Secure`. Over plain HTTP they work only on `localhost`, and only in browsers that treat
localhost as secure (Chrome, Firefox).

## 5. Agents: tokens and OAuth

Each agent gets its own identity, its own grants (which areas it may read, and whether it may propose), and its own
line in the log.

- **Bearer token.** Create the agent in **Agents**. The token is shown once and stored only as a hash. Revoke it there.
- **OAuth.** Clients that support MCP OAuth (ChatGPT connectors, for example) need only the URL. They register,
  you approve them in the browser, and they appear in **Agents**. The issuer is `https://<ENGRAM_HOST>`; set
  `ENGRAM_PUBLIC_URL` if the public URL differs.

## 6. Connect an agent

The endpoint is `https://<ENGRAM_HOST>/mcp` (streamable HTTP).

Claude Code:

```sh
claude mcp add --transport http engram https://engram.example.com/mcp --header "Authorization: Bearer <token>"
```

Codex, in `~/.codex/config.toml`, with the token in `ENGRAM_TOKEN`:

```toml
[mcp_servers.engram]
url = "https://engram.example.com/mcp"
bearer_token_env_var = "ENGRAM_TOKEN"
```

Any other MCP client: same URL, header `Authorization: Bearer <token>`, or OAuth if the client supports it.

## 7. Notifications (optional)

Engram can push new proposals, tool calls waiting for approval and blocked tool changes to your phone through [ntfy](https://ntfy.sh). Set `ENGRAM_NTFY_URL`
(topic URL) and `ENGRAM_NTFY_TOKEN` in `engram.env`. To host ntfy yourself, see `deploy/ntfy/`.

## 8. Backups (optional)

`deploy/backup.sh` takes a consistent `VACUUM INTO` copy of the database plus the vault, and sends both to a restic
repository. Restic encrypts them, so the remote never sees plaintext.

1. Install restic (and rclone if your remote is a cloud drive).
2. Put `RESTIC_REPOSITORY` in `engram.env` and a password in `/etc/engram/restic.pass` (`chmod 600`).
3. Install `deploy/engram-backup.service` and `deploy/engram-backup.timer` into systemd and enable the timer.

Retention is 7 daily, 4 weekly and 12 monthly. On the 1st of each month, or with `VERIFY=1`, it restores into a
temp directory and checks the copy. `master.key` is deliberately not backed up: keep it in a password manager.
Without it, stored upstream credentials can't be decrypted.

Separately, `ENGRAM_VAULT_REMOTE` mirrors the vault to a private git repo after each change. Clone that repo locally
to edit the vault in Obsidian; Engram pulls your edits back within a minute.

## 9. Updating

```sh
cd /opt/engram && git pull
docker build -t engram-app:1 app && docker compose -p engram -f deploy/compose.yml up -d
```

Compose keeps `/srv/engram` across updates. Schema migrations run at boot.

## 10. Auto-deploy from git (optional)

`deploy/pull-update.sh` makes the host follow a branch. Every run it:

- fetches the branch;
- builds an image tagged with the commit (the build runs the tests);
- snapshots the database;
- rolls out and health-checks both containers;
- rolls back if anything fails, and notifies ntfy either way.

```sh
sudo cp deploy/engram.service deploy/engram.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now engram.timer   # every 2 min
```

For a private repo, give the host a read-only deploy key and set `GIT_SSH_COMMAND` in the service. A commit that
fails is recorded in `/var/lib/engram/failed-commit` and skipped until a newer one lands.

## Troubleshooting

| Symptom | Check |
|---|---|
| Can't sign in on first run | The setup token is in `/srv/engram/setup-token` (or `$ENGRAM_ROOT/setup-token` locally). |
| Sign-in doesn't stick | You're on plain HTTP away from localhost; put TLS in front (the cookies are `Secure`). |
| `/mcp` returns 401 | Missing or revoked token; header must be `Authorization: Bearer <token>`. |
| `/mcp` or `/api` returns 403 from a browser client | `ENGRAM_HOST` doesn't match the hostname you're using (origin check). |
| Artifact links loop to sign-in or 404 | Both containers need the same `ENGRAM_HOST` / `ENGRAM_ARTIFACTS_HOST` (`hosts.env`). |
| Container exits, permission denied | `/srv/engram` and its subdirectories must be owned by 1600:1600. |
| `docker build` fails | A test failed; the output names it. |
| Anything else | `docker logs engram-app`, `docker logs engram-artifacts`, `journalctl -u engram.service`. |
