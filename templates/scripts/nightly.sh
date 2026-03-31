#!/bin/bash
# HIVE nightly maintenance — installed by `hive init`
# launchd: 2am daily

set -euo pipefail

LOG_DIR="$HOME/.hive/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
echo "=== HIVE nightly: $DATE $(date +%H:%M:%S) ==="

HIVE="${HIVE_BIN:-$(which hive 2>/dev/null || echo "$HOME/.local/bin/hive")}"

"$HIVE" --agent maya-nightly \
  --max-turns 40 \
  "Run nightly extraction for $DATE." \
  2>&1

echo "=== HIVE nightly complete: $(date +%H:%M:%S) ==="
