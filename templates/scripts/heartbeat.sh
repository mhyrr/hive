#!/bin/bash
# HIVE heartbeat — installed by `hive init`
# launchd: every 30 minutes

set -euo pipefail

LOG_DIR="$HOME/.hive/logs"
mkdir -p "$LOG_DIR"

HIVE="${HIVE_BIN:-$(which hive 2>/dev/null || echo "$HOME/.local/bin/hive")}"

echo "=== HIVE heartbeat: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# Iterate over all projects with heartbeat enabled
for project_dir in "$HOME/.hive/projects"/*/; do
  [ -d "$project_dir" ] || continue
  [ -f "$project_dir/heartbeat.json" ] || continue

  project_name=$(basename "$project_dir")

  # Check if this project is due for a tick
  should_tick=$("$HIVE" heartbeat check-interval --project "$project_name" 2>/dev/null || echo "skip")

  if [ "$should_tick" = "skip" ]; then
    continue
  fi

  echo "--- heartbeat: $project_name ---"
  "$HIVE" heartbeat tick --project "$project_name" 2>&1 || {
    echo "heartbeat tick failed for $project_name (exit $?)"
  }
done

echo "=== HIVE heartbeat complete: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
