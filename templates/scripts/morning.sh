#!/bin/bash
# HIVE morning briefing — installed by `hive init`
# launchd: 7am daily

set -euo pipefail

LOG_DIR="$HOME/.hive/logs"
BRIEFING_DIR="$HOME/.hive/briefings"
mkdir -p "$LOG_DIR" "$BRIEFING_DIR"

DATE=$(date +%Y-%m-%d)
echo "=== HIVE morning: $DATE $(date +%H:%M:%S) ==="

CLAUDE="${CLAUDE_BIN:-$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")}"

"$CLAUDE" --agent maya-morning \
  --print \
  --max-turns 30 \
  "Generate morning briefing for $DATE." \
  2>&1

echo "=== HIVE morning complete: $(date +%H:%M:%S) ==="
