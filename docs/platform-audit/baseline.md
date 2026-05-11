# HIVE Platform Audit — Baseline

**Date:** 2026-05-11
**Audited against:** HIVE `main` at `5046c17`
**Claude Code version:** 2.1.138 (May 9, 2026)
**Codex version:** 0.128.0 (April 30, 2026) — 2 releases behind current (0.130.0)

---

## Section A: HIVE → Claude Code

Every surface where HIVE attaches to Claude Code, cited by source location.

### A1. SessionStart and PostCompact Hook Wiring

HIVE injects its identity prefix into Claude Code via a shell hook that fires on `SessionStart` and `PostCompact` events.

**Hook template (single source of truth):**
`src/lib/identity-hook-template.ts:13-31` — The `LOAD_IDENTITY_HOOK` constant contains the canonical bash script. Both `hive init` and `hive doctor` read from this constant, making drift structurally impossible.

**What the hook does:**
The script finds the `hive` binary (PATH or `~/.local/bin/hive` fallback), then runs `hive identity emit`. If hive isn't found or fails, it exits 0 — sessions are never blocked by a missing identity layer.

**Installation:**
`src/commands/init.ts:82-134` — `installIdentityHook()` writes the hook to `~/.claude/hooks/load-identity.sh` (via `writeIfMissing()`), then wires it into `~/.claude/settings.json` under both `SessionStart` and `PostCompact` events. Checks for duplicates before adding.

**Live locations:**
- Hook script: `~/.claude/hooks/load-identity.sh`
- Hook registration: `~/.claude/settings.json` (SessionStart + PostCompact entries)

### A2. MCP Server Registration

HIVE exposes 18 tools via an MCP server that Claude Code discovers at session start.

**MCP server entry point:** `src/mcp-server.ts:50-55` — `McpServer` named "hive" v2.0.0, stdio transport.

**Tools registered (18):**

| Tool | Line | Purpose |
|------|------|---------|
| `convene_council` | 58 | Multi-model deliberation (standard/analyst/dialectic) |
| `read_hive_memory` | 139 | Full project memory snapshot |
| `write_hive_memory` | 182 | Queue memory candidates for nightly verifier |
| `reflect_session` | 231 | Batch-queue session learnings |
| `search_memory` | 308 | BM25-ranked search across knowledge + logs |
| `create_ticket` | 348 | Create bug/feature/task/epic/chore |
| `list_tickets` | 388 | Filter tickets by status/type/tags |
| `show_ticket` | 423 | Full ticket detail with notes |
| `update_ticket` | 449 | Modify ticket metadata/status |
| `add_ticket_note` | 493 | Timestamped note on ticket |
| `add_project` | 521 | Register new project |
| `hive_status` | 571 | System dashboard (identity, projects, tickets, runs, agents) |
| `bootstrap_infer_conventions` | 749 | LLM scan of repo for conventions |
| `decompose_goal` | 867 | OODA-loop goal → epic + child DAG |
| `start_campaign` | 960 | Init campaign state + spawn orchestrator |
| `show_campaign` | 1063 | Campaign structure and status |
| `list_campaigns` | 1140 | List all campaigns |
| `manage_heartbeat` | 797 | Enable/disable/check project heartbeat |

**Registration in Claude Code:**
`src/commands/init.ts:263-288` — Writes to `~/.claude.json`:
```json
{
  "mcpServers": {
    "hive": {
      "command": "~/.local/bin/hive-mcp",
      "args": []
    }
  }
}
```

**Binary symlink:** `src/commands/init.ts:243-252` — Links compiled `hive-mcp` binary to `~/.local/bin/hive-mcp`.

**ToolSearch deferral:** Claude Code 2.1.x defers MCP tool schemas behind `ToolSearch`. The SessionStart hook does not pre-fetch schemas itself — the HIVE identity prefix (via `AGENTS.md` content) contains a "MCP Tools — First-Turn Pre-Fetch" instruction that tells the agent to call `ToolSearch select:mcp__hive__*` on first turn. This is a prompt-level convention, not a harness-level mechanism.

**`alwaysLoad` alternative (not yet adopted):** Since Claude Code v2.1.121, MCP server configs support `"alwaysLoad": true` which skips ToolSearch deferral for all tools in the server. Additionally, an MCP server can self-declare tools as always-loaded via `"anthropic/alwaysLoad": true` in the tool's `_meta` object. Either approach would eliminate the prompt-level pre-fetch workaround. See TK-106.

### A3. Identity Files

HIVE assembles a multi-layered identity prefix from files in `~/.hive/`.

**Assembly function:** `src/lib/identity.ts:33-77` — `buildCanonicalIdentity()` concatenates:

1. **Soul stack** (lines 37-45): `SOUL.md → IDENTITY.md → SELF.md → AGENTS.md → TRUST.md`, each separated by `\n---\n`
2. **Project memory** (lines 47-57): `_index.md` (preferred) or `knowledge.md` from `~/.hive/memory/projects/<projectId>/`. Skipped when `includeProjectMemory: false` (heartbeat mode).
3. **Stack hint** (lines 59-66): Per-project skill trigger from `buildStackHint()`. Stable per project.
4. **Taste layer** (lines 68-74): `~/.hive/taste/principles.md`. Last = loudest in interpretation ties.

**Public entry points:**
- `assembleIdentity()` (`src/lib/identity.ts:79-84`) — Full identity with project memory. Used by dispatch, campaigns, `hive identity emit`.
- `assembleHeartbeatIdentity(projectId?)` (`src/lib/identity.ts:94-99`) — Byte-stable; skips project memory for prompt cache hits.

**Identity file constants:** `src/lib/identity.ts:9` — `IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "SELF.md", "AGENTS.md", "TRUST.md"]`

**Installation:** `src/commands/init.ts:171-177` — `hive init` writes template files to `~/.hive/` with `{{userName}}` substitution. Uses `writeIfMissing()` — existing files are never overwritten.

**Per-project CLAUDE.md:** Not installed by HIVE. Project-level `CLAUDE.md` files are authored by the user. `hive doctor` (lines 325-359 in `src/commands/doctor.ts`) detects stale CLAUDE.md files that still contain the obsolete "Read and internalize ~/.hive/" identity-loading block (superseded by the hook).

### A4. Launch Modes

Claude Code can be launched in three modes that control how HIVE identity integrates with the system prompt.

**Type definition:** `src/lib/harness.ts:16` — `type ClaudeMode = "append" | "owned" | "bare"`

**Resolution logic:** `src/lib/harness.ts:24-58` — `resolveHarness()` checks env vars first (`HIVE_HARNESS`, `HIVE_CLAUDE_MODE`), then CLI flags override:

| Mode | Flag | System prompt behavior | Hooks/MCP/OAuth |
|------|------|----------------------|-----------------|
| `append` (default) | *(none)* | HIVE appended after CC default via `--append-system-prompt-file` | All active |
| `owned` | `--owned` | HIVE replaces CC default via `--system-prompt-file` | All active |
| `bare` | `--bare` | Full `--bare` — skips hooks/plugins/CLAUDE.md | Requires explicit wiring |

**Harness routing:** Also supports `-x`/`--codex` → Codex, `-3`/`--pi` → Pi, `--claude`/`--claude-code` → Claude Code (explicit).

### A5. OAuth Policy and Auth Handling

HIVE enforces subscription OAuth for all spawned Claude Code processes.

**Dispatch:** `src/commands/dispatch.ts:56` (in wrapper script) — `unset ANTHROPIC_API_KEY`. Also at the spawn point: `src/commands/dispatch.ts:304` — `env: { ...process.env, ANTHROPIC_API_KEY: undefined }`.

**Heartbeat:** `src/lib/heartbeat.ts:299` — `env: { ...process.env, ANTHROPIC_API_KEY: undefined }`.

**Campaign executor:** `src/lib/campaign/run-detached.ts:58` + `src/lib/campaign/executor.ts` — Identity assembled at line 57; API key unset via inherited spawn env.

**Claude subprocess driver:** `src/lib/claude.ts:58` — `env: { ...process.env, ANTHROPIC_API_KEY: undefined }`. Comment at lines 56-57: "Force OAuth/subscription path. ANTHROPIC_API_KEY would route through the paid API and bypass the harness entirely."

**Policy:** If subscription OAuth fails, the run fails. No silent fallback to API key auth. On macOS, the OAuth token lives in Keychain (`Claude Code-credentials` in `login.keychain-db`). Detached subprocesses without a GUI session can hit Keychain access errors surfaced as `ConnectionRefused`.

### A6. Model Pins

| Component | Default Model | Env Override | Source |
|-----------|--------------|-------------|--------|
| Dispatch | `claude-opus-4-6` | `HIVE_DISPATCH_MODEL` | `src/commands/dispatch.ts:191` |
| Heartbeat | `claude-opus-4-6` | `HIVE_HEARTBEAT_MODEL` | `src/lib/heartbeat.ts:284` |
| Campaign executor | `claude-opus-4-6` | *(via rawOpts.model)* | `src/lib/campaign/run-detached.ts:58` |
| Campaign judge | `claude-opus-4-7` | *(via JudgeOpts.modelId)* | `src/lib/campaign/judge.ts:52` |

**Rationale:** Opus 4.6 is used for autonomous work (dispatch, heartbeat, campaign execution) because 4.7's more literal instruction-following and fewer-subagents bias hurts judgment-heavy autonomous tasks. The judge uses 4.7 for its more disciplined, literal evaluation style.

### A7. Agent Templates and Skills

**Agent templates:** Installed to `~/.claude/agents/` by `hive init` (`src/commands/init.ts:180-185`).

| Template | Description | maxTurns | permissionMode | Model |
|----------|-------------|----------|----------------|-------|
| `maya-coder.md` | Implementation agent; feature work, bug fixes, refactoring | 50 | *(default)* | *(default)* |
| `maya-executor.md` | Autonomous goal executor; plans, builds, checks, iterates | 100 | bypassPermissions | *(default)* |
| `maya-heartbeat.md` | Periodic heartbeat; checks standing orders | 15 | bypassPermissions | *(default)* |
| `maya-planner.md` | Architecture and planning; breaks work into tickets | 30 | *(default)* | opus |
| `maya-reviewer.md` | Code review against project conventions | 20 | *(default)* | sonnet |

**Skills:** Installed to `~/.claude/skills/` by `hive init` (`src/commands/init.ts:182-189`).
- `hive-status/SKILL.md` — User-invocable skill that calls `mcp__hive__hive_status`.

### A8. Dispatch Wiring

The dispatch command spawns Claude Code as a detached background process.

**Wrapper generation:** `src/commands/dispatch.ts:38-161` — `buildRunWrapper()` generates a bash script (`run.sh`) that:
1. Unsets `ANTHROPIC_API_KEY` (line 56)
2. Launches Claude with `--model`, `--append-system-prompt-file`, `--add-dir ~/.hive`, `--agent maya-executor`, `--permission-mode bypassPermissions`, `--worktree`, `--name <runId>` (lines 64-73)
3. Runs a portable watchdog for timeout (background sleep + kill, lines 76-91) — avoids GNU `timeout` which isn't on macOS
4. Determines status from evidence of work, not exit code (line 99+)

**Spawn:** `src/commands/dispatch.ts:300-305` — `spawn("/bin/bash", [wrapperPath])` with `detached: true`, `stdio: "ignore"`.

**Goal/message passing:** `src/commands/dispatch.ts:271-277` — Goal written to `message.txt` and sourced via `$(cat)` in the wrapper to avoid shell expansion issues (TK-039).

**Run state:** `~/.hive/runs/RUN-NNN/` with `goal.md`, `status`, `identity.md`, `message.txt`, `output.log`, `plan.md`, `pid`.

### A9. Heartbeat Wiring

**Trigger:** launchd plist fires every 30 minutes. Deterministic gate (`src/lib/heartbeat-trigger.ts`) checks for signals before invoking the LLM.

**Claude invocation:** `src/lib/heartbeat.ts:297-300` — `Bun.spawnSync([claude, ...args])` with:
- `--model claude-opus-4-6` (line 284)
- `--append-system-prompt-file <identityPath>` (line 288)
- `--agent maya-heartbeat` (line 289)
- `--add-dir ~/.hive` (line 290)
- `--permission-mode bypassPermissions` (line 291)
- `--max-turns 20` (line 292)
- `--print` (line 293)

**Identity caching:** `src/lib/heartbeat.ts:246-268` — Heartbeat identity written to `${tmpdir()}/hive-heartbeat-${projectId}.md` with byte-stability across ticks. Mutable context goes in `.tick-brief.md`. This split maximizes prompt cache hits.

### A10. Campaign Wiring

**Orchestrator:** `src/lib/campaign/orchestrator.ts` — Main iteration loop: executor → judge → decision → apply → scorecard.

**Executor spawn:** `src/lib/campaign/run-detached.ts:68-83` — `runIteration()` with soft caps (50K tokens / 25min default, 1.5x hard multiplier).

**Judge:** `src/lib/campaign/judge.ts:52` — Uses `claude-opus-4-7` with a frozen prefix (byte-stable across iterations for cache hits). System prompt built from `src/lib/campaign/frozen-prefix.ts`.

**Campaign spawn:** `src/mcp-server.ts:1032-1044` — `start_campaign` MCP tool spawns `bun run src/lib/campaign/run-detached.ts` detached, with `ANTHROPIC_API_KEY: undefined`.

**Default limits:** `src/lib/campaign/orchestrator.ts:44-48` — 12 iterations, $40 max cost, 8h max walltime.

### A11. `hive doctor` Checks (Claude Code)

`src/commands/doctor.ts` runs these Claude Code checks:

| Check | Lines | What it verifies |
|-------|-------|------------------|
| Hook exists | ~223 | `~/.claude/hooks/load-identity.sh` exists and is executable |
| Hook drift | ~241-254 | Live hook byte-matches `LOAD_IDENTITY_HOOK` constant |
| Hook wiring | ~266-300 | Hook registered in `~/.claude/settings.json` SessionStart + PostCompact |
| Claude Code version | ~302-320 | Version ≥ 2.1.x (hook event set stabilized) |
| Stale CLAUDE.md | ~325-359 | Per-project CLAUDE.md doesn't contain obsolete identity blocks |
| MCP registered | ~393-405 | `hive` in `~/.claude.json` mcpServers |
| MCP command valid | ~410-425 | Registered MCP command is resolvable on disk |
| Scheduler plists | ~468-495 | launchd plists for heartbeat/nightly/sync/dashboard exist and are loaded |

---

## Section B: HIVE → Codex

Every surface where HIVE attaches to Codex CLI, cited by source location.

### B1. Core Wiring Module

`src/lib/codex-wire.ts` is the single module for all Codex integration.

| Function | Lines | Purpose |
|----------|-------|---------|
| `getCodexHome()` | 23-25 | Returns `~/.codex` |
| `isCodexInstalled()` | 27-35 | Checks `which codex` or `~/.local/bin/codex` |
| `findCodexBin()` | 37-47 | Resolves binary; checks `HIVE_CODEX_BIN` env first |
| `getRegisteredCodexHiveMcp()` | 60-79 | Reads `~/.codex/config.toml`, minimal TOML parser for `[mcp_servers.hive]` |
| `registerCodexHiveMcp()` | 86-98 | Calls `codex mcp add hive -- <path>` |
| `writeCodexAgentsMd()` | 109-125 | Writes `~/.codex/AGENTS.md` with byte-equivalence check |
| `getCodexAgentsMdStatus()` | 127-143 | Checks AGENTS.md exists/empty/current |
| `installCodexIdentityHook()` | 178-230 | Installs SessionStart hook script + wires hooks.json |
| `wireCodex()` | 245-275 | Top-level orchestrator: MCP + AGENTS.md + hook |

### B2. `~/.codex/AGENTS.md` Sync

`src/lib/codex-wire.ts:109-125` — `writeCodexAgentsMd()` writes `~/.codex/AGENTS.md` from `assembleIdentity()` output. **Byte-equivalence check:** skips write if content is identical to existing file, preserving Codex's prefix cache across sessions.

### B3. MCP Registration

`src/lib/codex-wire.ts:86-98` — `registerCodexHiveMcp()` calls `codex mcp add hive -- <mcpBinPath>` to write `[mcp_servers.hive]` in `~/.codex/config.toml`.

**TOML parsing:** `src/lib/codex-wire.ts:60-79` — Minimal hand-rolled parser extracts the `command` value from the `[mcp_servers.hive]` table. No external TOML dependency.

### B4. SessionStart Hook

**Hook template:** `src/lib/codex-wire.ts:149-176` — `CODEX_HOOK_SCRIPT` constant, a bash script that:
1. Finds `hive` binary (PATH or `~/.local/bin/hive`)
2. Runs `hive identity emit` to temp file
3. Compares with `~/.codex/AGENTS.md` via `cmp -s`
4. Moves only if different (preserves cache)
5. Exits 0 always (non-blocking)

**Installation:** `src/lib/codex-wire.ts:178-230` — `installCodexIdentityHook()`:
- Writes script to `~/.hive/codex-load-identity.sh`
- Wires it in `~/.codex/hooks.json` under `SessionStart` event with 5s timeout
- Idempotent: checks if already wired before adding

### B5. `hive -x` Launch Path

**Harness routing:** `src/lib/harness.ts:34` — `-x` or `--codex` sets `harness = "codex"`.

**Launch function:** `src/cli.ts:242-265` — `launchCodex()`:
1. Assembles current identity (line 248)
2. Refreshes `~/.codex/AGENTS.md` before spawn (lines 249-252)
3. Spawns Codex with `Bun.spawnSync()` (line 254)
4. Scrubs `OPENAI_API_KEY` from env (line 260) to force subscription auth

**Binary resolution:** `src/cli.ts:106-115` — Checks `HIVE_CODEX_BIN` env, `which codex`, `~/.local/bin/codex`.

### B6. Codex Subprocess Driver

`src/lib/codex.ts` — Used by council for Codex-as-a-model (not for interactive sessions).

| Function | Lines | Purpose |
|----------|-------|---------|
| `resolveCodexBin()` | 45-50 | Resolve binary path |
| `spawnCodex()` | 62-98 | Spawn subprocess, scrub `OPENAI_API_KEY` |
| `parseCodexJsonl()` | 104-134 | Parse JSONL output from `--json` mode |
| `completeCodexText()` | 140-196 | `codex exec --json -s read-only --skip-git-repo-check --ephemeral` |

### B7. `hive init` for Codex

`src/commands/init.ts:290-316` — Best-effort, silent skip if Codex not installed:
1. Calls `wireCodex({ identity, mcpBinPath })` (line 295)
2. Reports what was installed (MCP, AGENTS.md, hook script, hook wiring)

**What gets installed:**
- `~/.codex/config.toml` — `[mcp_servers.hive]` table
- `~/.codex/AGENTS.md` — HIVE identity prefix
- `~/.codex/hooks.json` — SessionStart event wiring
- `~/.hive/codex-load-identity.sh` — Hook shell script

### B8. `hive doctor` Codex Checks

`src/commands/doctor.ts:121-188` — `checkCodex()`:

| Check | What it verifies |
|-------|------------------|
| Codex installed | `isCodexInstalled()` — optional, skips if absent |
| MCP registration | `getRegisteredCodexHiveMcp()` — command exists and resolvable |
| AGENTS.md freshness | `getCodexAgentsMdStatus()` — exists, non-empty, byte-current vs identity |
| Hook script | `~/.hive/codex-load-identity.sh` exists |
| Hook wired | `~/.codex/hooks.json` has SessionStart entry for hook script |

### B9. `codex_hooks` Feature Flag

Per HIVE memory: Codex CLI 0.128.0 reports `codex_hooks` as a stable enabled feature. HIVE does not need a separate config flag to enable hooks.

### B10. Environment Variables (Codex)

| Env Var | Where Checked | Purpose |
|---------|---------------|---------|
| `HIVE_CODEX_BIN` | `codex-wire.ts:28,38`, `codex.ts:46`, `cli.ts:107` | Override Codex binary path |
| `HIVE_HARNESS=codex` | `harness.ts:28` | Set Codex as default harness |
| `OPENAI_API_KEY` | `codex.ts:71`, `cli.ts:260` | Scrubbed to force subscription |

---

## Section C: Claude Code Current State

*Research conducted 2026-05-11 via web search, local version check, and changelog review.*

### C1. Current Released Version

**Claude Code 2.1.138** (May 9, 2026) — verified locally via `claude --version`.

This is the current stable release. Internal fixes only in this version; the substantive platform changes landed in v2.1.89–v2.1.136 over the preceding 6 weeks.

### C2. Recent Changelog Highlights (March–May 2026)

| Version | Date | Changes |
|---------|------|---------|
| **2.1.138** | May 9 | Internal fixes |
| **2.1.136** | May 8 | Fixed MCP servers/plugins/connectors disappearing after `/clear`; fixed MCP OAuth refresh-token race; fixed extended-thinking redacted blocks; fixed `--resume`/`--continue` with underscore paths; fixed plan mode not blocking writes matching `Edit(...)` rules |
| **2.1.133** | May 7 | Added `worktree.baseRef` setting (`fresh` \| `head`); hooks now receive effort level via `effort.level` / `$CLAUDE_EFFORT`; added `sandbox.bwrapPath`/`sandbox.socatPath`; fixed 401 race in parallel sessions |
| **2.1.128** | ~May 1 | Plugins can load from `.zip` archives; `claude plugin prune` for orphaned deps |
| **2.1.126** | May 1 | `/model` picker lists from gateway `/v1/models`; `claude project purge [path]`; security fix for `allowManagedDomainsOnly` bypass; image paste auto-downscaling |
| **2.1.91** | ~Apr 15 | MCP tool result size limit raised to **500,000 characters** per tool (was lower); per-tool override via `anthropic/maxResultSizeChars` |
| **2.1.89** | ~Apr 13 | PreToolUse hook gains `defer` decision (pause execution, wait for external signal) in addition to `allow`/`deny`; PostToolUse hooks can replace tool output for all tools via `hookSpecificOutput.updatedToolOutput` |
| **2.1.69** | ~Mar | ToolSearch deferral extended to built-in system tools — reduces system-tool context from ~14–16K tokens to ~968 tokens, but deferred descriptors add ~20K tokens |

**Quality incidents and reversals (Anthropic April 23 postmortem):**

| What | When introduced | When fixed | Impact |
|------|----------------|------------|--------|
| Reasoning effort default changed from `high` to `medium` | Mar 4 | Apr 7 | Intelligence drop on complex tasks; now defaults to `xhigh` for Opus 4.7, `high` for others |
| Caching logic bug — kept clearing thinking history every turn | Mar 26 | Apr 10 | Thinking quality degradation in long sessions |
| System prompt verbosity reduction | Apr 16 | Apr 20 | Hurt coding quality; fully reverted |

Sources: [GitHub Releases](https://github.com/anthropics/claude-code/releases), [Anthropic April 23 Postmortem](https://www.anthropic.com/engineering/april-23-postmortem), [claudefa.st changelog](https://claudefa.st/blog/guide/changelog)

### C3. Notable Features

**Features HIVE currently leverages:**

| Feature | How HIVE uses it |
|---------|-----------------|
| `--append-system-prompt-file` | Default launch mode — identity appended to Claude's base prompt (`src/lib/harness.ts`) |
| `--system-prompt-file` | `--owned` launch mode — identity replaces base prompt |
| `--bare` | Minimal mode — no hooks/skills/MCP/CLAUDE.md |
| `--agent <template>` | Dispatch, heartbeat, campaign use maya-* agent templates |
| `--worktree` | Dispatch creates isolated worktrees for agent execution |
| `--print` | Heartbeat and campaign use non-interactive output |
| `--output-format stream-json` | Campaign executor parses streaming JSON for status |
| `--permission-mode bypassPermissions` | Dispatch grants full tool access to agents |
| `--max-turns` | Heartbeat limits agent turns |
| `--model` | Model pinning for dispatch/heartbeat/campaign |
| `--name` | Session naming for dispatch runs |
| `--add-dir` | Campaign executor adds `~/.hive` as additional directory |
| SessionStart/PostCompact hooks | Identity injection via `load-identity.sh` |
| MCP server registration | 18 HIVE tools via `hive-mcp` binary |
| Plugin/skill system | `hive-status` skill, superpowers integration |
| ToolSearch deferral | Prompt-level pre-fetch instruction in identity prefix |

**Features HIVE does NOT currently leverage:**

| Feature | Potential use |
|---------|-------------|
| `--brief` / `SendUserMessage` tool | Could be used for tighter dispatch output control |
| PreToolUse hook `defer` (v2.1.89) | Could gate dangerous tool calls on external approval |
| `$CLAUDE_EFFORT` in hooks (v2.1.133) | Could adjust identity injection weight by effort level |
| `worktree.baseRef` setting (v2.1.133) | Could configure whether dispatch worktrees fork from `fresh` or `head` |
| MCP `alwaysLoad` option | Could skip ToolSearch deferral for HIVE MCP tools — eliminating the prompt-level pre-fetch workaround |
| `claude project purge` (v2.1.126) | Could be used in cleanup flows |
| Plugin `.zip` archive support (v2.1.128) | Could package HIVE as a distributable plugin |
| MCP tool result 500K limit (v2.1.91) | HIVE tools already return small payloads; no immediate need |

### C4. Signals About Future Changes

**Model deprecations:**
- **Claude Opus 4 (`claude-opus-4-20250514`) and Claude Sonnet 4 (`claude-sonnet-4-20250514`) retire June 15, 2026.** These are the original Opus 4 and Sonnet 4 models. HIVE pins dispatch/heartbeat to `claude-opus-4-6` — a newer model that is **Active** with retirement "not sooner than February 5, 2027" per Anthropic's [deprecation page](https://platform.claude.com/docs/en/about-claude/model-deprecations). **No HIVE model pins need updating for the June 15 deadline.** The campaign judge pin (`claude-opus-4-7`) is Active until at least April 16, 2027.

**Rate limit changes (May 2026):**
- Doubled five-hour rate limits for Pro/Max/Team/Enterprise plans. Removed peak-hours reduction for Pro and Max. This is net positive for HIVE dispatch throughput.

**Platform direction signals:**
- ToolSearch deferral is expanding (system tools already deferred as of v2.1.69). An `alwaysLoad` config option (v2.1.121+) exists to opt specific MCP servers out of deferral — both at the server level (`"alwaysLoad": true` in config) and per-tool (`"anthropic/alwaysLoad": true` in tool `_meta`). HIVE should consider using it.
- Plugin system is maturing (archive support, prune command, hook bundling). HIVE could eventually ship as a plugin rather than a standalone MCP + hooks install.
- Hook system gaining richer semantics (defer, effort level, output replacement). The trajectory suggests hooks will become the primary extension surface.
- SSE transport for MCP deprecated in favor of HTTP.

**Known platform issues:**
- ToolSearch does not properly defer HTTP/Streamable HTTP MCP tools — ~120K tokens loaded upfront ([GitHub #40314](https://github.com/anthropics/claude-code/issues/40314)). HIVE uses stdio transport, so not affected today.
- MCP servers/plugins disappearing after `/clear` was fixed in v2.1.136 but indicates fragility in session state management.

Sources: [Anthropic model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations), [GitHub Issues](https://github.com/anthropics/claude-code/issues)

### C5. Stack-Implication Summary

| Category | Finding |
|----------|---------|
| **Leveraged well** | Hook system (SessionStart/PostCompact), MCP server registration, agent templates, worktree isolation, `--print`/`--output-format stream-json` for autonomous work, model pinning |
| **Underleveraged** | `alwaysLoad` for MCP deferral bypass (server-level or per-tool `_meta`, v2.1.121+); `worktree.baseRef` for dispatch isolation control; hook `defer` for gated tool access; plugin archive packaging |
| **Breakage risk** | ToolSearch deferral expansion could add friction if new tools get deferred unexpectedly; SSE transport deprecation (HIVE uses stdio, not affected) |
| **Low-urgency watch** | Model pin `claude-opus-4-6` is Active until at least Feb 5, 2027 — no action needed for June 15 deadline (that retires original Opus 4 `claude-opus-4-20250514`, not 4.6). Plan a pin bump to Opus 4.7 before Feb 2027. |
| **Monitoring** | MCP session stability (the `/clear` bug and OAuth race suggest fragility); reasoning effort default changes (Anthropic has reversed these before — HIVE dispatch quality depends on them staying at `high`/`xhigh`) |

---

## Section D: Codex Current State

*Research conducted 2026-05-11 via web search, local version check, and `codex features list`.*

### D1. Current Released Version

**Codex CLI 0.128.0** (April 30, 2026) — verified locally via `codex --version`.

Newer versions exist: **v0.129.0** (May 7) and **v0.130.0** (May 8). HIVE's installed version is 2 releases behind. The gap contains a deprecation that directly affects HIVE's hook wiring.

### D2. Recent Changelog Highlights (March–May 2026)

| Version | Date | Key Changes |
|---------|------|-------------|
| **0.130.0** | May 8 | `codex remote-control` CLI command (headless app-server entrypoint); multi-environment `view_image`; Bedrock AWS auth via console-login; app-server thread pagination; live config refresh for running threads |
| **0.129.0** | May 7 | Vim editing support; enhanced plugin management; sandbox reliability; **`codex_hooks` deprecated in favor of `hooks`** (feature flag rename); `on-failure` approval mode deprecated |
| **0.128.0** | Apr 30 | Persisted `/goal` workflows; configurable TUI keymaps; plan-mode nudges; action-required terminal titles; permission profile expansion; **`--full-auto` deprecated** in favor of explicit permission profiles |

**Earlier notable changes (March–April 2026):**
- Context compaction rewrite fixing "summaries of summaries" bug (recursive degradation in long sessions)
- Rust rewrite now 95.7% of codebase; deterministic allocator eliminates GC pauses
- Dynamic model routing — mid-session model switching supported
- Cross-surface session sync (CLI ↔ Desktop)
- GPT-5.4 default (Mar 5), GPT-5.4-mini released (Mar 17), GPT-5.5 released (Apr 23)

Sources: [Codex Changelog](https://developers.openai.com/codex/changelog), [GitHub Releases](https://github.com/openai/codex/releases)

### D3. `codex features list` Snapshot

Captured from installed v0.128.0 on 2026-05-11.

**Stable + enabled features (relevant to HIVE):**

| Feature | Status |
|---------|--------|
| `codex_hooks` | stable, enabled — **deprecated in v0.129; migrate to `hooks`** |
| `tool_search` | stable, enabled |
| `multi_agent` | stable, enabled |
| `plugins` | stable, enabled |
| `shell_tool` | stable, enabled |
| `shell_snapshot` | stable, enabled |
| `unified_exec` | stable, enabled |
| `fast_mode` | stable, enabled |
| `computer_use` | stable, enabled |
| `browser_use` | stable, enabled |
| `image_generation` | stable, enabled |
| `guardian_approval` | stable, enabled |
| `skill_mcp_dependency_install` | stable, enabled |
| `tool_call_mcp_elicitation` | stable, enabled |
| `workspace_dependencies` | stable, enabled |

**Under development (watch list):**

| Feature | Notes |
|---------|-------|
| `multi_agent_v2` | Next-gen multi-agent with explicit configuration |
| `child_agents_md` | Per-child-agent AGENTS.md — could affect HIVE identity injection |
| `enable_fanout` | Parallel task fan-out |
| `goals` | Persisted goal workflows (shipped in v0.128 TUI, flag still dev) |
| `plugin_hooks` | Plugin-bundled hooks |
| `realtime_conversation` | Voice/realtime session model |
| `remote_control` | Headless app-server (shipped in v0.130) |
| `memories` | Codex-native memory system (experimental) |

### D4. Hooks, MCP, AGENTS.md Semantics

**Hooks:**
- HIVE wires Codex hooks via `~/.codex/hooks.json` with a `SessionStart` entry pointing to `~/.hive/codex-load-identity.sh`.
- **Deprecation alert:** v0.129 renames `[features].codex_hooks` to `[features].hooks`. HIVE's `hive doctor` checks the `codex_hooks` feature flag (`src/commands/doctor.ts`). After upgrading to v0.129+, the doctor check will need updating.
- Hook coverage gaps exist: PreToolUse hooks unreliable for `apply_patch`; MCP-dispatched calls have intermittent coverage.
- Plugins can now bundle hooks directly (v0.129+).

**MCP:**
- HIVE registers via `codex mcp add hive -- ~/.local/bin/hive-mcp` (wired in `src/lib/codex-wire.ts`).
- v0.130 promotes built-in MCPs to first-class runtime servers (auto-launch on session start).
- MCP configuration lives in `~/.codex/config.toml` under `[mcp_servers.hive]`.
- Both STDIO and HTTP streaming transports supported. HIVE uses STDIO.

**AGENTS.md:**
- Concatenation semantics: AGENTS.md files are concatenated up the directory tree, not overridden. `AGENTS.override.md` replaces at its level.
- HIVE writes `~/.codex/AGENTS.md` from `assembleIdentity()` output. The SessionStart hook refreshes it via `hive identity emit`.
- v0.128+ exposes AGENTS.md content through the app-server JSON-RPC API — external clients can query resolved instructions without filesystem access.
- Loading happens once at session start; no mid-session refresh of AGENTS.md content.

**Session model:**
- Context compaction fires before new user messages if token threshold exceeded.
- Rust rewrite eliminated the recursive "summaries of summaries" compaction bug.
- Dynamic model routing supports mid-session model switching (explore → plan → execute → review).
- `codex exec --json` now reports reasoning-token usage for programmatic consumers.

Sources: [Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md), [Codex MCP docs](https://developers.openai.com/codex/mcp), [Codex hooks reference](https://agenticcontrolplane.com/blog/codex-cli-hooks-reference)

### D5. Signals About Future Changes

**Deprecations requiring HIVE action:**
- **`codex_hooks` → `hooks`** (v0.129): HIVE doctor's Codex feature-flag check references `codex_hooks`. Needs update after Codex upgrade.
- **`--full-auto` deprecated** (v0.128): HIVE doesn't use this flag, but any scripts referencing it should migrate to explicit permission profiles.

**Emerging capabilities:**
- **`child_agents_md`** (under development): Per-child-agent AGENTS.md would let HIVE inject different identity into Codex subagents. Currently AGENTS.md is session-global.
- **`memories`** (experimental): Codex-native memory system. If this stabilizes, HIVE's memory layer could either integrate with or compete against it. Worth monitoring.
- **`multi_agent_v2`**: Enhanced subagent spawning with explicit config. Currently has a limitation where `spawn_agent` doesn't respect `agent_type`/`model` overrides ([GitHub #20077](https://github.com/openai/codex/issues/20077)).
- **`remote_control`** (v0.130): Headless app-server entrypoint. Could enable HIVE dispatch via Codex (currently Claude-Code-only).
- **Plugin hooks** (under development): Plugins bundling their own hooks. HIVE could distribute Codex integration as a plugin instead of a `hive init` install step.

**Platform direction:**
- Codex is converging on five customization layers: AGENTS.md + Skills + MCP + Subagents + Plugins. HIVE currently uses three (AGENTS.md, MCP, hooks via init). Skills and plugins are unexplored.
- Rust rewrite is nearly complete — expect performance and reliability improvements but also potential behavioral changes in edge cases.
- Cross-surface session sync means Codex sessions started via `hive -x` (CLI) could be picked up in Desktop or VS Code. HIVE doesn't account for this.

### D6. Stack-Implication Summary

| Category | Finding |
|----------|---------|
| **Leveraged well** | AGENTS.md identity injection (with byte-equivalence caching), MCP server registration, SessionStart hook refresh, `codex exec --json` for council |
| **Underleveraged** | Plugin system (could package HIVE Codex integration as a distributable plugin); `remote_control` for potential Codex-based dispatch; `child_agents_md` for per-agent identity |
| **Breakage risk** | **`codex_hooks` feature flag deprecated in v0.129** — HIVE doctor checks this flag specifically; HIVE is 2 versions behind (0.128 installed, 0.130 current); if `memories` feature stabilizes, potential conflict with HIVE memory layer |
| **Monitoring** | `multi_agent_v2` evolution (could enable Codex dispatch path); `plugin_hooks` (could replace init-based hook wiring); AGENTS.md API exposure (could change how identity is discovered) |

---

## Sidebar: Pi Harness

Pi exists in the HIVE codebase (`src/lib/pi-wire.ts`, `src/lib/harness.ts:38-39`) as an opt-in harness via `hive -3` / `hive --pi` / `HIVE_HARNESS=pi`. It routes through Pi with subscription OAuth + pi-mcp-adapter + identity extension. However, the Anthropic ToS question about using a Claude Pro/Max subscription through a third-party harness remains open. Greg is researching. Pi is available for experiments but is not the daily driver. **This audit does not cover Pi.**
