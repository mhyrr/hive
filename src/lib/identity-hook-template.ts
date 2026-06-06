/**
 * Canonical content of `~/.claude/hooks/load-identity.sh`.
 *
 * Single source of truth — embedded into the compiled binary so both
 * `hive init` (writes the live hook) and `hive doctor` (drift check)
 * agree without needing to read `templates/hooks/load-identity.sh`
 * at runtime. The on-disk template file in `templates/hooks/` is
 * kept byte-equal to this constant by `identity-hook-template.test.ts`.
 *
 * If you change this constant, also update the on-disk template and
 * vice versa — the test enforces they match.
 */
export const LOAD_IDENTITY_HOOK = `#!/bin/bash
# HIVE identity loader — delegates to \`hive identity emit\` so the canonical
# identity-assembly logic in src/lib/identity.ts is the single source of truth
# for SessionStart hooks, dispatch, and heartbeat. Drift is structurally
# impossible: there is only one program that builds the prefix.
#
# If \`hive\` isn't on PATH or fails, we emit nothing and exit 0 — sessions must
# never be blocked by a missing identity layer.
#
# Dedup guard: when HIVE launched this session itself, the identity is already
# in the system prompt and HIVE_IDENTITY_IN_PROMPT is set. Re-emitting here
# would duplicate ~63KB into context every turn, so skip. A plain \`claude\`
# session (no env var) still gets identity from this hook.

if [ -n "$HIVE_IDENTITY_IN_PROMPT" ]; then
  exit 0
fi

if command -v hive >/dev/null 2>&1; then
  HIVE_BIN="hive"
elif [ -x "$HOME/.local/bin/hive" ]; then
  HIVE_BIN="$HOME/.local/bin/hive"
else
  exit 0
fi

"$HIVE_BIN" identity emit 2>/dev/null || exit 0
`;
