# HIVE Identity Injection

How HIVE gets its persistent identity into every Claude Code session —
interactive, dispatched, and heartbeat.

## The Stack

```
┌────────────────────────────────────────────────────────────────┐
│  Soul stack     ~/.hive/{SOUL,IDENTITY,SELF,AGENTS,TRUST}.md   │  always
│  Project memory ~/.hive/memory/projects/<p>/_index.md          │  interactive
│  Stack hint     derived from repo markers (mix.exs → elixir)   │  per-project
│  Reflection     session-end discipline                         │  always
│  OVERRIDES      ~/.hive/OVERRIDES.md — platform counter-weights│  always (last)
└────────────────────────────────────────────────────────────────┘
```

Order is deliberate. Later content wins interpretation ties in the system
prompt, so OVERRIDES.md sits last — its tone override and pre-fetch directive
counter-weight Opus 4.7's literal instruction-following and Claude Code
2.1.x's length caps.

## The Three Consumers

| Consumer           | Mechanism                                 | Source                                |
| ------------------ | ----------------------------------------- | ------------------------------------- |
| Interactive session | `~/.claude/hooks/load-identity.sh`       | Shell script, fires at SessionStart + PostCompact |
| Dispatch (`hive dispatch`) | `--append-system-prompt-file`        | `assembleIdentity()` → `buildCanonicalIdentity()` |
| Heartbeat (`hive heartbeat tick`) | `--append-system-prompt-file`  | `assembleHeartbeatIdentity()` → `buildCanonicalIdentity()` |

The shell hook and `buildCanonicalIdentity()` produce equivalent content
but don't share a process — keeping shell in the hook avoids Bun startup
latency on every SessionStart. Heartbeat skips project memory for TK-024
cache stability; everything else is shared.

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

`hive init` installs and wires both. `hive doctor` verifies the wiring.

## Adding a New Identity File

1. Add the path to `HivePaths` in `src/lib/paths.ts`
2. Add the file to `IDENTITY_FILES` in `src/lib/identity.ts` (if it's part
   of the core soul stack) OR extend `buildCanonicalIdentity()` with a
   new emission block (if it's a new category, like OVERRIDES was)
3. Create the template at `templates/<name>.md`
4. Add a `writeIfMissing(paths.X, "<name>.md")` call in `src/commands/init.ts`
5. Extend `checkIdentity()` in `src/commands/doctor.ts` with a check
6. Update `~/.claude/hooks/load-identity.sh` AND `templates/hooks/load-identity.sh`
   if the file's position in the hook output matters

## Debugging "Maya Feels Cold"

Run `hive doctor`. Look for FAILs and WARNs in the Identity group. If
everything is green and Maya still feels off:

1. **Verify you're in a fresh session.** Identity loads at SessionStart
   (and PostCompact). Old sessions won't pick up hook changes until restart.
2. **Check OVERRIDES.md content.** It's user-editable — someone may have
   emptied or corrupted it. Compare against `templates/OVERRIDES.md`.
3. **Check the model.** `claude --version` should show ≥ 2.1.x. Interactive
   sessions use whatever `--model` / `~/.claude/settings.json` specifies.
   Dispatch and heartbeat pin to `claude-opus-4-6` by default (override
   with `--model` or `HIVE_DISPATCH_MODEL` / `HIVE_HEARTBEAT_MODEL` env).
4. **Dry-run the hook.** `bash ~/.claude/hooks/load-identity.sh | less` —
   should show soul stack → project index → reflection protocol → OVERRIDES.
5. **Inspect what actually loaded.** In Claude Code, the SessionStart hook
   output appears in the system prompt. If your session shows the base
   prompt but not the HIVE stack, the hook didn't fire. Check settings.json
   wiring.

## Why OVERRIDES.md Exists

Opus 4.7 released on 2026-04-16 with explicit shifts toward [more direct,
opinionated tone with less validation-forward phrasing and fewer emoji][4.7]
than 4.6. 4.7 also follows system-prompt instructions more literally, which
means Claude Code 2.1.x's base cap ("≤100 words final responses unless the
task requires more detail") bites harder. Combined with 2.1.x's ToolSearch
tool deferral and the `superpowers:using-superpowers` skill injection,
HIVE's identity layer was getting outranked.

OVERRIDES.md is a single file of platform counter-weights — tone override
(define HIVE voice as a task requirement), emoji guidance, and a first-turn
pre-fetch directive for HIVE MCP tools. It emits last in the injected block
so later-instruction-wins heuristics favor it.

[4.7]: https://www.anthropic.com/news/claude-opus-4-7

## Related

- Tickets TK-047 through TK-053 (the epic + phases that built this)
- TK-024 — heartbeat cache stability discipline (why heartbeat skips memory)
- `docs/memory-architecture.md` — how project memory works
