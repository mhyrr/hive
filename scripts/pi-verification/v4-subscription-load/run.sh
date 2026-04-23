#!/usr/bin/env bash
# V4 — Subscription OAuth survives dispatch-shaped usage.
# From docs/specs/2026-04-22-hive-on-pi-design.md §6.1.
#
# Runs N sequential single-turn pi --print sessions, spaced to span ~2h.
# Pass: all iterations succeed, auth.json stays populated, no API-key fallback.
#
# Env overrides (for smoke testing):
#   V4_ITERATIONS=<N>    default 10
#   V4_INTERVAL=<secs>   default 720 (12 min × 9 gaps = ~108 min; add run time ≈ 2h)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HERE/runs"
mkdir -p "$LOG_DIR"

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG_FILE="$LOG_DIR/v4-$TS.log"
RESULT_FILE="$LOG_DIR/v4-$TS.json"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

auth_size() { wc -c < "$HOME/.pi/agent/auth.json" 2>/dev/null | tr -d ' \n' || echo 0; }

ITERATIONS="${V4_ITERATIONS:-10}"
INTERVAL_SECONDS="${V4_INTERVAL:-720}"

log "V4 start — iterations=$ITERATIONS interval=${INTERVAL_SECONDS}s"
log "auth.json before: $(auth_size) bytes"

if [ "$(auth_size)" -lt 50 ]; then
  log "ABORT: auth.json too small ($(auth_size) bytes) — run 'pi /login' first."
  exit 2
fi

auth_before=$(auth_size)
declare -a results=()
passed=0
failed=0

for i in $(seq 1 "$ITERATIONS"); do
  t_start=$(date -u +%s)
  log "[$i/$ITERATIONS] starting"

  tmp_out=$(mktemp)
  if echo "Reply with only: ok" \
    | pi --print --no-session --no-tools --no-extensions --no-skills --thinking off --provider anthropic \
    >"$tmp_out" 2>&1
  then
    status="ok"
    passed=$((passed + 1))
  else
    status="fail"
    failed=$((failed + 1))
  fi

  t_end=$(date -u +%s)
  output_head=$(head -c 300 "$tmp_out" | tr '\n' ' ')
  auth_now=$(auth_size)

  log "[$i/$ITERATIONS] status=$status duration=$((t_end - t_start))s auth=${auth_now}b"
  log "[$i/$ITERATIONS] output: $output_head"

  results+=("{\"i\":$i,\"status\":\"$status\",\"duration\":$((t_end - t_start)),\"auth_size\":$auth_now}")
  rm -f "$tmp_out"

  if [ "$i" -lt "$ITERATIONS" ]; then
    log "sleeping ${INTERVAL_SECONDS}s before next iteration..."
    sleep "$INTERVAL_SECONDS"
  fi
done

auth_after=$(auth_size)
log "V4 complete — passed=$passed failed=$failed auth_before=${auth_before}b auth_after=${auth_after}b"

joined=$(IFS=,; echo "${results[*]}")
cat > "$RESULT_FILE" <<JSON
{
  "timestamp": "$TS",
  "iterations": $ITERATIONS,
  "interval_seconds": $INTERVAL_SECONDS,
  "passed": $passed,
  "failed": $failed,
  "auth_before": $auth_before,
  "auth_after": $auth_after,
  "results": [$joined]
}
JSON

log "Results: $RESULT_FILE"

if [ "$failed" -eq 0 ]; then
  log "PASS: all $ITERATIONS sessions succeeded."
  exit 0
else
  log "FAIL: $failed/$ITERATIONS failed."
  exit 1
fi
