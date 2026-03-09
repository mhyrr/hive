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

Available commands:

- `hive init <project> <path>`
- `hive work [project]`
- `hive status`
- `hive log <message>`
- `hive msg [--type <type>] <from> <to> <body>`
- `hive nudge <message>`
- `hive prompt <agent-id>`
- `hive archive`
- `hive sync`
- `hive help`

Not implemented yet:

- `hive chat`
- `hive curate`
- Orchestrator loop mode
- Agent launching/runtime adapters

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

### 2. Register a project

```bash
bun run bin/hive.ts init dealsplit /absolute/path/to/dealsplit
```

This will:

- create `~/.hive/` if it does not exist
- scaffold core files like `SOUL.md`, `SELF.md`, and default personas
- create `~/.hive/projects/dealsplit/`
- mark `dealsplit` as the active project

### 3. Check the active project

```bash
bun run bin/hive.ts work
```

Switch projects:

```bash
bun run bin/hive.ts work dealsplit
```

### 4. Write the mission

Edit these files in `~/.hive/projects/dealsplit/`:

- `config.md`
- `PLAN.md`
- `BOARD.md`

In Phase 1, the steward/orchestrator is still a normal agent session. HIVE
does not generate plans or run the loop for you yet.

### 5. Generate an agent prompt

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

### 6. Send messages between agents

```bash
bun run bin/hive.ts msg --type question beta alpha "Need the auth contract"
```

Send a human priority change to the orchestrator:

```bash
bun run bin/hive.ts nudge "Payments now take priority over auth"
```

### 7. View the current state

```bash
bun run bin/hive.ts status
```

This prints the active project's `BOARD.md` and all open messages for that
project.

### 8. Sync the plan into the repo

```bash
bun run bin/hive.ts sync
```

This copies the active project's `PLAN.md` into `<repo>/.hive/PLAN.md`.

### 9. Archive the session

```bash
bun run bin/hive.ts archive
```

This snapshots the active project's `config.md`, `PLAN.md`, `BOARD.md`, and
`LOG.md` into `~/.hive/archive/YYYY/MM/` and refreshes the active `LOG.md`.

## Command Guide

### `hive init <project> <path>`

Registers a repo with the hive and scaffolds all required directories and
default files on first run.

Notes:

- project names are normalized to lowercase slugs on disk
- the repo path must already exist
- the initialized project becomes the active project

### `hive work [project]`

Without arguments, prints the active project and repo path.

With a project name, switches the active project.

### `hive status`

Reads the active project's `BOARD.md` and lists open messages for that
project from `~/.hive/msg/`.

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
│       └── LOG.md
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

- [FINAL-PRD.md](./FINAL-PRD.md) for the full product requirements
- [CLAUDE.md](./CLAUDE.md) for implementation constraints and scope
- [SOUL.md](./SOUL.md) for the hive's culture document

## What Phase 1 Does Not Try To Solve

Phase 1 gives you the file model, the CLI primitives, and prompt assembly.
It does not yet give you a self-running hive.

You still need to:

- write or update `PLAN.md`
- maintain `BOARD.md` through the orchestrator workflow
- run your agents manually
- feed `hive prompt` output into those agent runtimes yourself

That is intentional. The foundation needs to be boring and reliable before
the autonomous layer sits on top of it.
