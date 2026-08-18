#!/bin/bash
# Weekly taste-review reminder — Sunday 19:00.
#
# Exception-only: it speaks when there is something to decide and stays silent
# otherwise. A reminder that fires every week whether or not it has news trains
# you to ignore it.
#
# "Something to decide" currently means contradictions held at `pending` — units
# that cleared the recurrence gate but disagree with an apex principle, so the
# machine gate deliberately refused to admit them. When the TD/distill pass
# lands (context-layer design, slice 4) amendment and new-principle proposals
# join the same trigger.

set -uo pipefail

HIVE_BIN="${HIVE_BIN:-$HOME/.local/bin/hive}"
INBOX="$HOME/.hive/inbox.md"
STAMP="$(date +%Y-%m-%d)"
WEEK_AGO="$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d)"

if [ ! -x "$HIVE_BIN" ]; then
  echo "$(date -u +%FT%TZ) taste-review: $HIVE_BIN not executable — skipping" >&2
  exit 0
fi

STATUS_JSON="$("$HIVE_BIN" taste status --json --since "$WEEK_AGO" 2>/dev/null)" || {
  echo "$(date -u +%FT%TZ) taste-review: status failed" >&2
  exit 0
}

read -r PENDING ACTIVE HOLDING ADMITTED <<EOF
$(printf '%s' "$STATUS_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(d["pending"], d["active"], d["holding"], len(d["recent"]))
')
EOF

# Nothing to decide → stay quiet. Note this is deliberately NOT gated on
# ADMITTED: units admitting themselves is the system working, not news.
if [ "${PENDING:-0}" -eq 0 ]; then
  echo "$(date -u +%FT%TZ) taste-review: quiet — 0 held, ${ACTIVE} active, ${ADMITTED} admitted this week" >&2
  exit 0
fi

{
  printf '\n## %s — weekly taste review\n\n' "$STAMP"
  printf '%s contradiction(s) held for your call. %s active, %s still accumulating.\n' \
    "$PENDING" "$ACTIVE" "$HOLDING"
  printf '%s unit(s) admitted themselves this week.\n\n' "$ADMITTED"
  printf 'A held unit disagrees with an apex principle that is injected into every\n'
  printf 'session. Until you decide which side is wrong, it stays out of retrieval.\n\n'
  printf -- '- `hive taste review` — walk the queue (y/n keypress)\n'
  printf -- '- `hive taste status --since %s` — what landed this week\n' "$WEEK_AGO"
  printf -- '- dashboard → /taste for the whole library\n\n'
  printf -- '---\n'
} >> "$INBOX"

osascript -e "display notification \"${PENDING} contradiction(s) need a call — hive taste review\" with title \"HIVE · weekly taste review\" sound name \"Submarine\"" 2>/dev/null || true

echo "$(date -u +%FT%TZ) taste-review: surfaced ${PENDING} held unit(s) to inbox" >&2
