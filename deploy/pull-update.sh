#!/usr/bin/env bash
set -euo pipefail

# Pull-based deploy, same shape as Pitcrew's: the host fetches main itself, so nothing outside it holds server access.
# Run by deploy/engram.timer every 2 min; a no-op unless main moved or the app is down. Images are tagged per
# commit, so a rollback restores the previous image exactly.
DEPLOY_DIR="${DEPLOY_DIR:-/opt/engram}"
BRANCH="${DEPLOY_BRANCH:-main}"
STATE_DIR="${ENGRAM_STATE_DIR:-/var/lib/engram}"
ENV_FILE="${ENGRAM_ENV_FILE:-/etc/engram/engram.env}"
HEALTH_URL="${ENGRAM_HEALTH_URL:-http://172.17.0.1:8340/healthz}"
DATA=/srv/engram
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /root/.ssh/engram_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes}"

install -d -m 700 "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || exit 0

RELEASE="$STATE_DIR/release.env"   # ENGRAM_TAG of the running release
compose() { docker compose -p engram -f deploy/compose.yml --env-file "$1" "${@:2}"; }

notify() {
  # Optional ops alerts; NTFY_* live in the root-only env file and are never echoed.
  [[ -f "$ENV_FILE" ]] || return 0
  url="$(sed -n 's/^NTFY_URL=//p' "$ENV_FILE" | tail -1)"; [[ -n "$url" ]] || return 0
  token="$(sed -n 's/^NTFY_TOKEN=//p' "$ENV_FILE" | tail -1)"
  curl --silent --max-time 10 ${token:+-H "Authorization: Bearer $token"} -d "engram: $1" "$url" >/dev/null || true
}

cd "$DEPLOY_DIR"
deployed_commit="$(git rev-parse -q --verify refs/heads/deployed || true)"
git fetch --prune origin "$BRANCH"
target_commit="$(git rev-parse "origin/$BRANCH")"
short="${target_commit:0:8}"

running() { docker ps --format '{{.Names}}' | grep -qx engram-app; }
if [[ "$deployed_commit" == "$target_commit" ]] && running; then exit 0; fi
# Don't rebuild a commit that already failed; a new push clears it.
if [[ "$(cat "$STATE_DIR/failed-commit" 2>/dev/null || true)" == "$target_commit" ]]; then exit 0; fi

reject() { echo "$target_commit" >"$STATE_DIR/failed-commit"; notify "❌ $short rejected: $1"; echo "rejected: $1" >&2; exit 1; }

git checkout --detach "$target_commit"
# Bash is still reading the pre-checkout copy of this script; rerun the new one so a release that changes the deploy steps gets them.
if [[ -z "${ENGRAM_REEXEC:-}" ]] && ! git diff --quiet "${deployed_commit:-$target_commit}" "$target_commit" -- deploy/pull-update.sh; then
  ENGRAM_REEXEC=1 exec bash "$DEPLOY_DIR/deploy/pull-update.sh"
fi

# The container runs as 1600 with a read-only root; only the data directory is writable.
install -d -o 1600 -g 1600 -m 700 "$DATA" "$DATA/home"

# Build before touching the running app, so a broken build never takes it down.
docker build -q -t "engram-app:$short" app >/dev/null || reject "app image build failed"

# SQLite snapshot before the new code boots (schema changes run at boot and a rollback doesn't undo them).
install -d -o 1600 -g 1600 -m 700 "$DATA/backups"
if running; then
  docker exec engram-app node -e "new (require('node:sqlite').DatabaseSync)('$DATA/engram.db').exec(\"VACUUM INTO '$DATA/backups/pre-$short.db'\")" 2>/dev/null || true
  ls -1t "$DATA"/backups/pre-*.db 2>/dev/null | tail -n +15 | xargs -r rm -f
fi

next="$STATE_DIR/next.env"
printf 'ENGRAM_TAG=%s\n' "$short" >"$next"
healthy() { for _ in {1..30}; do curl --fail --silent -m 5 "$HEALTH_URL" >/dev/null && return 0; sleep 2; done; return 1; }
rollback() {
  echo "Rolling back to $(cat "$RELEASE" 2>/dev/null | tr '\n' ' ')" >&2
  if [[ -f "$RELEASE" ]]; then compose "$RELEASE" up --detach --remove-orphans || true; fi
  git checkout --detach "${deployed_commit:-$target_commit}" || true
}
if ! compose "$next" up --detach --remove-orphans || ! healthy; then rollback; reject "rollout or health check failed"; fi

mv "$next" "$RELEASE"
git branch --force deployed "$target_commit"
rm -f "$STATE_DIR/failed-commit"
# Keep the last three images for rollback.
keep="$(sed -n 's/^ENGRAM_TAG=//p' "$RELEASE")"
docker image ls engram-app --format '{{.Tag}} {{.CreatedAt}}' | sort -k2 -r | awk '{print $1}' | tail -n +4 | grep -vx "$keep" | xargs -r -I{} docker image rm "engram-app:{}" >/dev/null 2>&1 || true
notify "✅ deployed $short"
echo "deployed $short"
