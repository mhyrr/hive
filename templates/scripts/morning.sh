#!/bin/bash
# HIVE morning briefing — installed by `hive init`
# launchd: 7am daily

set -euo pipefail

LOG_DIR="$HOME/.hive/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
echo "=== HIVE morning: $DATE $(date +%H:%M:%S) ==="

HIVE="${HIVE_BIN:-$(which hive 2>/dev/null || echo "$HOME/.local/bin/hive")}"

# Pick a GNU-compatible timeout (coreutils). macOS doesn't ship one by default.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi

TIMEOUT_DURATION="${HIVE_MORNING_TIMEOUT:-25m}"

# Run the briefing with a hard wall clock cap. If the agent hangs (Anthropic
# stream idle, runaway loop, etc.), launchd gets a non-zero exit instead of a
# silent multi-hour wedge.
set +e
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" "$TIMEOUT_DURATION" "$HIVE" --agent maya-morning \
    --max-turns 50 \
    "Generate morning briefing for $DATE." \
    2>&1
  BRIEF_RC=$?
else
  echo "WARN: no timeout binary found (gtimeout/timeout); running unbounded"
  "$HIVE" --agent maya-morning \
    --max-turns 50 \
    "Generate morning briefing for $DATE." \
    2>&1
  BRIEF_RC=$?
fi
set -e

if [ "$BRIEF_RC" -eq 124 ] || [ "$BRIEF_RC" -eq 137 ]; then
  echo "=== HIVE morning TIMED OUT after $TIMEOUT_DURATION (rc=$BRIEF_RC) at $(date +%H:%M:%S) ==="
  exit "$BRIEF_RC"
fi

if [ "$BRIEF_RC" -ne 0 ]; then
  echo "=== HIVE morning FAILED (rc=$BRIEF_RC) at $(date +%H:%M:%S) ==="
  exit "$BRIEF_RC"
fi

# Regenerate the Morning Edition dashboard after the briefing lands.
# Failures here are non-fatal — the briefing is the primary artifact.
echo "--- HIVE dashboard rebuild: $(date +%H:%M:%S) ---"
"$HIVE" dashboard build 2>&1 || echo "dashboard build failed (non-fatal)"

echo "=== HIVE morning complete: $(date +%H:%M:%S) ==="
