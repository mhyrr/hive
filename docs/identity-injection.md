# HIVE Identity Injection

How HIVE gets its persistent identity into every Claude Code session —
interactive, dispatched, and heartbeat.

## The Stack

```
┌────────────────────────────────────────────────────────────────────┐
│ 1. Soul stack     ~/.hive/{SOUL,IDENTITY,SELF,AGENTS,TRUST}.md     │  always
│ 2. Project memory ~/.hive/memory/projects/<p>/_index.md            │  interactive + dispatch
│ 3. Stack hint     derived from repo markers (mix.exs → elixir)     │  per-project
│ 4. Taste          ~/.hive/taste/principles.md                      │  when present (LAST = loudest)
└────────────────────────────────────────────────────────────────────┘
```

Order is deliberate. Later content wins interpretation ties in the system
prompt, so the taste layer sits last.

Reflection discipline lives inside AGENTS.md (no longer a separate emission
block). OVERRIDES.md (the old 6th tier) was retired once Claude Code's
harness behavior settled — the only verifiably load-bearing piece, the MCP
tool pre-fetch directive that works around ToolSearch deferral, moved into
AGENTS.md.

V1 cutover (2026-04-27) collapsed the taste layer to `principles.md` only.
The previous per-domain `applications/<d>.md` + `--taste <domain>` flag were
removed; Pass V now reads the same `principles.md` during the nightly run
so taste lives at one altitude across session-time and verify-time.

## Single Source of Truth

`buildCanonicalIdentity()` in `src/lib/identity.ts` is the only program that
assembles the identity prefix. All three consumers route through it:

| Consumer            | How it gets the prefix                                       |
| ------------------- | ------------------------------------------------------------ |
| Interactive session | `~/.claude/hooks/load-identity.sh` → `hive identity emit`    |
| Dispatch (`hive dispatch`)         | `--append-system-prompt-file` → `assembleIdentity()`          |
| Heartbeat (`hive heartbeat tick`)  | `--append-system-prompt-file` → `assembleHeartbeatIdentity()` |

The SessionStart hook is a thin shell wrapper that delegates to the
`hive identity emit` command. Drift between the shell and TypeScript
paths is structurally impossible: there is only one program that builds
the prefix.

Heartbeat skips project memory (TK-024 cache stability) — same code path,
different option (`includeProjectMemory: false`).

## Wiring

The canonical user-level hook is at `~/.claude/hooks/load-identity.sh`.
It's wired in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/load-identity.sh" }] }],
    "PostCompact":  [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/load-identity.sh" }] }]
  }
}
```

`hive init` installs and wires both. `hive doctor` verifies wiring AND
that the live hook hasn't drifted from `templates/hooks/load-identity.sh`.

If the doctor flags drift, run `hive init --force-hook` to restore the
canonical wrapper. (User customization belongs in `~/.hive/*.md` files,
not in the hook.)

## Adding a New Identity Section

The full add-checklist when introducing a new section to the prefix:

1. If it's a new file path, add it to `HivePaths` in `src/lib/paths.ts`
2. If it's part of the soul stack, add the filename to `IDENTITY_FILES`
   in `src/lib/identity.ts`. Otherwise extend `buildCanonicalIdentity()`
   with a new emission block in the right ordering position.
3. Create the template at `templates/<name>.md`
4. Add a `writeIfMissing(paths.X, "<name>.md")` call in `src/commands/init.ts`
5. Extend `checkIdentity()` in `src/commands/doctor.ts` with a presence check
6. Update `src/__tests__/identity.test.ts`:
   - Seed the new file in the fixture
   - Add a marker assertion in the "emits all four sections" test
   - Adjust the canonical ordering list
7. Update the stack diagram in this file

The bash hook does NOT need updating — it always delegates to
`hive identity emit`, which calls `assembleIdentity()`, which calls
`buildCanonicalIdentity()`. The hook is generic plumbing.

## Drift Detection

Two tests guard against the drift that motivated this consolidation:

- `hook ↔ assembleIdentity parity` — runs the template hook in a fixture
  HIVE_HOME and asserts byte-equality with `assembleIdentity()`. If the
  hook stops being a pure delegator (e.g. someone adds shell logic), this
  fails.
- `live ~/.claude/hooks/load-identity.sh matches the template` — verifies
  that the installed hook hasn't been hand-edited away from the canonical
  template. Mirrored by `hive doctor`.

Together they enforce: shell hook == TypeScript code path == installed file.

## Debugging "Maya Feels Cold"

Run `hive doctor`. Look for FAILs and WARNs in the Identity group. If
everything is green and Maya still feels off:

1. **Verify you're in a fresh session.** Identity loads at SessionStart
   (and PostCompact). Old sessions won't pick up changes until restart.
2. **Check the model.** `claude --version` should show ≥ 2.1.x. Interactive
   sessions use whatever `--model` / `~/.claude/settings.json` specifies.
   Dispatch and heartbeat pin to `claude-opus-4-6` by default (override
   with `--model` or `HIVE_DISPATCH_MODEL` / `HIVE_HEARTBEAT_MODEL`).
3. **Dry-run the hook.** `bash ~/.claude/hooks/load-identity.sh | less` —
   should show soul stack → project memory → stack hint → taste.
4. **Dry-run the command directly.** `hive identity emit | less` — same
   output as the hook. If they differ, the hook drifted (run
   `hive init --force-hook`).
5. **Inspect what actually loaded.** In Claude Code, the SessionStart hook
   output appears in the system prompt. If your session shows the base
   prompt but not the HIVE stack, the hook didn't fire. Check settings.json
   wiring.

## Related

- Tickets TK-047 through TK-053 (the identity-reconsolidation epic)
- TK-024 — heartbeat cache stability discipline (why heartbeat skips memory)
- `docs/memory-architecture.md` — how project memory works
