#!/bin/bash
# HIVE watch tick — installed by `hive init`, launched hourly.

set -euo pipefail
unset ANTHROPIC_API_KEY

HIVE="${HIVE_BIN:-$(which hive 2>/dev/null || echo "$HOME/.local/bin/hive")}"
OAUTH_TOKEN_FILE="${HIVE_OAUTH_TOKEN_FILE:-$HOME/.hive/.oauth-token}"
if [ -s "$OAUTH_TOKEN_FILE" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$OAUTH_TOKEN_FILE")"
fi

if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -ims "$HIVE" watch run --due
fi
exec "$HIVE" watch run --due
