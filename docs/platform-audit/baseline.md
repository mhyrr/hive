# HIVE Platform Audit — Baseline

**Date:** 2026-05-11
**Audited against:** HIVE `main` at `5046c17`
**Claude Code version:** (see Section C)
**Codex version:** (see Section D)

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
| *(one via `server.tool`)* | 797 | *(additional tool registration)* |

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

*(To be completed in iteration 3-4 via web research)*

### C1. Current Released Version

*(pending — anchor all findings against this)*

### C2. Recent Changelog Highlights (last ~3 months)

*(pending)*

### C3. Notable Features

Known from HIVE memory and codebase:
- `--bare` mode (skip hooks/plugins/CLAUDE.md)
- `--brief` mode (SendUserMessage tool)
- ToolSearch deferral (MCP + built-in tool schemas deferred behind `ToolSearch`)
- Plugin/skill system (superpowers, custom skills in `~/.claude/skills/`)
- Hooks system (SessionStart, PostCompact, etc.)
- `--append-system-prompt-file` / `--system-prompt-file`
- `--agent` mode with agent template files
- `--worktree` for isolated git worktrees
- `--permission-mode bypassPermissions`
- `--print` for non-interactive output
- `--output-format stream-json`
- `--add-dir` for additional directory discovery
- `--name` for session naming
- `--model` for model selection
- `--max-turns` for turn limits

### C4. Signals About Future Changes

*(pending)*

### C5. Stack-Implication Summary

*(pending — what HIVE leverages / doesn't leverage / risks breakage on)*

---

## Section D: Codex Current State

*(To be completed in iteration 3-4 via web research)*

### D1. Current Released Version

*(pending)*

### D2. Recent Changelog Highlights

*(pending)*

### D3. `codex features list` Snapshot

Known from HIVE memory: Codex 0.128.0, `codex_hooks` stable and enabled.

### D4. Hooks, MCP, AGENTS.md Semantics

*(pending)*

### D5. Signals About Future Changes

*(pending)*

### D6. Stack-Implication Summary

*(pending)*

---

## Sidebar: Pi Harness

Pi exists in the HIVE codebase (`src/lib/pi-wire.ts`, `src/lib/harness.ts:38-39`) as an opt-in harness via `hive -3` / `hive --pi` / `HIVE_HARNESS=pi`. It routes through Pi with subscription OAuth + pi-mcp-adapter + identity extension. However, the Anthropic ToS question about using a Claude Pro/Max subscription through a third-party harness remains open. Greg is researching. Pi is available for experiments but is not the daily driver. **This audit does not cover Pi.**

---

*Sections C and D will be completed in iterations 3-4 via web research.*
