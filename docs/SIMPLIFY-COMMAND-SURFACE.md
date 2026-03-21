# Command Surface Consolidation

Design document. March 2026.

---

## Problem

HIVE has 28+ commands. Several overlap significantly, others are internal
primitives that shouldn't be top-level, and the overall surface is hard to
hold in your head. A CLI that requires a cheat sheet has too many commands.

The control surface should be obvious. A new user should be able to guess
what command they need.

---

## Current Command Inventory

```
Setup:        init, project, work
Front door:   run, say, ask, console, chat, gateway
Supervision:  supervise, launch, ps, stop
Coordination: msg, nudge, inbox, status, log, approval
Observation:  feed, watch, events
Inspection:   prompt, runtimes, cognition
Maintenance:  memory, sync, archive
Meta:         help, orchestrate
```

That's 28 commands across 8 categories. Too many.

---

## Identified Overlaps

### Group 1: Interactive Sessions — chat, console, orchestrate

All three load soul/config/board/memory context, build a prompt, and call an
LLM runtime.

- `chat`: single-turn LLM call with full hive context
- `console`: multi-turn interactive session with run ledger tracking
- `orchestrate`: steward prompt assembly, supports `--mode interactive|loop`

**The difference is mode, not function.** These are one command with flags.

### Group 2: Message Queueing — say, nudge, msg

- `say`: creates a goal message, auto-starts supervisor
- `nudge`: creates a nudge message from human to orchestrator
- `msg`: general message CRUD with type, from, to, body

`say` is `msg --type goal human orchestrator <body>` + auto-start.
`nudge` is `msg --type nudge human orchestrator <body>`.

### Group 3: Supervision — run, supervise

- `run`: starts detached supervisor with interval/max-parallel options
- `supervise`: full supervisor with `--once`, `--detach`, `status`, `stop`,
  `logs` subcommands

`run` is `supervise --detach` with slightly different defaults. Two commands
for the same subsystem is confusing.

### Group 4: Status/Observation — ask, status, watch, feed, events, ps

Six commands for "what's happening?" Each shows a different slice:

- `ask` (no args): fast digest of board + messages + runs
- `status`: board + open messages formatted for terminal
- `watch`: live polling console
- `feed`: recent feed entries
- `events`: event history
- `ps`: active and recent runs

These are genuinely different views, but the user shouldn't need to memorize
which shows what.

---

## Proposed Consolidated Surface

### Tier 1: Daily Commands (the front door)

These are the commands a user types every day.

```
hive run [goal]              # Start the hive. Optional goal auto-queued.
hive say <message>           # Talk to the hive (queues message, ensures running)
hive ask [question]          # What's happening? (no args = digest, with args = LLM)
hive stop [agent|run]        # Stop something (no args = stop supervision)
hive console [--runtime]     # Interactive session with the hive
hive gateway [--port]        # Web interface
```

Six commands. Memorable.

### Tier 2: Operator Commands

For when you need more control.

```
hive status                  # Detailed board + messages + runs
hive watch [--interval]      # Live polling console
hive ps                      # Process/run listing
hive msg <from> <to> <body>  # Direct message (absorbs nudge)
hive msg show|resolve|close  # Message lifecycle
hive launch <agent> [goal]   # Manual worker launch
hive log <message>           # Append to LOG.md
hive feed [count]            # Event feed
hive inbox [agent]           # Agent message queue
```

Nine commands. Each does one clear thing.

### Tier 3: Setup & Maintenance

```
hive init                    # Bootstrap ~/.hive/
hive project add <path>      # Register project
hive work [project]          # Set/show active project
hive memory                  # Memory management
hive archive                 # Archive session
hive sync                    # PLAN.md → repo
```

Six commands. Used infrequently.

### Tier 4: Inspection & Debug

```
hive prompt <agent>          # Show assembled prompt
hive runtimes                # List runtime adapters
hive cognition               # Cognitive routing policy
hive events                  # Event log
```

Four commands. Debugging tools.

**Total: 25 commands.** Down from 28+.

---

## What Gets Absorbed

| Removed     | Absorbed Into           | Rationale                                |
|-------------|-------------------------|------------------------------------------|
| `nudge`     | `msg`                   | `nudge` is `msg --type nudge human orch` |
| `chat`      | `console --once`        | Single-turn is a mode of console         |
| `orchestrate` | internal only          | Prompt assembly is not a user command    |
| `supervise` | `run` (with subcommands) | `run status`, `run logs`, `run stop`    |
| `approval`  | `msg` type or deferred  | Not wired as enforcement gate yet        |

---

## Migration: `run` Absorbs `supervise`

Today `run` is thin and `supervise` is the real implementation. Flip this:

```
hive run                     # Start supervision (current behavior)
hive run status              # Show supervisor state
hive run stop                # Stop supervisor
hive run logs                # Show supervisor logs
hive run --once              # Single supervisor pass
```

The `supervise` command becomes an alias during transition, then removed.

---

## Migration: `console` Absorbs `chat`

```
hive console                 # Interactive multi-turn session (default)
hive console --once <msg>    # Single-turn (replaces chat)
hive console --runtime X     # Runtime override (already exists)
hive console --dry-run       # Show prompt without executing
```

`chat` becomes an alias during transition, then removed.

---

## Migration: `msg` Absorbs `nudge`

```
hive msg human orchestrator "look at the tests"        # Direct message
hive msg --type nudge human orchestrator "check board"  # Explicit nudge
hive say "fix the tests"                                # Unchanged (goal + auto-start)
```

`nudge` becomes an alias for `msg --type nudge human orchestrator`.

---

## Implementation Order

1. **Add subcommands to `run`** — `run status|stop|logs` delegate to
   supervisor internals. Keep `supervise` as alias.

2. **Add `--once` to `console`** — single-turn mode using chat's prompt
   logic. Keep `chat` as alias.

3. **Absorb `nudge` into `msg`** — add `--type nudge` shorthand.
   Keep `nudge` as alias.

4. **Remove `orchestrate` from CLI routing** — keep the function for
   internal use (gateway, steward prompt building).

5. **After burn-in** — remove aliases, update help text, update CLAUDE.md.

---

## Design Rules for Future Commands

1. **Does it need top-level status?** If a command is used less than weekly,
   it should be a subcommand or flag, not a top-level command.

2. **Can the user guess it?** If you need to explain the difference between
   two commands, they should be one command.

3. **One subsystem, one command.** Supervision is `run`. Messages are `msg`.
   Sessions are `console`. Don't split a subsystem across multiple commands.

4. **Subcommands over new commands.** `run stop` not `stop-supervisor`.
   `msg resolve` not `resolve-msg`.
