#!/bin/bash
# Identity-mode conformance sweep.
#
# Runs the failure-mode prompt battery through one launch mode and saves one
# transcript per prompt for blind voice/ritual judging (via convene_council).
# The point: check whether the shipped identity config holds Maya's voice on
# the cases where the superpowers "invoke a skill before responding" ritual is
# loudest (build/debug/ambiguous prompts), not just the easy research ones.
#
# Usage: run.sh [append|owned|bare]   (default: append)
#   append  — shipped default; identity in system prompt, hook deduped, subscription
#   owned   — identity replaces the CC base system prompt; subscription
#   bare    — no hooks at all (superpowers absent = ceiling); needs ANTHROPIC_API_KEY
set -u
MODE="${1:-append}"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/transcripts/$MODE"
mkdir -p "$OUT"
FLAG=""
[ "$MODE" = "owned" ] && FLAG="--owned"
[ "$MODE" = "bare" ] && FLAG="--bare"

n=0
while IFS= read -r prompt; do
  [ -z "$prompt" ] && continue
  n=$((n + 1))
  f="$OUT/$(printf '%02d' "$n")"
  { printf '### PROMPT %d\n%s\n\n### RESPONSE\n' "$n" "$prompt"; } > "$f.txt"
  # < /dev/null skips claude's 3s stdin wait; stderr to a sibling .err for diagnosis.
  timeout 180 hive $FLAG -p "$prompt" < /dev/null >> "$f.txt" 2>"$f.err"
  echo "prompt $n done ($(wc -c < "$f.txt") bytes)"
done < "$DIR/battery.txt"
echo "SWEEP COMPLETE ($MODE): $n transcripts in $OUT"
