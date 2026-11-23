# Hive Config

## Hive Mind
# Runtime options: claude, codex, gemini
runtime: claude
# Model options vary by runtime:
#   claude: claude-sonnet-4-6 (default), claude-opus-4-6
#   codex: codex (uses OpenAI Codex CLI)
#   gemini: gemini-2.5-pro (uses Gemini CLI)
model: claude-sonnet-4-6

## Defaults
steward: steward
message-check-seconds: 30
archive-curation: deferred

## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse
- haiku: claude, claude-haiku-4-5-20251001, fast triage
- gpt54: codex, gpt-5.4, OpenAI frontier
- gpt53: codex, gpt-5.3, OpenAI general
- gemini: gemini-cli, gemini-2.5-pro, Google frontier
- gemini-flash: gemini-cli, gemini-2.5-flash, Google fast
# - qwen: ollama, qwen3:4b, local fast triage

## Provider Auth
pi-provider-claude: anthropic
pi-auth-anthropic: oauth-only
pi-provider-codex: openai-codex
pi-auth-openai-codex: oauth-only
pi-provider-gemini: google-gemini-cli
pi-auth-google-gemini-cli: oauth-only

steward-model: opus
council-default: opus, gpt54, gemini
