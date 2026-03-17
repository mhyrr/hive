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
# Most installs only need the Claude Pi lane.
# pi-provider-claude: anthropic
# pi-model-claude: claude-sonnet-4-6
# pi-auth-anthropic: oauth-only
# Advanced runtime/Pi routing stays in the README.

## Cognitive Routing
# How aggressively the steward should escalate beyond a direct answer.
# cognitive-bias: balanced        # latency | balanced | quality
# cognitive-max-fanout: 2         # cap for plural synthesis perspectives
# cognitive-max-parallel: 2       # concurrent worker cap for disjoint scopes
# cognitive-window-hours: 24      # rolling usage window for cognition budgets
# cognitive-budget-tier1-tokens: 50000
# cognitive-budget-tier2-tokens: 200000
# cognitive-budget-tier3-tokens: 50000
# cognitive-budget-warn-ratio: 0.9

## Tier-1 Small Models
# Start here:
# tier1-local: qwen3:4b
# tier1-cloud: haiku
# tier1-fallback: haiku
# ollama-base-url: http://127.0.0.1:11434
# Explicit provider/model overrides exist for advanced setups; see the README.
