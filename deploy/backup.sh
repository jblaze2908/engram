#!/usr/bin/env bash
set -Eeuo pipefail

# Nightly off-site backup: the vault (markdown + its git history) and a VACUUM INTO copy of engram.db, encrypted by
# restic and sent to Google Drive through rclone (Tijori's tijori-drive remote, a separate repository). master.key is
# not in here on purpose: it lives in the password manager. Run by deploy/engram-backup.timer.
DATA="${ENGRAM_DATA:-/srv/engram}"
ENV_FILE="${ENGRAM_ENV_FILE:-/etc/engram/engram.env}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-rclone:tijori-drive:engram-backup}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/etc/engram/restic.pass}"
SNAP="$DATA/backups/nightly.db"
MARKER="$DATA/backups/last-backup"   # epoch ms of the last good run; Engram's Status shows it
NODE_DB="new (require('node:sqlite').DatabaseSync)"

notify() {
  # Same shape as pull-update.sh; NTFY_* (or ENGRAM_NTFY_*) live in the root-only env file and are never echoed.
  [[ -f "$ENV_FILE" ]] || return 0
  url="$(sed -n 's/^\(ENGRAM_\)\{0,1\}NTFY_URL=//p' "$ENV_FILE" | tail -1)"; [[ -n "$url" ]] || return 0
  token="$(sed -n 's/^\(ENGRAM_\)\{0,1\}NTFY_TOKEN=//p' "$ENV_FILE" | tail -1)"
  curl --silent --max-time 10 ${token:+-H "Authorization: Bearer $token"} -d "engram: $1" "$url" >/dev/null || true
}
trap 'notify "❌ backup failed at line $LINENO"' ERR

docker ps --format '{{.Names}}' | grep -qx engram-app
# The container runs as 1600 and only $DATA is writable there, so the snapshot lands next to the data.
install -d -o 1600 -g 1600 -m 700 "$DATA/backups"
rm -f "$SNAP"
docker exec engram-app node -e "$NODE_DB('$DATA/engram.db').exec(\"VACUUM INTO '$SNAP'\")"
docker exec engram-app node -e "const r = $NODE_DB('$SNAP', { readOnly: true }).prepare('PRAGMA integrity_check').get(); process.exit(Object.values(r)[0] === 'ok' ? 0 : 1)"

restic cat config >/dev/null 2>&1 || restic init
restic backup --host host --tag engram "$SNAP" "$DATA/vault"
restic forget --host host --tag engram --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune

# On the 1st (or VERIFY=1): restore the latest snapshot and compare it with what was just sent. The DB copy must be
# byte-identical, the vault's git must be sound with a clean tree, and its HEAD must be in the live history.
if [[ "$(date +%d)" == "01" || "${VERIFY:-0}" == "1" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  restic restore latest --host host --tag engram --target "$tmp"
  cmp -s "$tmp$SNAP" "$SNAP" || { echo "restored engram.db differs from the snapshot" >&2; false; }
  vgit() { git -c safe.directory='*' -C "$1" "${@:2}"; }
  vgit "$tmp$DATA/vault" fsck --no-progress --no-dangling
  [[ -z "$(vgit "$tmp$DATA/vault" status --porcelain)" ]] || { echo "restored vault differs from its own HEAD" >&2; false; }
  vgit "$DATA/vault" cat-file -e "$(vgit "$tmp$DATA/vault" rev-parse HEAD)^{commit}"
  restic check --read-data-subset=5%
  echo "restore check ok"
fi

date +%s%3N >"$MARKER.part" && chown 1600:1600 "$MARKER.part" && mv "$MARKER.part" "$MARKER"
echo "backup ok: $(du -sh "$SNAP" | cut -f1) db + vault"
