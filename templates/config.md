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

## Cognitive Routing
# How aggressively the steward should escalate beyond a direct answer.
# cognitive-bias: balanced        # latency | balanced | quality
# cognitive-max-fanout: 2         # cap for plural synthesis perspectives
# cognitive-max-parallel: 2       # concurrent worker cap for disjoint scopes

## Tier-1 Small Models
# Preferred local small-model lane for routine cognition. Point this at a
# model you have already pulled into Ollama.
# tier1_local: qwen3:4b
# Alternative starter:
# tier1_local: gemma3:4b
# Preferred cloud/fallback label for routine cognition when local models are
# unavailable or not yet wired in for execution.
# tier1_cloud: haiku
# tier1_fallback: haiku
# ollama-base-url: http://127.0.0.1:11434
