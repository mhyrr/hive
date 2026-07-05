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

# Subscription OAuth token (from `claude setup-token`) for the detached launchd
# context. At 2am there is no GUI session, so claude's Keychain OAuth refresh
# stalls for ~an hour mid-run (TK-130). A long-lived token in the environment
# switches claude to the keychain-independent `oauth_token` auth path — no
# refresh, no stall. The file is 0600 and holds only the raw token. If it is
# absent we fall back to Keychain OAuth (which may stall under launchd).
OAUTH_TOKEN_FILE="${HIVE_OAUTH_TOKEN_FILE:-$HOME/.hive/.oauth-token}"
if [ -s "$OAUTH_TOKEN_FILE" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$OAUTH_TOKEN_FILE")"
  echo "auth: long-lived OAuth token ($OAUTH_TOKEN_FILE) — Keychain bypassed"
else
  echo "WARN: $OAUTH_TOKEN_FILE missing/empty — using Keychain OAuth (may stall under launchd, TK-130)"
fi

# Pick a GNU-compatible timeout (coreutils). macOS doesn't ship one by default.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi

TIMEOUT_DURATION="${HIVE_NIGHTLY_TIMEOUT:-25m}"

# Hold the machine at full power for the run. This is a laptop: asleep on
# battery, launchd wakes it only into throttled DarkWake (~180s maintenance
# windows) where claude --print crawls and calls exceed their deadline. That's
# the TK-130 residual after the OAuth-token fix removed the Keychain stall.
# caffeinate keeps a wake assertion for the run's lifetime (-i idle, -m disk;
# -s system-sleep applies on AC). Most reliable when the laptop is plugged in.
CAFF=""
if command -v caffeinate >/dev/null 2>&1; then CAFF="caffeinate -ims"; fi

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
  $CAFF "$TIMEOUT_BIN" "$TIMEOUT_DURATION" "$HIVE" memory nightly $DRY_RUN_FLAG 2>&1
  NIGHTLY_RC=$?
else
  echo "WARN: no timeout binary found (gtimeout/timeout); running unbounded"
  $CAFF "$HIVE" memory nightly $DRY_RUN_FLAG 2>&1
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
