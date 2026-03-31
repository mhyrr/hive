#!/bin/bash
# HIVE morning briefing — installed by `hive init`
# launchd: 7am daily

set -euo pipefail

LOG_DIR="$HOME/.hive/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
echo "=== HIVE morning: $DATE $(date +%H:%M:%S) ==="

HIVE="${HIVE_BIN:-$(which hive 2>/dev/null || echo "$HOME/.local/bin/hive")}"

"$HIVE" --agent maya-morning \
  --max-turns 30 \
  "Generate morning briefing for $DATE." \
  2>&1

echo "=== HIVE morning complete: $(date +%H:%M:%S) ==="
