# HIVE Compatibility Matrix

**Date:** 2026-05-11
**Baseline commit:** `5046c17`

## At-a-Glance Summary

| | Claude Code | Codex |
|---|---|---|
| **Identity injection** | working | working |
| **MCP tools** | working | working |
| **Dispatch** | working | n/a |
| **Heartbeat** | working | n/a |
| **Campaign** | working | n/a |
| **Doctor** | working | working |
| **Council** | working | working (as model) |
| **Memory pipeline** | working | n/a |

HIVE's primary integration is with Claude Code. Codex support covers interactive sessions (identity, MCP) and council (as a model provider). Dispatch, heartbeat, campaign, and the memory pipeline are Claude-Code-only.

---

## Detailed Matrix

| HIVE Feature | Claude Code | Codex | Notes |
|---|---|---|---|
| **Identity injection** | `working` — SessionStart + PostCompact hook via `~/.claude/hooks/load-identity.sh`. Calls `hive identity emit`. | `working` — SessionStart hook via `~/.hive/codex-load-identity.sh` refreshes `~/.codex/AGENTS.md`. Byte-equivalence check preserves prefix cache. | Both harnesses use `assembleIdentity()` as single source of truth. CC hook outputs to stdout (appended to system prompt); Codex hook writes to AGENTS.md file. |
| **MCP tools (18)** | `working` — Registered in `~/.claude.json` as `hive-mcp` binary. Tool schemas deferred behind ToolSearch; prompt instructs first-turn pre-fetch. | `working` — Registered in `~/.codex/config.toml` via `codex mcp add`. | Same MCP server binary serves both harnesses. |
| **Dispatch** | `working` — Detached `/bin/bash` wrapper spawns `claude --agent maya-executor --worktree`. Model pinned to `claude-opus-4-6`. OAuth enforced. | `n/a` — Dispatch does not support Codex as executor. | Dispatch is tightly coupled to Claude Code's `--agent`, `--worktree`, `--permission-mode`, `--append-system-prompt-file` flags. |
| **Heartbeat** | `working` — `Bun.spawnSync` with `claude --agent maya-heartbeat --print`. Deterministic trigger gate. Byte-stable identity for cache hits. | `n/a` — Heartbeat does not support Codex. | Heartbeat relies on Claude Code's `--print`, `--max-turns`, `--agent` flags. |
| **Campaign orchestrator** | `working` — Executor uses `claude --print --output-format stream-json`. Judge uses `claude-opus-4-7` with frozen prefix for cache. | `n/a` — Campaign does not support Codex executor. | Campaign is the most Claude-Code-coupled feature (soft caps, stream-json parsing, worktree). |
| **Doctor** | `working` — Checks hook, MCP, settings.json, CLAUDE.md, scheduler plists. | `working` — Checks MCP in config.toml, AGENTS.md freshness, hook script, hooks.json wiring. | Doctor gracefully skips Codex checks if Codex isn't installed. |
| **Council** | `working` — `src/lib/claude.ts` subprocess driver for Claude-as-council-member. | `working` — `src/lib/codex.ts` subprocess driver for Codex-as-council-member via `codex exec --json`. | Council uses both as model providers, not as harnesses. Codex driver scrubs `OPENAI_API_KEY`. |
| **Memory pipeline** | `working` — Nightly orchestrator (Pass A→B→C→V→F) runs via launchd. Memory read/write/search via MCP. | `n/a` — Pipeline doesn't run through Codex. | MCP tools provide read/write access from Codex sessions, but the pipeline itself (condition, extract, verify, apply) is Claude-Code-only. |
| **Interactive session** | `working` — `hive` or `hive <prompt>` launches Claude Code in append mode. `--owned` and `--bare` modes available. | `working` — `hive -x` launches Codex with identity refresh. `OPENAI_API_KEY` scrubbed. | Both paths refresh identity before spawn. |
| **Agent templates** | `working` — 5 templates installed to `~/.claude/agents/` (maya-coder, -executor, -heartbeat, -planner, -reviewer). | `gap` — Agent templates are Claude-Code-specific (`--agent` flag). Codex has no equivalent agent template system. | Codex identity goes through AGENTS.md, not per-agent templates. |
| **Skills** | `working` — `hive-status` skill installed to `~/.claude/skills/`. | `gap` — Codex does not have a skill system equivalent. | Skills are a Claude Code plugin feature. |
| **OAuth enforcement** | `working` — `ANTHROPIC_API_KEY` unset in all spawned processes. | `working` — `OPENAI_API_KEY` scrubbed in Codex spawns. | Different keys for different providers; same enforcement pattern. |
| **Model selection** | `working` — Pinned to `claude-opus-4-6` for autonomous work, `claude-opus-4-7` for judge. Env overrides available. | `degraded` — Codex model selection via `-m` flag in `codex exec`. No HIVE-level model pinning for Codex interactive sessions. | Interactive `hive -x` doesn't pass a model flag to Codex; uses Codex's default. |
| **`hive init`** | `working` — Installs hook, MCP, agents, skills, identity files. | `working` — Installs MCP, AGENTS.md, hook script, hooks.json. Best-effort, silent skip if Codex absent. | Init is idempotent for both harnesses. |

---

## Legend

- **working** — Feature operates as designed; verified by doctor checks and/or test suite.
- **degraded** — Feature partially works but with known limitations.
- **gap** — Platform capability exists in one harness but has no equivalent in the other; HIVE doesn't attempt it.
- **n/a** — Feature is architecturally irrelevant for this harness (e.g., dispatch is Claude-Code-only by design, not by omission).
