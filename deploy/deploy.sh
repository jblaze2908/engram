#!/bin/bash
# Production deploys are pull-based: the host's engram.timer fetches main every 2 min and runs deploy/pull-update.sh.
# This just runs that same deploy now (after you've pushed to main) and shows the result.
set -euo pipefail
HOST=${ENGRAM_SSH:-host}
ssh "$HOST" 'systemctl start engram.service; systemctl --no-pager --lines=0 status engram.service | head -3; journalctl -u engram.service -n 15 --no-pager -o cat'
