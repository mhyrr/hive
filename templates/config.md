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

## Runtime Access
# Document the login/auth lane you expect each direct CLI runtime to use.
# direct-auth-claude: subscription
# direct-auth-codex: cli
# direct-auth-gemini: cli
#
# Route the persistent Pi steward explicitly by session runtime.
# Generic fallback:
# pi-provider: anthropic
# pi-model: claude-sonnet-4-6
#
# Runtime-specific routes:
# pi-provider-claude: anthropic
# pi-model-claude: claude-sonnet-4-6
#
# Codex and Gemini stay on their direct CLI lanes by default. Uncomment these
# only if you explicitly want Pi to route through provider-backed OpenAI/Google
# APIs for those session runtimes.
# pi-provider-codex: openai
# pi-model-codex: gpt-5
# pi-provider-gemini: google
# pi-model-gemini: gemini-2.5-pro
#
# Provider auth policy for Pi:
# pi-auth-anthropic: oauth-only
# pi-auth-openai: env
# pi-auth-google: env
