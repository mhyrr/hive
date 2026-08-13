# Cursor CLI Harness (`hive -a`) — Design

**Status:** Design, verified against the installed binary. Not yet built.
**Date:** 2026-08-12 (revised same day after CLI verification pass)
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

True parity is not the goal. Reach is. Dispatch, heartbeat, and nightly
transcript ingestion stay Claude-Code-only, same as Pi and Codex.

---

## 1. Why Cursor is a wrap, not a science project

Cursor CLI is closer to **Codex** than to Claude Code: files + MCP
config, no `--system-prompt` / `--append-system-prompt`. It has one extra
launch hook Claude and Codex lack: `--plugin-dir`.

| Claude / Codex surface | Cursor CLI equivalent |
|---|---|
| `--append-system-prompt` / `--system-prompt` | **does not exist** (confirmed in `--help`) |
| Codex `~/.codex/AGENTS.md` (user-level) | **does not exist** |
| Claude `SessionStart` (blocking) | `sessionStart` → `additional_context` (**fire-and-forget**) |
| Claude `alwaysLoad: true` | **not a Cursor field** — MCP needs explicit per-project approval (§3.2) |
| Pi `pi -e <extension>` (spawn-time prompt prepend) | `--plugin-dir` with `alwaysApply: true` rule |
| `~/.claude.json` / `~/.codex/config.toml` MCP | `~/.cursor/mcp.json` (user scope) **+ `agent mcp enable`** |

The fire-and-forget `sessionStart` hook is too racy for
`hive -a "fix auth"` — the first turn can leave before identity lands.
The docs are explicit that "the agent loop does not wait for or enforce a
blocking response." `--plugin-dir` is the spawn-time analog of Pi's `-e`
and is the v1 identity path.

Cursor CLI already loads `~/.claude/skills/`. Codex needed a
"read the file" stack-hint variant (TK-114) because it has no Skill
tool. Cursor does, so the Claude wording is correct. (Cursor reads
`.cursor/skills/`, `.agents/skills/`, and for back-compat
`.claude/skills/` and `.codex/skills/`, at both project and user scope.)

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
  → temp plugin-dir (rules/hive-identity.mdc)
  → cursor-agent mcp enable hive          (best-effort, per-project approval)
  → cursor-agent --trust --plugin-dir <tmpdir> --add-dir ~/.hive [...args]

hive init
  → ~/.cursor/mcp.json  { hive: { command: hive-mcp } }
        ↳ Desktop + CLI both see the entry (still needs approval per project)
```

| Cargo | How |
|---|---|
| Identity | Per-launch temp plugin: `rules/hive-identity.mdc` with `alwaysApply: true`, body = `assembleIdentity({ harness: "cursor", includePersona: true, persona })`. Passed as `cursor-agent --plugin-dir <tmpdir>`. Cleaned on exit like Pi's `-e` tempfile. |
| MCP registration | `hive init` merges `hive` into `~/.cursor/mcp.json` (`command: ~/.local/bin/hive-mcp`). Idempotent; never overwrite an existing `hive` entry. |
| MCP approval | `cursor-agent mcp enable hive` from `$PWD` on **every** `hive -a` launch. Registration alone is not enough — see §3.2. |
| Project scope | Free — `assembleIdentity` already resolves from `$PWD`. |
| Soul files on disk | `--add-dir ~/.hive` (same as Claude). |
| Trust dialog | `--trust` so the TUI doesn't stall. Not `--force` / `--yolo`. |

### 3.1 Plugin shape

Identity-only. Do **not** also put MCP in the plugin or `hive`
double-registers.

```
<tmpdir>/
  .cursor-plugin/plugin.json    { "name": "hive-identity" }
  rules/hive-identity.mdc       alwaysApply: true
```

`plugin.json` requires only `name` (lowercase kebab-case). Cursor
auto-discovers `rules/` when the manifest omits explicit paths.

`.mdc` frontmatter — **exactly these two lines, no `description` key**:

```yaml
---
alwaysApply: true
---
<canonical identity prefix>
```

**The missing `description` is deliberate and must stay missing.** Cursor
staff confirmed a bug where a plugin rule carrying *both* `alwaysApply:
true` **and** a `description` is mapped to agent-requestable instead of
always-applied — only the description reaches context, not the body. The
documented workaround is to omit `description`. A fix was announced for
Desktop 3.6; CLI behavior is unconfirmed.

Consequences for the implementation:

- `writeCursorIdentityPlugin` carries a comment naming this bug, so nobody
  "improves" the writer by adding a description and silently kills identity.
- A test asserts the generated `.mdc` contains no `description:` key (§5).

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
- `getCursorMcpPath` → `~/.cursor/mcp.json`
- `registerCursorHiveMcp(mcpBinPath)` — merge, don't clobber
- `approveCursorHiveMcp(cursorBin, cwd)` — spawn
  `cursor-agent mcp enable hive`, swallow stdout/stderr, return a boolean;
  never throws
- `getCursorHiveMcpStatus(cursorBin, cwd)` — parse `cursor-agent mcp list`
  for the `hive` line; returns `"ready" | "needs-approval" | "error" | "absent"`
  (doctor uses this rather than globbing the opaque project-slug dirs)
- `supportsPluginDir(cursorBin)` — `cursor-agent --help` contains
  `--plugin-dir`; guards against a Cursor release dropping the undocumented
  flag out from under us (§8)
- `writeCursorIdentityPlugin(identity)` → `{ dir, path }` tempfile, same
  lifecycle as `writePiIdentityExtensionTempFile`
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
  const plugin = await writeCursorIdentityPlugin(identity);

  const cleanup = () => { void cleanupCursorPluginTempDir(plugin.dir); };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  // Cursor stores MCP approvals per project dir, so init cannot do this
  // once and be done. Best-effort; never blocks the launch. See §3.2.
  approveCursorHiveMcp(cursor, process.cwd());

  const result = Bun.spawnSync([
    cursor,
    "--trust",
    "--plugin-dir", plugin.dir,
    "--add-dir", join(process.env.HOME || "", ".hive"),
    ...args,
  ], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      HIVE_PERSONA: persona ?? process.env.HIVE_PERSONA,
    },
  });

  await cleanupCursorPluginTempDir(plugin.dir);
  process.exit(result.exitCode ?? 0);
}
```

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
  - `supportsPluginDir()` → warn if a Cursor update dropped the flag
  - `cursor-agent status` → auth present. A fresh machine otherwise fails at
    launch with no explanation.
- **`src/commands/identity.ts` + `src/lib/stack.ts`** — three edits, not
  one:
  - `stack.ts:299` `Harness` += `"cursor"` (this is the *identity/stack*
    type `claude | codex | pi`, distinct from the `harness.ts` routing type)
  - `buildStackHint` needs no new branch — only `codex` branches
    (`stack.ts:338`), so `cursor` falls through to the Claude wording, which
    is correct because Cursor has a Skill tool. Pin it with a test.
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
  - plugin dir contents: `.cursor-plugin/plugin.json` with `name`, and
    `rules/hive-identity.mdc` carrying `alwaysApply: true` and the identity body
  - **the `.mdc` contains no `description:` key** — the §3.1 bug guard
  - `getCursorHiveMcpStatus` parses `ready` / `needs approval` / error lines
  - skip cleanly when the binary is missing
- `src/__tests__/stack.test.ts` — cursor hint === claude hint for elixir/typescript
- `identity emit --harness cursor` is accepted (guards the `VALID_HARNESSES`
  half of the stack change)

---

## 6. Docs (lockstep — CLAUDE.md / README are the product)

- `docs/hive-reach.md` — fourth column
- `docs/identity-injection.md` — consumer row for `hive -a`
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `getUsage()` in `src/cli.ts`

---

## 7. Reach matrix (v1 target)

| | Cursor CLI (`hive -a`) |
|---|---|
| **Identity** | ⚠ Per-launch `--plugin-dir` with `alwaysApply` rule — **unproven, see §8** |
| **MCP tools** | ✓ `~/.cursor/mcp.json` registration + per-launch `mcp enable hive` |
| **Project scope** | ✓ Same `$PWD` resolution as other harnesses |
| **Council** | ✓ via MCP |
| **Doctor coverage** | ✓ optional Cursor group (binary, MCP entry, approval, auth, `--plugin-dir` support) |
| **Nightly transcript ingestion** | n/a (v1) |
| **Bare `cursor-agent` (no hive wrapper)** | n/a (v1) — MCP entry visible, still needs approval |
| **Cursor Desktop identity prefix** | n/a (v1) — MCP yes, soul dump no |

---

## 8. The open bet: does the rule actually land?

**Everything in §3.1 rests on an assumption that could not be verified
before writing this.** Stated plainly so it is not mistaken for settled:

- `--plugin-dir` appears in `cursor-agent --help` but in **none** of the
  published plugin docs. Undocumented flags move without warning — hence the
  `supportsPluginDir()` doctor check.
- The nearest documented behavior has a staff-confirmed injection bug
  (§3.1), on the exact mechanism we depend on.
- The canary probe could not run. A temp plugin with a marker phrase was
  built and `cursor-agent -p` was invoked against it; Cursor's stream
  endpoint (`agentn.global.api5.cursor.sh`) failed with
  `RetriableError: WritableIterable is closed` on every attempt. A
  no-plugin `-p "Reply PONG"` baseline failed identically, so this is
  Cursor-side infrastructure, not the design. `--list-models` and
  `mcp list` both work, so auth is fine.

**We try it.** Step 0 of implementation is re-running the canary the moment
the endpoint recovers. If the rule lands, the design is unchanged. If it
does not, take the ladder in order:

1. **Drop `alwaysApply`, keep the plugin, reference the rule by
   description.** Cheapest change; makes identity agent-requestable rather
   than guaranteed. Fails the reach test — a fallback only if paired with 2.
2. **Prepend identity to the positional prompt.** `cursor-agent [prompt...]`
   takes a positional; `hive -a "fix auth"` becomes identity + separator +
   the user's prompt. Guaranteed delivery, costs the prefix on turn one, and
   degrades badly for a bare interactive `hive -a` with no prompt.
3. **Install to `~/.cursor/plugins/local/hive-identity/`.** The *documented*
   local-plugin path. Rejected for v1 because it is global and leaks the
   ~31KB prefix into Cursor Desktop, contradicting §3.3 — acceptable only as
   an explicit product call.

Ship nothing that claims identity reach until the canary passes or a rung
of the ladder is taken.

### Known unknowns (not blockers)

- **Rule size ceiling.** The prefix measures 30,834 bytes on this project.
  No documented cap on `.mdc` bodies; truncation would be silent. The canary
  should use a marker placed at the **end** of a realistically-sized body so
  a size cap shows up as a failure rather than a pass.
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
- `hive dispatch` / `hive heartbeat tick` through Cursor
- Nightly transcript ingest from Cursor sessions
- Copying skills into `~/.cursor/skills/` (CLI already reads `~/.claude/skills/`)
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
- Promote a rung of the §8 ladder to the default if `--plugin-dir` proves
  unreliable in practice.

**Dropped from the original v2 list:**

- ~~`Mcp(hive:*)` allowlist merge into `~/.cursor/cli-config.json` if
  user-scope auto-approve is not enough~~ — user scope never auto-approved.
  This is a v1 requirement, and the mechanism is `cursor-agent mcp enable`
  writing `~/.cursor/projects/<slug>/mcp-approvals.json`, not
  `cli-config.json` permissions. Folded into §3.2.
- ~~`--plugin-dir` as a durable `~/.hive/cursor-plugin/` instead of a
  tempfile~~ — actively wrong. The identity body varies per project
  (project memory, stack hint), so a single shared path corrupts two
  concurrent `hive -a` sessions in different repos. `mkdtemp` is correct.

---

## 11. Verification log (2026-08-12)

Run against `cursor-agent 2026.08.11-e8db854` on this machine. MCP probes
used an **isolated `HOME`** under the session scratchpad; no user config
was modified.

| Claim | Method | Result |
|---|---|---|
| No `--system-prompt` / `--append-system-prompt` | `cursor-agent --help` | Confirmed absent |
| `--plugin-dir`, `--trust`, `--add-dir` exist | `cursor-agent --help` | All three present; `--plugin-dir` repeatable |
| Both `agent` and `cursor-agent` installed | `ls -la ~/.local/bin` | Symlinks to the same versioned script |
| Plugin dir shape | Plugins Reference docs | `.cursor-plugin/plugin.json` required; `name` the only required field; `rules/` auto-discovered |
| `alwaysApply` + `description` demotion | Cursor forum, staff reply | Confirmed bug; omit `description` |
| `sessionStart` is fire-and-forget | Hooks docs | "does not wait for or enforce a blocking response" |
| Cursor reads `~/.claude/skills/` | Skills docs + forum request to disable it | Confirmed — Claude stack-hint wording is right |
| User-scope MCP auto-approves | Isolated `HOME` + `cursor-agent mcp list` | **False.** `hive: not loaded (needs approval)` |
| `mcp enable` fixes it | `cursor-agent mcp enable hive` | `✓ Enabled and approved`; list → `hive: ready` |
| Approval scope | Inspected written files | Per project dir: `~/.cursor/projects/<slug>/mcp-approvals.json` → `["hive-62b40f744233058e"]` |
| `-a` collides with an existing HIVE flag | `grep -rn '"-a"' src/` | No collision |
| `launchCodex` missing `harness: "codex"` | `src/cli.ts:275` | Confirmed — real bug |
| Identity prefix size | `hive identity emit \| wc -c` | 30,834 bytes |
| Rule reaches the model | canary plugin + `cursor-agent -p` | **Blocked** — endpoint failure, no-plugin baseline failed identically. See §8 |

---

## 12. Implementation order

0. **Canary probe.** Temp plugin, `alwaysApply: true`, no `description`,
   marker phrase at the end of a ~31KB body. Run `cursor-agent -p` and
   confirm the marker comes back. Gate the identity leg on this; take a §8
   rung if it fails.
1. `src/lib/cursor-wire.ts` — bin discovery, MCP merge, `mcp enable`
   wrapper, status parser, `supportsPluginDir`, temp identity plugin
2. `resolveHarness` flags (`-a` / `--cursor` / env); never steal `--agent`
3. `launchCursor` (plugin + per-launch `mcp enable` + `HIVE_PERSONA`) +
   `init` / `doctor` / `identity emit --harness cursor`
4. Stack `Harness` += `"cursor"` (Claude wording) **and** `VALID_HARNESSES`
   + usage text; fix `launchCodex` missing `harness: "codex"`
5. Tests + hive-reach / identity-injection / README / CLAUDE.md / usage
