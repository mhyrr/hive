# Cursor CLI Harness (`hive -a`) — Design

**Status:** Design. Not yet built.
**Date:** 2026-08-12
**Author:** Maya (with Greg)
**Aiming docs:** `docs/hive-reach.md`, `docs/identity-injection.md`

---

## 0. What this is

Add Cursor CLI (`agent`) as a fourth interactive harness, next to Claude
Code (`hive`), Pi (`hive -3`), and Codex (`hive -x`). The user-facing
shape is `hive -a` / `hive --cursor`.

The three-question reach test from `hive-reach.md` still governs:

1. **Identity** — canonical prefix (soul + persona + project memory +
   stack hint + taste) loads at launch.
2. **MCP tools** — `hive_*` tools reach the runtime.
3. **Project scope** — active project resolves from `$PWD`.

True parity is not the goal. Reach is. Dispatch, heartbeat, and nightly
transcript ingestion stay Claude-Code-only, same as Pi and Codex.

---

## 1. Why Cursor is a wrap, not a science project

Cursor CLI is closer to **Codex** than to Claude Code: files + MCP
config, no `--system-prompt` / `--append-system-prompt`. It has one extra
launch hook Claude and Codex lack: `--plugin-dir`.

| Claude / Codex surface | Cursor CLI equivalent |
|---|---|
| `--append-system-prompt` / `--system-prompt` | **does not exist** |
| Codex `~/.codex/AGENTS.md` (user-level) | **does not exist** |
| Claude `SessionStart` (blocking) | `sessionStart` → `additional_context` (**fire-and-forget**) |
| Claude `alwaysLoad: true` | **not a Cursor field** |
| Pi `pi -e <extension>` (spawn-time prompt prepend) | `--plugin-dir` with `alwaysApply: true` rule |
| `~/.claude.json` / `~/.codex/config.toml` MCP | `~/.cursor/mcp.json` (user-scope auto-approves) |

The fire-and-forget `sessionStart` hook is too racy for
`hive -a "fix auth"` — the first turn can leave before identity lands.
`--plugin-dir` is the spawn-time analog of Pi's `-e` and is the v1
identity path.

Cursor CLI already loads `~/.claude/skills/`. Codex needed a
"read the file" stack-hint variant (TK-114) because it has no Skill
tool. Cursor does, so the Claude wording is correct.

Auth is a Cursor account (`agent login` / `CURSOR_API_KEY`), not
Anthropic. The `unset ANTHROPIC_API_KEY` OAuth trick is irrelevant here.

---

## 2. Flags and routing

**Short:** `-a`
**Long:** `--cursor`
**Env:** `HIVE_HARNESS=cursor`
**Override:** `--claude` / `--claude-code` still wins, last flag wins.

**Do not use `--agent` as a harness alias.** `hive --agent maya-coder`
is already a Claude Code passthrough (`src/cli.ts` usage). Stealing it
breaks that. A regression test must pin `--agent maya-coder` remaining
in `remainingArgs`.

`HIVE_CURSOR_BIN` overrides binary discovery, matching `HIVE_CODEX_BIN`
/ `HIVE_PI_BIN`.

`--owned` / `--bare` are Claude-only. `hive -a --owned` prints the same
warning Codex/Pi already print and ignores the flag.

Existing `launchAgent` in `src/cli.ts` is the harness dispatcher. Do not
rename it. The new function is `launchCursor`.

---

## 3. Injection design

```
hive -a
  → resolveHarness
  → launchCursor
  → assembleIdentity({ includePersona, persona })
  → temp plugin-dir (rules/hive-identity.mdc)
  → agent --trust --plugin-dir <tmpdir> --add-dir ~/.hive [...args]

hive init
  → ~/.cursor/mcp.json  { hive: { command: hive-mcp } }
        ↳ Desktop + CLI both see HIVE tools
```

| Cargo | How |
|---|---|
| Identity | Per-launch temp plugin: `rules/hive-identity.mdc` with `alwaysApply: true`, body = `assembleIdentity({ includePersona: true, persona })`. Passed as `agent --plugin-dir <tmpdir>`. Cleaned on exit like Pi's `-e` tempfile. |
| MCP | `hive init` merges `hive` into `~/.cursor/mcp.json` (`command: ~/.local/bin/hive-mcp`). Idempotent; never overwrite an existing `hive` entry. |
| Project scope | Free — `assembleIdentity` already resolves from `$PWD`. |
| Soul files on disk | `--add-dir ~/.hive` (same as Claude). |
| Trust dialog | `--trust` so the TUI doesn't stall. Not `--force` / `--yolo`. |

### Plugin shape

Identity-only. Do **not** also put MCP in the plugin or `hive`
double-registers.

```
<tmpdir>/
  .cursor-plugin/plugin.json    { "name": "hive-identity" }
  rules/hive-identity.mdc       alwaysApply: true
```

`.mdc` frontmatter:

```yaml
---
alwaysApply: true
---
<canonical identity prefix>
```

### Why not a user-level `sessionStart` hook in v1

Writing `~/.cursor/hooks.json` would fire in Cursor **Desktop** as well
as CLI. That dumps the ~30KB identity prefix into every Cmd+I chat.
Identity is `hive -a` only in v1, same as Pi (no hook for bare `pi`).

MCP in `~/.cursor/mcp.json` **does** leak into Desktop. That is
intentional: tools on demand, no prefix bloat.

A hook for bare `agent` (no `hive` wrapper) is v2.

### Why not project `.cursor/mcp.json`

Project-scope MCP prompts for approval and mutates repos. User-scope
auto-approves. Init writes user-scope only.

---

## 4. Code changes

### New module: `src/lib/cursor-wire.ts`

Copy the Pi/Codex split.

- `isCursorInstalled` / `findCursorBin` — `HIVE_CURSOR_BIN`, `which agent`, `~/.local/bin/agent`
- `getCursorMcpPath` → `~/.cursor/mcp.json`
- `registerCursorHiveMcp(mcpBinPath)` — merge, don't clobber
- `writeCursorIdentityPlugin(identity)` → `{ dir, path }` tempfile, same lifecycle as `writePiIdentityExtensionTempFile`
- `wireCursor({ mcpBinPath })` — init entry; skip silently if `agent` is missing

### Routing: `src/lib/harness.ts`

- `Harness` += `"cursor"`
- Strip `-a` / `--cursor`; honor `HIVE_HARNESS=cursor`

### Launch: `src/cli.ts`

```
Bun.spawnSync([
  agent,
  "--trust",
  "--plugin-dir", plugin.dir,
  "--add-dir", join(HOME, ".hive"),
  ...args,
])
```

Cleanup the temp plugin dir on exit / SIGINT / SIGTERM, matching Pi.

### Init / doctor / identity

- `src/commands/init.ts` — `wireCursor` after `wirePi`, same best-effort try/catch
- `src/commands/doctor.ts` — optional Cursor group: binary present, `~/.cursor/mcp.json` hive entry, command path exists. Missing `agent` is a skip (pass), not a fail — same as Codex/Pi.
- `src/commands/identity.ts` + `src/lib/stack.ts` — add `"cursor"` to the identity `Harness` type. `buildStackHint` falls through to the Claude wording (Skill tool exists). `hive identity emit --harness cursor` is valid even if v1 launch does not need a hook to call it.

### Drive-by: Codex launch bug

`launchCodex` in `src/cli.ts` currently calls `assembleIdentity` **without**
`harness: "codex"`. Init, doctor, and the Codex SessionStart hook all pass
it. First `hive -x` session can load Claude-style Skill-tool wording;
doctor then reports AGENTS.md stale. Pass `harness: "codex"` while here.

---

## 5. Tests

- `src/__tests__/harness.test.ts` — `-a`, `--cursor`, `HIVE_HARNESS=cursor`, `--claude` override, `--agent maya-coder` still in `remainingArgs`
- `src/__tests__/cursor-wire.test.ts` — MCP merge/idempotency, plugin dir contents (plugin.json + alwaysApply mdc + identity body), skip when agent missing. Mirror `pi-wire.test.ts`.
- `src/__tests__/stack.test.ts` — cursor hint === claude hint for elixir/typescript

---

## 6. Docs (lockstep — CLAUDE.md / README are the product)

- `docs/hive-reach.md` — fourth column
- `docs/identity-injection.md` — consumer row for `hive -a`
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `getUsage()` in `src/cli.ts`

---

## 7. Reach matrix (v1 target)

| | Cursor CLI (`hive -a`) |
|---|---|
| **Identity** | ✓ Per-launch `--plugin-dir` with `alwaysApply` rule |
| **MCP tools** | ✓ Native via `~/.cursor/mcp.json` (user-scope) |
| **Project scope** | ✓ Same `$PWD` resolution as other harnesses |
| **Council** | ✓ via MCP |
| **Doctor coverage** | ✓ optional Cursor group |
| **Nightly transcript ingestion** | n/a (v1) |
| **Bare `agent` (no hive wrapper)** | n/a (v1) — MCP may still load from user config |
| **Cursor Desktop identity prefix** | n/a (v1) — MCP yes, soul dump no |

---

## 8. Non-goals (v1)

These are intentional. They are not on this slice's roadmap.

- Cursor Desktop identity prefix (MCP yes, 30KB soul dump no)
- `sessionStart` hook for bare `agent`
- `--agent` as a harness alias
- `hive dispatch` / `hive heartbeat tick` through Cursor
- Nightly transcript ingest from Cursor sessions
- Copying skills into `~/.cursor/skills/` (CLI already reads `~/.claude/skills/`)
- ACP mode (`agent acp`) — editor client protocol, not the TUI
- `--force` / `--yolo` as default launch flags
- Writing project-level `.cursor/mcp.json` or project `AGENTS.md`

---

## 9. v2 candidates (not designed here)

- User-level `sessionStart` hook so bare `agent` and/or Desktop chats get the identity prefix. Needs an explicit product call on Desktop token cost.
- Cursor CLI transcript path, if one stabilizes, for nightly Pass A.
- `Mcp(hive:*)` allowlist merge into `~/.cursor/cli-config.json` if user-scope auto-approve is not enough in practice.
- `--plugin-dir` as a durable `~/.hive/cursor-plugin/` instead of a tempfile, if Cursor starts hashing plugin dirs or the temp lifecycle gets flaky.

---

## 10. Implementation order

1. `src/lib/cursor-wire.ts` — bin find, MCP merge, temp identity plugin
2. `resolveHarness` flags (`-a` / `--cursor` / env); never steal `--agent`
3. `launchCursor` + `init` / `doctor` / `identity emit --harness cursor`
4. Stack `Harness` += `"cursor"` (Claude wording); fix `launchCodex` missing `harness: "codex"`
5. Tests + hive-reach / identity-injection / README / CLAUDE.md / usage
