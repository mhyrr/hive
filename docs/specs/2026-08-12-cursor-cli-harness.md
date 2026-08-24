# Cursor CLI Harness (`hive -a`) — Design

**Status:** Implemented. Plugin transport rejected by canary; combined prompt transport verified against the live model.
**Date:** 2026-08-12 (revised 2026-08-19 after the identity canary)
**Author:** Maya (with Greg)
**Aiming docs:** `docs/hive-reach.md`, `docs/identity-injection.md`
**Verified against:** `cursor-agent 2026.08.11-e8db854` — see §11 for the log.

---

## 0. What this is

Add Cursor CLI (`cursor-agent`) as a fourth interactive harness, next to
Claude Code (`hive`), Pi (`hive -3`), and Codex (`hive -x`). The
user-facing shape is `hive -a` / `hive --cursor`.

The three-question reach test from `hive-reach.md` still governs:

1. **Identity** — canonical prefix (soul + persona + project memory +
   stack hint + taste) loads at launch.
2. **MCP tools** — `hive_*` tools reach the runtime.
3. **Project scope** — active project resolves from `$PWD`.

True parity is not the goal. Reach is. Watch Act stays Claude-Code-only.
The nightly pipeline ingests Claude Code and Codex transcripts. It does not
ingest Cursor or Pi transcripts.

---

## 1. Why Cursor is a wrap, not a science project

Cursor CLI is closer to **Codex** than to Claude Code: files + MCP
config, no `--system-prompt` / `--append-system-prompt`. Its positional
initial prompt is the only verified launch-time identity path.

| Claude / Codex surface | Cursor CLI equivalent |
|---|---|
| `--append-system-prompt` / `--system-prompt` | **does not exist** (confirmed in `--help`) |
| Codex `~/.codex/AGENTS.md` (user-level) | **does not exist** |
| Claude `SessionStart` (blocking) | `sessionStart` → `additional_context` (**fire-and-forget**) |
| Claude `alwaysLoad: true` | **not a Cursor field** — MCP needs explicit per-project approval (§3.2) |
| Pi `pi -e <extension>` (spawn-time prompt prepend) | Positional initial prompt |
| `~/.claude.json` / `~/.codex/config.toml` MCP | `~/.cursor/mcp.json` (user scope) **+ `agent mcp enable`** |

The fire-and-forget `sessionStart` hook is too racy for
`hive -a "fix auth"` — the first turn can leave before identity lands.
The docs are explicit that "the agent loop does not wait for or enforce a
blocking response." A 2026-08-19 canary also proved that a per-launch plugin
rule did not reach the model (§8). HIVE therefore prepends identity to the
positional initial prompt.

The verified Cursor version reads `~/.claude/skills/`, so the Claude-style
stack hint works without copying skills. This is Cursor compatibility
behavior, not a HIVE portability layer. HIVE does not promise that every
Claude Code skill works unchanged in Cursor.

Auth is a Cursor account (`cursor-agent login` / `CURSOR_API_KEY`), not
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

`-a` is currently unclaimed anywhere in `src/` — verified, no collision.

`HIVE_CURSOR_BIN` overrides binary discovery, matching `HIVE_CODEX_BIN`
/ `HIVE_PI_BIN`.

**Binary discovery order** — prefer the qualified name:

1. `$HIVE_CURSOR_BIN` (if it exists on disk)
2. `which cursor-agent`
3. `which agent`
4. `~/.local/bin/cursor-agent`

The installer creates **both** `agent` and `cursor-agent` in
`~/.local/bin` as symlinks to the same versioned script. `agent` is a
generic name that may be an unrelated tool on another machine's PATH, so
`cursor-agent` is probed first and `agent` is the compatibility fallback.

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
  → assembleIdentity({ harness: "cursor", includePersona, persona })
  → cursor-agent mcp enable hive          (best-effort, per-project approval)
  → prepend identity to positional initial prompt
  → cursor-agent --trust --add-dir ~/.hive [...args]

hive init
  → ~/.cursor/mcp.json  { hive: { command: hive-mcp } }
        ↳ Desktop + CLI both see the entry (still needs approval per project)
```

| Cargo | How |
|---|---|
| Identity | `assembleIdentity({ harness: "cursor", includePersona: true, persona })` is prepended to the positional initial prompt. With no user prompt, HIVE supplies a synthetic first turn that carries only the identity and startup instruction. |
| MCP registration | `hive init` merges `hive` into `~/.cursor/mcp.json` (`command: ~/.local/bin/hive-mcp`). Idempotent; never overwrite an existing `hive` entry. |
| MCP approval | `cursor-agent mcp enable hive` from `$PWD` on **every** `hive -a` launch. Registration alone is not enough — see §3.2. |
| Project scope | Free — `assembleIdentity` already resolves from `$PWD`. |
| Soul files on disk | `--add-dir ~/.hive` (same as Claude). |
| Trust dialog | `--trust` so the TUI doesn't stall. Not `--force` / `--yolo`. |

### 3.1 Initial-prompt shape

When the caller supplies a prompt, HIVE separates documented Cursor options
from positional request text. It preserves the options, then emits one
positional argument containing the identity, a boundary instruction, and the
user request. This single-argument shape is required: the 2026-08-19 live run
showed that Cursor accepted multiple positional arguments but acted only on
the first one.

When the caller runs bare `hive -a`, HIVE sends a synthetic positional prompt
that carries the identity and tells Cursor to wait for the user's request.
This consumes the first turn. Cursor then remains interactive. The visible
startup turn is the real caveat of the verified mechanism.

Do not reintroduce the plugin path without a new canary. The 2026-08-19 probe
exited successfully but the model stated that it lacked the marker (§8).

### 3.2 MCP needs per-project approval — registration is not enough

This is the part that differs most from Codex and Pi, and it is the one
place where "write the config file once" does not work.

A user-scope `~/.cursor/mcp.json` entry does **not** auto-approve. Probed
with an isolated `HOME` containing nothing but a `hive` entry:

```
$ cursor-agent mcp list
hive: not loaded (needs approval)

$ cursor-agent mcp enable hive
✓ Enabled and approved MCP server: hive

$ cursor-agent mcp list
hive: ready
```

Approval persists **per project directory**:

```
~/.cursor/projects/<slugified-cwd>/mcp-approvals.json
  → ["hive-62b40f744233058e"]
```

Three design consequences:

1. **`hive init` alone can never satisfy this.** Approval is scoped to the
   directory it was granted in, so every new repo needs its own. The enable
   call belongs in `launchCursor`, not only in init.
2. **The key is `hive-<hash of the server config>`.** Change the `hive-mcp`
   command path and the stored approval no longer matches — it silently
   reverts to unapproved. A launch-time enable self-heals this; an
   init-only design would rot the first time the binary moves.
3. **The old rationale for user scope was wrong, the conclusion survives.**
   Project `.cursor/mcp.json` is not rejected because it "prompts for
   approval" — both scopes do. It is rejected because it mutates the user's
   repos. Init writes user scope only.

**Use `cursor-agent mcp enable hive`, not `--approve-mcps`.** The flag
blanket-approves every server in the user's config; a real
`~/.cursor/mcp.json` has unrelated third-party servers in it (Greg's has
two). HIVE approves HIVE's server and nothing else.

The enable call is best-effort: suppress its output, ignore a non-zero
exit, never block the launch. If `hive` is not registered yet (init not
run) it simply fails and the launch proceeds without HIVE tools.

`hive init` also runs the enable once from its own `$PWD` as a
convenience for the common "init then work here" case. The launch-time
call is the actual guarantee.

### 3.3 Why not a user-level `sessionStart` hook in v1

Writing `~/.cursor/hooks.json` would fire in Cursor **Desktop** as well
as CLI. That dumps the ~31KB identity prefix into every Cmd+I chat.
Identity is `hive -a` only in v1, same as Pi (no hook for bare `pi`).

There is a second hazard: `~/.cursor/hooks.json` is a real user file with
real contents (Greg's has ten vibe-island bridge hooks). Any future
version that writes it must **merge**, never overwrite — same discipline
as the `~/.cursor/mcp.json` merge.

MCP registration in `~/.cursor/mcp.json` **does** leak into Desktop. That
is intentional: tools on demand, no prefix bloat. Desktop has its own
approval flow.

A hook for bare `cursor-agent` (no `hive` wrapper) is v2.

---

## 4. Code changes

### New module: `src/lib/cursor-wire.ts`

Copy the Pi/Codex split.

- `isCursorInstalled` / `findCursorBin` — discovery order per §2
- `getCursorMcpConfigPath` → `~/.cursor/mcp.json`
- `registerCursorHiveMcp(mcpBinPath)` — merge, don't clobber
- `approveCursorHiveMcp(cursorBin, cwd)` — spawn
  `cursor-agent mcp enable hive`, swallow stdout/stderr, return a boolean;
  never throws
- `getCursorHiveMcpStatus(cursorBin, cwd)` — parse `cursor-agent mcp list`
  for the `hive` line; returns `"ready" | "needs-approval" | "error" | "absent"`
  (doctor uses this rather than globbing the opaque project-slug dirs)
- `wireCursor({ mcpBinPath })` — init entry; skip silently if the binary is
  missing

### Routing: `src/lib/harness.ts`

- `Harness` += `"cursor"` (this is the `harness.ts` type:
  `claude-code | codex | pi | cursor`)
- Strip `-a` / `--cursor`; honor `HIVE_HARNESS=cursor`

### Launch: `src/cli.ts`

```ts
async function launchCursor(args: string[], persona?: string): Promise<void> {
  const cursor = findCursor();
  const identity = await assembleIdentity({
    harness: "cursor",
    includePersona: true,
    persona,
  });

  // Cursor stores MCP approvals per project dir, so init cannot do this
  // once and be done. Best-effort; never blocks the launch. See §3.2.
  approveCursorHiveMcp(cursor, process.cwd());

  const cursorArgs = buildCursorLaunchArgs(identity, args);

  const result = Bun.spawnSync([
    cursor,
    "--trust",
    "--add-dir", join(process.env.HOME || "", ".hive"),
    ...cursorArgs,
  ], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      HIVE_PERSONA: persona ?? process.env.HIVE_PERSONA,
    },
  });

  process.exit(result.exitCode ?? 0);
}
```

`buildCursorLaunchArgs` preserves documented Cursor options and folds all
positional request text into one identity-plus-request argument. If there is
no request, that argument becomes the synthetic startup turn described in
§3.1. `--` forces all later arguments into request text.

`HIVE_PERSONA` propagation matches `launchCodex` (`src/cli.ts:288`); Pi
omits it, Codex has it, and Codex is right.

Wire into `launchAgent` alongside the Pi/Codex branches, including the
`claudeMode !== "append"` warning for `--owned` / `--bare`.

### Init / doctor / identity

- **`src/commands/init.ts`** — `wireCursor` after `wirePi`, same
  best-effort try/catch (`init.ts:357` is the Pi call site).
- **`src/commands/doctor.ts`** — optional Cursor group, modeled on the
  Codex group at `doctor.ts:74`. Missing binary is a **skip (pass)**, not a
  fail — same as Codex/Pi. Checks:
  - `cursor-agent <version>` present
  - `hive` entry in `~/.cursor/mcp.json`, and its `command` path exists
  - `getCursorHiveMcpStatus()` → `ready` passes; `needs-approval` warns with
    the fix (`cursor-agent mcp enable hive`, or just run `hive -a` once here)
  - `cursor-agent status` → auth present. A fresh machine otherwise fails at
    launch with no explanation.
- **`src/commands/identity.ts` + `src/lib/stack.ts`** — three edits, not
  one:
  - `stack.ts:299` `Harness` += `"cursor"` (this is the *identity/stack*
    type `claude | codex | pi`, distinct from the `harness.ts` routing type)
  - `buildStackHint` needs no new branch — only `codex` branches
    (`stack.ts:338`), so `cursor` falls through to the Claude wording. This
    matches the verified Cursor version's `~/.claude/skills/` compatibility
    behavior. Pin it with a test, but do not describe this as full skill
    portability.
  - `identity.ts:5` `VALID_HARNESSES` += `"cursor"`, plus the usage string
    (`--harness claude|codex|pi|cursor`) and the "Valid: …" error message.
    Type-only changes will pass typecheck and still reject
    `hive identity emit --harness cursor` at runtime.

### Drive-by: Codex launch bug

`launchCodex` in `src/cli.ts:275` calls `assembleIdentity` **without**
`harness: "codex"`. Init, doctor, and the Codex SessionStart hook all pass
it. First `hive -x` session can load Claude-style Skill-tool wording;
doctor then reports AGENTS.md stale. Pass `harness: "codex"` while here.

---

## 5. Tests

- `src/__tests__/harness.test.ts` — `-a`, `--cursor`, `HIVE_HARNESS=cursor`,
  `--claude` override, `--agent maya-coder` still in `remainingArgs`
- `src/__tests__/cursor-wire.test.ts` — mirror `pi-wire.test.ts`:
  - MCP merge + idempotency; existing `hive` entry never clobbered; unrelated
    servers preserved
  - `getCursorHiveMcpStatus` parses `ready` / `needs approval` / error lines
  - skip cleanly when the binary is missing
- Cursor launch tests — option values pass through, identity and request share
  one positional argument, and bare interactive launch receives the synthetic
  first turn
- `src/__tests__/stack.test.ts` — cursor hint === claude hint for elixir/typescript
- `identity emit --harness cursor` is accepted (guards the `VALID_HARNESSES`
  half of the stack change)

---

## 6. Docs (lockstep — CLAUDE.md / README are the product)

- `docs/hive-reach.md` — fourth column
- `docs/identity-injection.md` — consumer row for `hive -a`
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `getUsage()` in `src/cli.ts`

---

## 7. Reach matrix (v1)

| | Cursor CLI (`hive -a`) |
|---|---|
| **Identity** | ✓ Canonical identity prepended to the positional initial prompt; bare interactive consumes a synthetic first turn |
| **MCP tools** | ✓ `~/.cursor/mcp.json` registration + per-launch `mcp enable hive` |
| **Project scope** | ✓ Same `$PWD` resolution as other harnesses |
| **Council** | ✓ via MCP |
| **Doctor coverage** | ✓ optional Cursor group (binary, MCP entry, approval, auth) |
| **Nightly transcript ingestion** | n/a (v1) |
| **Bare `cursor-agent` (no hive wrapper)** | n/a (v1) — MCP entry visible, still needs approval |
| **Cursor Desktop identity prefix** | n/a (v1) — MCP yes, soul dump no |

---

## 8. Identity canary: plugin rejected, prompt prepend chosen

The previously blocked canary ran on 2026-08-19 against
`cursor-agent 2026.08.11-e8db854`. It used a 30,367-byte canonical identity
inside a 30,513-byte always-applied plugin rule. Cursor exited 0, but the
model replied:

> I don’t have the HIVE identity canary value in this session, and you asked
> me not to use tools to read it from `~/.hive/`.

The marker did not match. A clean process exit proved only that Cursor
accepted the plugin argument. It did not prove that the rule reached model
context.

This closes the old open bet. V1 takes fallback rung 2: prepend canonical
identity to the positional initial prompt. A caller-supplied prompt follows
the identity in the same turn. A bare interactive launch receives a synthetic
first turn and then waits for the user.

### Known unknowns (not blockers)

- **CLI output-stream reliability.** A 30,435-byte combined prompt reached the
  model, and the model wrote the correct answer to Cursor's local transcript.
  The CLI then lost its server connection during output, exhausted three
  retries, and ended with `WritableIterable is closed` before stdout received
  the answer. This is a Cursor transport failure after inference, not an
  identity-context failure, but one run does not establish reliability at this
  prompt size.
- **Sandbox interaction.** `~/.cursor/cli-config.json` carries
  `sandbox.mode` and the server pushes `cliSandboxDefaultEnabled`. Currently
  `disabled` here. If a user has it enabled, whether the sandbox affects
  spawning the local `hive-mcp` stdio server is untested.

---

## 9. Non-goals (v1)

These are intentional. They are not on this slice's roadmap.

- Cursor Desktop identity prefix (MCP yes, ~31KB soul dump no)
- `sessionStart` hook for bare `cursor-agent`
- `--agent` as a harness alias
- `--approve-mcps` as a launch flag — blanket-approves every third-party
  server in the user's config (§3.2)
- Watch Act through Cursor
- Nightly transcript ingest from Cursor sessions
- Copying skills into `~/.cursor/skills/` (the verified CLI reads
  `~/.claude/skills/`; that compatibility does not promise full portability)
- ACP mode (`cursor-agent acp`) — editor client protocol, not the TUI
- `--force` / `--yolo` as default launch flags
- Writing project-level `.cursor/mcp.json` or project `AGENTS.md`
- Writing `~/.cursor/hooks.json` (real user file, merge-only if ever)

---

## 10. v2 candidates (not designed here)

- User-level `sessionStart` hook so bare `cursor-agent` and/or Desktop chats
  get the identity prefix. Needs an explicit product call on Desktop token
  cost, and must merge into the existing `hooks.json`, never overwrite.
- Cursor CLI transcript path, if one stabilizes, for nightly Pass A.

**Dropped from the original v2 list:**

- ~~`Mcp(hive:*)` allowlist merge into `~/.cursor/cli-config.json` if
  user-scope auto-approve is not enough~~ — user scope never auto-approved.
  This is a v1 requirement, and the mechanism is `cursor-agent mcp enable`
  writing `~/.cursor/projects/<slug>/mcp-approvals.json`, not
  `cli-config.json` permissions. Folded into §3.2.
- ~~Per-launch `--plugin-dir` identity rule~~ — rejected by the 2026-08-19
  canary. Cursor accepted the argument but did not expose the marker to the
  model. See §8.

---

## 11. Verification log (2026-08-12 and 2026-08-19)

Run against `cursor-agent 2026.08.11-e8db854` on this machine. MCP probes
used an **isolated `HOME`** under the session scratchpad; no user config
was modified.

| Claim | Method | Result |
|---|---|---|
| No `--system-prompt` / `--append-system-prompt` | `cursor-agent --help` | Confirmed absent |
| `--trust`, `--add-dir` exist | `cursor-agent --help` | Both present |
| Both `agent` and `cursor-agent` installed | `ls -la ~/.local/bin` | Symlinks to the same versioned script |
| `sessionStart` is fire-and-forget | Hooks docs | "does not wait for or enforce a blocking response" |
| Cursor reads `~/.claude/skills/` | Skills docs + forum request to disable it | Confirmed — Claude stack-hint wording is right |
| User-scope MCP auto-approves | Isolated `HOME` + `cursor-agent mcp list` | **False.** `hive: not loaded (needs approval)` |
| `mcp enable` fixes it | `cursor-agent mcp enable hive` | `✓ Enabled and approved`; list → `hive: ready` |
| Approval scope | Inspected written files | Per project dir: `~/.cursor/projects/<slug>/mcp-approvals.json` → `["hive-62b40f744233058e"]` |
| `-a` collides with an existing HIVE flag | `grep -rn '"-a"' src/` | No collision |
| `launchCodex` missing `harness: "codex"` | `src/cli.ts:275` | Confirmed — real bug |
| Initial identity prefix size | canary measurement | 30,367 bytes |
| Plugin rule size | canary measurement | 30,513 bytes |
| Rule reaches the model | canary plugin + `cursor-agent --trust --mode ask --print` | **False.** Exit 0; model said it lacked the canary; marker did not match. See §8 |
| Combined identity + request reaches the model | `hive -a --mode ask --print` + local Cursor transcript | **True.** The 30,435-byte user turn ended with the requested question; the assistant wrote `Maya` and `🐝🍯`. The CLI output stream then failed with `WritableIterable is closed`, so the answer remained in the transcript instead of reaching stdout. |

---

## 12. Implementation order

0. **Canary probe.** Complete: plugin identity failed; use prompt prepend.
1. `src/lib/cursor-wire.ts` — bin discovery, MCP merge, `mcp enable`
   wrapper, status parser
2. `resolveHarness` flags (`-a` / `--cursor` / env); never steal `--agent`
3. `launchCursor` (initial-prompt prepend + per-launch `mcp enable` + `HIVE_PERSONA`) +
   `init` / `doctor` / `identity emit --harness cursor`
4. Stack `Harness` += `"cursor"` (Claude wording) **and** `VALID_HARNESSES`
   + usage text; fix `launchCodex` missing `harness: "codex"`
5. Tests + hive-reach / identity-injection / README / CLAUDE.md / usage
