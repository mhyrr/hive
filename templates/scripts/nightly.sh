#!/bin/bash
# HIVE nightly maintenance — installed by `hive init`
# launchd: 2am daily
#
# V1 pipeline: condition → extract (B + C) → verify → apply → dashboard.
# LIVE: Pass F lands decisions to canon and the dashboard rebuilds. Set
# HIVE_NIGHTLY_DRY_RUN=1 to revert to dry-run if you want to test prompt
# changes without touching canon.

set -euo pipefail

LOG_DIR="$HOME/.hive/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
echo "=== HIVE nightly: $DATE $(date +%H:%M:%S) ==="

HIVE="${HIVE_BIN:-$(which hive 2>/dev/null || echo "$HOME/.local/bin/hive")}"

# Pick a GNU-compatible timeout (coreutils). macOS doesn't ship one by default.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi

TIMEOUT_DURATION="${HIVE_NIGHTLY_TIMEOUT:-25m}"

# Live by default. Set HIVE_NIGHTLY_DRY_RUN=1 to suppress canon writes.
DRY_RUN_FLAG=""
if [ "${HIVE_NIGHTLY_DRY_RUN:-0}" = "1" ]; then
  DRY_RUN_FLAG="--dry-run"
  echo "--- Running memory nightly orchestrator (dry-run) ---"
else
  echo "--- Running memory nightly orchestrator (LIVE) ---"
fi

set +e
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" "$TIMEOUT_DURATION" "$HIVE" memory nightly $DRY_RUN_FLAG 2>&1
  NIGHTLY_RC=$?
else
  echo "WARN: no timeout binary found (gtimeout/timeout); running unbounded"
  "$HIVE" memory nightly $DRY_RUN_FLAG 2>&1
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
