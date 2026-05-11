# HIVE Compatibility Matrix

**Date:** 2026-05-11
**Baseline commit:** `5046c17`
**Claude Code:** 2.1.138 (May 9, 2026)
**Codex:** 0.128.0 (April 30, 2026) — 2 releases behind current (0.130.0)

## At-a-Glance Summary

| | Claude Code | Codex |
|---|---|---|
| **Identity injection** | working | working |
| **MCP tools** | working | working |
| **Dispatch** | working | n/a |
| **Heartbeat** | working | n/a |
| **Campaign** | working | n/a |
| **Doctor** | working | degraded |
| **Council** | working | working (as model) |
| **Memory pipeline** | working | n/a |
| **Model pinning** | working | working |

HIVE's primary integration is with Claude Code. Codex support covers interactive sessions (identity, MCP) and council (as a model provider). Dispatch, heartbeat, campaign, and the memory pipeline are Claude-Code-only.

**Action items surfaced by this matrix:**
1. **Codex version lag** — 0.128.0 installed vs. 0.130.0 current. `codex_hooks` feature flag deprecated in v0.129. Doctor check needs updating.
2. **MCP deferral workaround** — `alwaysLoad` config option exists in Claude Code (v2.1.121+); would eliminate prompt-level pre-fetch hack.
3. **Model pin planning** — `claude-opus-4-6` is Active until at least Feb 5, 2027. Plan a bump to Opus 4.7 before then (low urgency).

---

## Detailed Matrix

| HIVE Feature | Claude Code | Codex | Notes |
|---|---|---|---|
| **Identity injection** | `working` — SessionStart + PostCompact hook via `~/.claude/hooks/load-identity.sh`. Calls `hive identity emit`. | `working` — SessionStart hook via `~/.hive/codex-load-identity.sh` refreshes `~/.codex/AGENTS.md`. Byte-equivalence check preserves prefix cache. | Both harnesses use `assembleIdentity()` as single source of truth. CC hook outputs to stdout (appended to system prompt); Codex hook writes to AGENTS.md file. |
| **MCP tools (18)** | `working` — Registered in `~/.claude.json` as `hive-mcp` binary. Tool schemas deferred behind ToolSearch; prompt instructs first-turn pre-fetch. Could use `alwaysLoad` to skip deferral. | `working` — Registered in `~/.codex/config.toml` via `codex mcp add`. Auto-launched on session start. | Same MCP server binary serves both harnesses. |
| **Dispatch** | `working` — Detached `/bin/bash` wrapper spawns `claude --agent maya-executor --worktree`. Model pinned to `claude-opus-4-6`. OAuth enforced. | `n/a` — Dispatch does not support Codex as executor. Codex `remote_control` (v0.130) could enable this in future. | Dispatch is tightly coupled to Claude Code's `--agent`, `--worktree`, `--permission-mode`, `--append-system-prompt-file` flags. |
| **Heartbeat** | `working` — `Bun.spawnSync` with `claude --agent maya-heartbeat --print`. Deterministic trigger gate. Byte-stable identity for cache hits. | `n/a` — Heartbeat does not support Codex. | Heartbeat relies on Claude Code's `--print`, `--max-turns`, `--agent` flags. |
| **Campaign orchestrator** | `working` — Executor uses `claude --print --output-format stream-json`. Judge uses `claude-opus-4-7` with frozen prefix for cache. | `n/a` — Campaign does not support Codex executor. | Campaign is the most Claude-Code-coupled feature (soft caps, stream-json parsing, worktree). |
| **Doctor** | `working` — Checks hook, MCP, settings.json, CLAUDE.md, scheduler plists. | `degraded` — Checks `codex_hooks` feature flag, but this flag is deprecated in Codex v0.129+. Doctor will report false state after upgrade. | Doctor gracefully skips Codex checks if Codex isn't installed. Needs update for `codex_hooks` → `hooks` rename. |
| **Council** | `working` — `src/lib/claude.ts` subprocess driver for Claude-as-council-member. | `working` — `src/lib/codex.ts` subprocess driver for Codex-as-council-member via `codex exec --json`. Now reports reasoning-token usage. | Council uses both as model providers, not as harnesses. Codex driver scrubs `OPENAI_API_KEY`. |
| **Memory pipeline** | `working` — Nightly orchestrator (Pass A→B→C→V→F) runs via launchd. Memory read/write/search via MCP. | `n/a` — Pipeline doesn't run through Codex. | MCP tools provide read/write access from Codex sessions, but the pipeline itself (condition, extract, verify, apply) is Claude-Code-only. |
| **Interactive session** | `working` — `hive` or `hive <prompt>` launches Claude Code in append mode. `--owned` and `--bare` modes available. | `working` — `hive -x` launches Codex with identity refresh. `OPENAI_API_KEY` scrubbed. | Both paths refresh identity before spawn. |
| **Agent templates** | `working` — 5 templates installed to `~/.claude/agents/` (maya-coder, -executor, -heartbeat, -planner, -reviewer). | `gap` — Agent templates are Claude-Code-specific (`--agent` flag). Codex has no equivalent. `child_agents_md` (under dev) could change this. | Codex identity goes through AGENTS.md, not per-agent templates. |
| **Skills** | `working` — `hive-status` skill installed to `~/.claude/skills/`. | `gap` — Codex does not have a skill system equivalent. Codex uses MCP + Plugins instead. | Skills are a Claude Code plugin feature. |
| **OAuth enforcement** | `working` — `ANTHROPIC_API_KEY` unset in all spawned processes. | `working` — `OPENAI_API_KEY` scrubbed in Codex spawns. | Different keys for different providers; same enforcement pattern. |
| **Model pinning** | `working` — Pinned to `claude-opus-4-6` (Active, retires not sooner than Feb 5, 2027) for dispatch/heartbeat, `claude-opus-4-7` (Active, not sooner than Apr 16, 2027) for judge. Env overrides available. | `working` — Codex model selection via `-m` flag in `codex exec`. Interactive `hive -x` uses Codex's default model (GPT-5.4). | No urgent action. Plan a `claude-opus-4-6` → `claude-opus-4-7` bump before Feb 2027. |
| **`hive init`** | `working` — Installs hook, MCP, agents, skills, identity files. | `working` — Installs MCP, AGENTS.md, hook script, hooks.json. Best-effort, silent skip if Codex absent. | Init is idempotent for both harnesses. |
| **Hook deferral** | `gap` — PreToolUse `defer` option available since v2.1.89. HIVE does not use it. | `n/a` — Codex hooks support `allow`/`deny` but no `defer` equivalent. | Hook deferral could gate dangerous dispatch actions on external approval. |
| **Plugin packaging** | `gap` — Claude Code supports `.zip` plugin archives (v2.1.128). HIVE installs via `hive init`, not as a plugin. | `gap` — Codex has plugins with bundled hooks (v0.129+). HIVE doesn't package as a Codex plugin. | Both platforms have plugin systems HIVE could use for distribution. |

---

## Legend

- **working** — Feature operates as designed; verified by doctor checks and/or test suite.
- **degraded** — Feature partially works but with known limitations or pending maintenance.
- **gap** — Platform capability exists that HIVE doesn't leverage; worth evaluating.
- **n/a** — Feature is architecturally irrelevant for this harness (e.g., dispatch is Claude-Code-only by design, not by omission).
