#!/bin/bash
# HIVE nightly maintenance — installed by `hive init`
# launchd: 2am daily

set -euo pipefail

LOG_DIR="$HOME/.hive/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
echo "=== HIVE nightly: $DATE $(date +%H:%M:%S) ==="

HIVE="${HIVE_BIN:-$(which hive 2>/dev/null || echo "$HOME/.local/bin/hive")}"

# Step 1: Promote unprocessed reflections to project memory + inbox
echo "--- Promoting reflections ---"
"$HIVE" memory promote 2>&1 || echo "Reflection promotion failed (non-fatal)"

# Step 2: Condense raw JSONL session transcripts into readable markdown
echo "--- Extracting sessions ---"
"$HIVE" memory extract-sessions 2>&1 || echo "Session extraction failed (non-fatal)"

# Pick a GNU-compatible timeout (coreutils). macOS doesn't ship one by default.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi

TIMEOUT_DURATION="${HIVE_NIGHTLY_TIMEOUT:-25m}"

# Step 3: Dispatch maya-nightly to review and extract durable learnings.
# Wall-clock capped so a hung Anthropic stream surfaces as a launchd failure
# instead of a multi-hour silent wedge.
echo "--- Nightly extraction ---"
set +e
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" "$TIMEOUT_DURATION" "$HIVE" --agent maya-nightly \
    --max-turns 40 \
    "Run nightly extraction for $DATE." \
    2>&1
  NIGHTLY_RC=$?
else
  echo "WARN: no timeout binary found (gtimeout/timeout); running unbounded"
  "$HIVE" --agent maya-nightly \
    --max-turns 40 \
    "Run nightly extraction for $DATE." \
    2>&1
  NIGHTLY_RC=$?
fi
set -e

if [ "$NIGHTLY_RC" -eq 124 ] || [ "$NIGHTLY_RC" -eq 137 ]; then
  echo "=== HIVE nightly TIMED OUT after $TIMEOUT_DURATION (rc=$NIGHTLY_RC) at $(date +%H:%M:%S) ==="
  exit "$NIGHTLY_RC"
fi

if [ "$NIGHTLY_RC" -ne 0 ]; then
  echo "=== HIVE nightly FAILED (rc=$NIGHTLY_RC) at $(date +%H:%M:%S) ==="
  exit "$NIGHTLY_RC"
fi

echo "=== HIVE nightly complete: $(date +%H:%M:%S) ==="
