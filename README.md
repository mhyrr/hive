# HIVE

HIVE is a persistent, local-first orchestration layer for AI coding agents.
It lives in `~/.hive/`, works across projects, and uses plain markdown files
on disk as the coordination layer.

No server. No database. No daemon. If an agent can read and write files, it
can participate.

## What It Does

HIVE separates the persistent system from the transient agents:

- The hive persists: identity, memory, personas, project state, history.
- Agents are disposable: spin them up, give them a prompt, let them work,
  then shut them down.
- Coordination happens through files:
  - `PLAN.md` for mission
  - `BOARD.md` for live state
  - `LOG.md` for the session record
  - `msg/` for file-per-message communication

The core idea is simple: files are the API.

## Current Status

Phase 1 is implemented.
Phase 2 orchestration kickoff is now implemented.
Phase 3 human interaction primitives are now partially implemented.
Phase 4 now includes run records, `hive ps`, `hive stop`, worker
auto-launch through `hive supervise`, and optional detached/background
supervision control.
It also now recovers stale active runs from on-disk state, preserves
cancelled runs across supervisor restarts, and records detached supervisor
state on disk; see
[`docs/PHASE-4-AUTO-LAUNCH.md`](./docs/PHASE-4-AUTO-LAUNCH.md).

Available commands:

- `hive init`
- `hive project add <project> <path>`
- `hive work [project]`
- `hive orchestrate [--mode interactive|loop] [--interval <seconds>] [goal]`
- `hive chat [--runtime <runtime>] [--model <model>] [--dry-run] <message>`
- `hive feed [count]`
- `hive watch [count] [--interval <seconds>] [--once]`
- `hive supervise [--interval <seconds>] [--max-parallel <count>] [--once|--detach]`
- `hive supervise status`
- `hive supervise stop`
- `hive launch [--runtime <runtime>] [--model <model>] [--dry-run] <agent-id> [goal]`
- `hive ps`
- `hive stop <agent-id|run-id>`
- `hive inbox [agent]`
- `hive status`
- `hive log <message>`
- `hive msg [--type <type>] <from> <to> <body>`
- `hive msg show <message>`
- `hive msg resolve <message> <actor> <answer>`
- `hive msg close <message> <actor> [note]`
- `hive nudge <message>`
- `hive prompt <agent-id>`
- `hive archive`
- `hive sync`
- `hive help`

Not implemented yet:

- `hive curate`
- Runtime adapters beyond the first `codex` / `claude` one-shot launchers
- Broader supervision ergonomics beyond detached start/status/stop

## Why This Exists

Most multi-agent systems add infrastructure before they add leverage:
servers, databases, queues, SDKs, background processes, protocol layers.
HIVE takes the opposite position.

- Markdown is the source of truth.
- The filesystem is the message bus.
- Git can be the audit trail.
- Agents stay heterogeneous by default.

That keeps the system understandable, inspectable, and restartable. If a
session dies, the state is still on disk.

## Requirements

- [Bun](https://bun.sh/) 1.3+
- macOS or Linux shell environment

HIVE uses Bun built-ins and has zero npm dependencies.

## Quick Start

### 1. Run the CLI

From the repo:

```bash
bun run bin/hive.ts help
```

Optional: compile a standalone binary:

```bash
bun build --compile ./bin/hive.ts --outfile hive
./hive help
```

### 2. Bootstrap the hive

```bash
bun run bin/hive.ts init
```

This will:

- create `~/.hive/` if it does not exist
- scaffold core files like `SOUL.md`, `SELF.md`, and default personas
- create the base memory, persona, project, message, and archive directories

### 3. Customize the hive

After `init`, there should be a human step.

Edit these first:

- `~/.hive/SOUL.md`
- `~/.hive/SELF.md`

That is where your hive stops being a template and starts becoming yours.

### 4. Register a project

```bash
bun run bin/hive.ts project add dealsplit /absolute/path/to/dealsplit
```

This will:

- create `~/.hive/projects/dealsplit/`
- create the project config, plan, board, and log files if missing
- create `~/.hive/memory/projects/dealsplit.md` if missing
- mark `dealsplit` as the active project

### 5. Check the active project

```bash
bun run bin/hive.ts work
```

Switch projects:

```bash
bun run bin/hive.ts work dealsplit
```

### 6. Write the mission

Edit these files in `~/.hive/projects/dealsplit/`:

- `config.md`
- `PLAN.md`
- `BOARD.md`

The core file commands are still model-free. `hive orchestrate` and
`hive prompt` only assemble context. `hive chat` and `hive launch` are the
first commands that actually invoke configured runtimes.

### 7. Kick off or resume the steward

Kick off a new orchestration goal:

```bash
bun run bin/hive.ts orchestrate "Build auth"
```

Resume in loop mode:

```bash
bun run bin/hive.ts orchestrate --mode loop --interval 45
```

`hive orchestrate`:

- records a human goal as a `nudge` message when you provide one
- appends a kickoff note to `LOG.md`
- builds a steward-specific prompt
- includes derived orchestration signals like pending nudges, stale active
  agents, and old open questions

`interactive` here means human-driven single-pass mode. The CLI is not a live
console yet; it generates one steward pass worth of context and stops.

Use the output as the steward/orchestrator prompt in Claude Code, Codex,
Gemini CLI, or any other runtime.

If you want HIVE to run the steward for a one-shot pass instead of manually
copying the prompt, use:

```bash
bun run bin/hive.ts launch orchestrator "Build auth"
```

### 8. Generate an agent prompt

```bash
bun run bin/hive.ts prompt orchestrator
```

Or for a worker:

```bash
bun run bin/hive.ts prompt alpha
```

`hive prompt` assembles:

- `SOUL.md`
- `SELF.md`
- the agent persona
- hive knowledge
- project memory
- project `config.md`
- `PLAN.md`
- `BOARD.md`
- open messages addressed to that agent

This prompt is the handoff into Claude Code, Codex, Gemini CLI, or any
other runtime you want to use.

Between major steps, agents should use a lightweight inbox check instead of
reprinting the full prompt:

```bash
bun run bin/hive.ts inbox alpha
```

If you have a compiled or installed `hive` binary, the equivalent `hive inbox alpha`
works too. For self-hosting in this repo, prefer `./hive inbox alpha` after
building the local binary. The important point is to use `inbox` as the default
worker polling loop instead of reopening the full prompt or inspecting
`~/.hive/msg/` by hand.

If you are dogfooding with the repo-local `./hive` binary, rebuild it after CLI
changes or you will be testing stale behavior:

```bash
bun build --compile ./bin/hive.ts --outfile hive
```

### 9. Use the human interaction layer

Show the recent human-facing event feed:

```bash
bun run bin/hive.ts feed
```

Watch the feed live:

```bash
bun run bin/hive.ts watch
```

Talk to the hive through the configured runtime:

```bash
bun run bin/hive.ts chat --runtime codex --model gpt-5.4-medium "How's auth going?"
```

`hive chat` is the first human-facing interface over the hive files. It is
still a one-shot command, not a persistent console, but it already lets HIVE
read state, answer questions, and make file-backed changes through a runtime.

### 10. Launch an agent directly

Run a one-shot agent pass without manually copying prompts:

```bash
bun run bin/hive.ts launch --runtime codex --model gpt-5.4-medium alpha
```

Dry-run the resolved command and prompt artifact first:

```bash
bun run bin/hive.ts launch --dry-run alpha
```

### 10b. Let the supervisor launch work automatically

Run one deterministic supervisor pass:

```bash
bun run bin/hive.ts supervise --once --max-parallel 3
```

Run the foreground supervisor loop:

```bash
bun run bin/hive.ts supervise --interval 30 --max-parallel 3
```

`hive supervise` now:

- decides whether the steward needs a reassessment pass
- launches ready worker assignment messages automatically
- respects one-run-per-assignment safety
- enforces conservative scope conflict checks before parallel work
- uses `hive ps` and `hive stop` as the operational surface for live runs

### 11. Send messages between agents

```bash
bun run bin/hive.ts msg --type question beta alpha "Need the auth contract"
```

Inspect a specific message:

```bash
bun run bin/hive.ts msg show 20260309-150800-beta-to-alpha-ab12cd34
```

Resolve a message once it is answered:

```bash
bun run bin/hive.ts msg resolve 20260309-150800-beta-to-alpha-ab12cd34 alpha "Published the contract in src/api/auth.ts"
```

Close a message without a substantive answer:

```bash
bun run bin/hive.ts msg close 20260309-150800-beta-to-alpha-ab12cd34 alpha "Superseded by task 004"
```

Send a human priority change to the orchestrator:

```bash
bun run bin/hive.ts nudge "Payments now take priority over auth"
```

### 12. View the current state

```bash
bun run bin/hive.ts status
```

This prints the active project's `BOARD.md` and all open messages for that
project.

### 13. Sync the plan into the repo

```bash
bun run bin/hive.ts sync
```

This copies the active project's `PLAN.md` into `<repo>/.hive/PLAN.md`.

### 14. Archive the session

```bash
bun run bin/hive.ts archive
```

This snapshots the active project's `config.md`, `PLAN.md`, `BOARD.md`, and
`LOG.md` into `~/.hive/archive/YYYY/MM/` and refreshes the active `LOG.md`.

## Command Guide

### `hive init`

Bootstraps the hive home at `~/.hive/` and writes the default hive files if
they do not already exist.

This command is intentionally hive-scoped, not project-scoped.

Recommended next step:

- edit `~/.hive/SOUL.md`
- edit `~/.hive/SELF.md`
- then register a project with `hive project add <project> <path>`

### `hive project add <project> <path>`

Registers a repo with the hive and scaffolds the project-specific files.

Notes:

- project names are normalized to lowercase slugs on disk
- the repo path must already exist
- the registered project becomes the active project

### `hive work [project]`

Without arguments, prints the active project and repo path.

With a project name, switches the active project.

### `hive orchestrate [--mode interactive|loop] [--interval <seconds>] [goal]`

Builds the steward/orchestrator prompt for the active project.

Behavior:

- if `goal` is provided, HIVE records it as a `nudge` to `orchestrator`
- `interactive` mode is the default, but it is a human-driven single-pass
  prompt build, not a live terminal session
- `loop` mode tells the steward to re-read state and continue after the
  given interval
- if no goal is provided, the command resumes current state without adding
  new messages or log entries

This is the Phase 2 orchestration entrypoint.

### `hive chat [--runtime <runtime>] [--model <model>] [--dry-run] <message>`

Runs a one-shot human-facing hive session against the active project.

Notes:

- uses the hive's global `runtime:` and `model:` as defaults
- `--runtime` and `--model` override those defaults per invocation
- `--dry-run` writes the prompt artifact and shows the resolved launch command
- this is a non-persistent chat entrypoint today, not the final long-running console

### `hive feed [count]`

Prints the most recent high-signal entries from `~/.hive/feed.md`.

### `hive watch [count] [--interval <seconds>] [--once]`

Renders a live operator console for the active project.

It shows:

- detached supervisor state
- active agent count
- active runs with task/source/scope
- the last visible runtime output lines captured for each active run
- recent completed runs
- recent high-signal feed entries

Notes:

- `count` controls how many output/feed lines are shown per section
- `--interval` controls refresh cadence; default is 2 seconds
- `--once` renders one snapshot and exits
- this is not hidden model chain-of-thought; it only shows visible runtime output HIVE can observe

### `hive launch [--runtime <runtime>] [--model <model>] [--dry-run] <agent-id> [goal]`

Runs a one-shot agent pass by combining the existing prompt assembly with a
runtime adapter.

Notes:

- for workers, it uses `hive prompt <agent-id>`
- for `orchestrator`, it uses `hive orchestrate [goal]`
- the first launcher adapters target `codex` and `claude`
- actual launches now write run records under `~/.hive/projects/<project>/runs/`
- it refuses duplicate launches for an agent that already has an active run
- `--dry-run` shows the resolved command and writes the prompt artifact without invoking a model

### `hive supervise [--interval <seconds>] [--max-parallel <count>] [--once|--detach]`

Runs the Phase 4 supervisor loop.

Notes:

- `--once` performs a single deterministic assessment cycle and stops
- without `--once`, it loops and sleeps between passes
- `--detach` starts the supervisor in the background and returns immediately
- `--max-parallel` limits concurrent worker launches per project
- it launches `orchestrator` when the trigger rules say yes
- it launches ready worker assignments automatically when launch mode and scope rules allow it
- one open assignment triggers at most one automatic launch attempt until the steward reassigns or retries it
- on startup or each tick, it reconciles stale `runs/active/` entries against live pids and recovers dead runs into failed/cancelled results
- detached mode records supervisor state in `~/.hive/projects/<project>/supervisor/detached.md` and appends output to `~/.hive/projects/<project>/supervisor/detached.log`

### `hive supervise status`

Shows the active project's detached supervisor state.

Notes:

- reads `~/.hive/projects/<project>/supervisor/detached.md`
- reconciles stale pids before printing status
- reports the detached supervisor pid, last pass timestamp, and log path

### `hive supervise stop`

Stops the active project's detached supervisor with `SIGTERM`.

Notes:

- only targets the detached supervisor control record, not worker runs
- marks the detached supervisor as `stopping` before signaling it
- the detached child writes a final `stopped` state on exit

### `hive ps`

Shows the active project's run ledger.

Notes:

- lists active runs from `~/.hive/projects/<project>/runs/active/`
- shows recent completed or failed runs from the archived run tree
- recent run results are also fed back into steward prompt assembly for reassessment

### `hive stop <agent-id|run-id>`

Signals an active supervised run with `SIGTERM`.

Notes:

- accepts either an active agent id or a unique run id / prefix
- records the stop request in `feed.md` and `LOG.md`
- records the cancellation intent durably so a later supervisor pass can recover it as `cancelled` if the owning launcher disappears before finalization

### `hive status`

Reads the active project's `BOARD.md` and lists open messages for that
project from `~/.hive/msg/`.

### `hive inbox [agent]`

Shows the open message queue for the active project.

Notes:

- with no argument, it prints all open project messages
- with an agent id, it prints just that agent's open inbox
- this is the intended lightweight polling command for workers between major
  steps
- it now reports the open count, says when the queue is clean, and reminds the
  worker how to `show`, `resolve`, or `close` messages without manual file work

### `hive log <message>`

Appends a timestamped entry to the active project's `LOG.md`.

### `hive msg [--type <type>] <from> <to> <body>`

Creates a message file in `~/.hive/msg/`.

Default type is `notify`.

Useful types include:

- `question`
- `notify`
- `handoff`
- `status`
- `assign`
- `nudge`
- `escalate`

### `hive msg show <message>`

Prints the full raw message file for the active project.

You can reference the message by full filename, filename without `.md`, or a
unique prefix.

### `hive msg resolve <message> <actor> <answer>`

Marks a message as `resolved`, timestamps it, and appends an `Answer` section
to the message body. Resolved messages disappear from `hive inbox` and
`hive status`.

### `hive msg close <message> <actor> [note]`

Marks a message as `closed`, timestamps it, and optionally appends a closing
note. Closed messages also leave the open queue immediately.

### `hive nudge <message>`

Shortcut for a human-to-orchestrator message of type `nudge`.

### `hive prompt <agent-id>`

Builds the full agent prompt for the active project. This is the most
important command in Phase 1.

Agent resolution order:

1. Match the agent in `PLAN.md`
2. Fall back to the project's default team in `config.md`

### `hive sync`

Copies the active project's `PLAN.md` into the tracked repo at
`<repo>/.hive/PLAN.md`.

### `hive archive`

Writes a session snapshot into `~/.hive/archive/YYYY/MM/` and starts a fresh
`LOG.md` for the active project.

## Directory Layout

After the first `hive init`, the hive home looks like this:

```text
~/.hive/
├── SOUL.md
├── SELF.md
├── config.md
├── feed.md
├── active-project.txt
├── personas/
│   ├── architect.md
│   ├── craftsman.md
│   ├── critic.md
│   ├── scout.md
│   └── steward.md
├── memory/
│   ├── knowledge.md
│   ├── decisions.md
│   ├── personas/
│   ├── projects/
│   └── journal/
├── projects/
│   └── <project>/
│       ├── config.md
│       ├── PLAN.md
│       ├── BOARD.md
│       ├── LOG.md
│       └── runs/
├── msg/
└── archive/
```

## Message Format

Messages are markdown files with simple frontmatter:

```markdown
---
from: beta
to: alpha
type: question
status: open
ts: 2026-03-09T15:08:00Z
project: dealsplit
---

Need the auth contract for the login form.
```

This keeps them readable by both humans and agents.

## Design Constraints

The current implementation is deliberately conservative:

- zero npm dependencies
- markdown and plain files as the data model
- no daemon or background process
- no database
- no runtime lock-in

That constraint is useful for the core. It keeps HIVE inspectable and easy
to recover. If the machine restarts, the state is still there.

## Development

Run tests:

```bash
bun test
```

Build the binary:

```bash
bun build --compile ./bin/hive.ts --outfile hive
```

Useful environment variables:

- `HIVE_HOME` to override `~/.hive/`
- `HIVE_FIXED_NOW` for deterministic timestamps in tests

## Read More

- [FINAL-PRD.md](./docs/FINAL-PRD.md) for the full product requirements
- [PHASE-4-AUTO-LAUNCH.md](./docs/PHASE-4-AUTO-LAUNCH.md) for the Phase 4 supervisor and auto-launch design
- [CLAUDE.md](./docs/CLAUDE.md) for implementation constraints and scope
- [NEXT-SESSION-PROMPT.md](./docs/NEXT-SESSION-PROMPT.md) for the current continuity brief and next-session prompt
- [SOUL.md](./templates/SOUL.md) for the default hive culture template

## What HIVE Still Does Not Solve

Phase 1 through the current Phase 3 slice give you the file model, CLI
primitives, orchestration prompts, the event feed, one-shot chat, and
one-shot agent launch. They still do not give you a self-running hive.

You still need to:

- decide when to run the steward again
- decide when to launch workers
- let the steward maintain `PLAN.md` and `BOARD.md`
- accept that launches are one-shot passes, not supervised long-running sessions

That is intentional. The foundation needs to be boring and reliable before
the autonomous layer sits on top of it.
