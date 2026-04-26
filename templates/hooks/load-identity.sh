#!/bin/bash
# HIVE identity loader — delegates to `hive identity emit` so the canonical
# identity-assembly logic in src/lib/identity.ts is the single source of truth
# for SessionStart hooks, dispatch, and heartbeat. Drift is structurally
# impossible: there is only one program that builds the prefix.
#
# If `hive` isn't on PATH or fails, we emit nothing and exit 0 — sessions must
# never be blocked by a missing identity layer.

if command -v hive >/dev/null 2>&1; then
  HIVE_BIN="hive"
elif [ -x "$HOME/.local/bin/hive" ]; then
  HIVE_BIN="$HOME/.local/bin/hive"
else
  exit 0
fi

"$HIVE_BIN" identity emit 2>/dev/null || exit 0
