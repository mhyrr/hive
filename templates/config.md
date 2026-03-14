# Hive Config

## Hive Mind
# Runtime options: claude, codex, ollama
runtime: claude
# Model options vary by runtime:
#   claude: claude-sonnet-4-6 (default), claude-opus-4-6
#   codex: codex (uses OpenAI Codex CLI)
#   ollama: local-small, local-large (requires local Ollama server)
model: claude-sonnet-4-6

## Defaults
orchestrator: steward
message-check-seconds: 30
archive-curation: deferred