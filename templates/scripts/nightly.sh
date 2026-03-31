#!/bin/bash
# HIVE nightly maintenance — installed by `hive init`
# Crontab: 0 2 * * * ~/.hive/scripts/nightly.sh >> ~/.hive/logs/nightly.log 2>&1

set -euo pipefail

LOG_DIR="$HOME/.hive/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
echo "=== HIVE nightly: $DATE $(date +%H:%M:%S) ==="

CLAUDE="${CLAUDE_BIN:-$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")}"

"$CLAUDE" --agent maya-nightly \
  --print \
  --max-turns 40 \
  "Run nightly extraction for $DATE." \
  2>&1

echo "=== HIVE nightly complete: $(date +%H:%M:%S) ==="
