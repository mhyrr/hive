#!/bin/bash
# HIVE state sync — commits and pushes ~/.hive changes
# Crontab: 30 2 * * * ~/.hive/scripts/hive-sync.sh >> ~/.hive/logs/hive-sync.log 2>&1
# Runs 30min after nightly extraction to capture its output

set -euo pipefail

HIVE_DIR="$HOME/.hive"
LOG_DIR="$HIVE_DIR/logs"
mkdir -p "$LOG_DIR"

DATE=$(date +%Y-%m-%d)
echo "=== HIVE sync: $DATE $(date +%H:%M:%S) ==="

cd "$HIVE_DIR"

# Check if there's anything to commit
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "Nothing to sync."
  echo "=== HIVE sync complete: $(date +%H:%M:%S) ==="
  exit 0
fi

git add -A
git commit -m "nightly: $DATE"
git push

echo "=== HIVE sync complete: $(date +%H:%M:%S) ==="
