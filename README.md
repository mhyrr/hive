# HIVE

HIVE is a file-native orchestration layer for AI agent swarms.

It gives you:

- a persistent hive substrate in `~/.hive/`
- a steward that coordinates work and talks to the human
- an ephemeral worker fleet with cognitive personas across any model
- event-driven coordination with ~200ms handoffs
- runtime-agnostic execution across Claude, Codex, Gemini, Ollama, and future CLIs
- a gateway UI for live observation and steering

The core bet: files are the API. Durable state lives in markdown under
`~/.hive/`; agents are ephemeral and replaceable.

![HIVE Gateway](hive.png)

## What HIVE Is

HIVE is a shared operating surface for a team of minds, not a monolithic agent
runtime.

- The **steward** owns direction, synthesis, delegation, and human communication.
  It runs as a persistent session and coordinates everything.
- **Workers** are ephemeral specialists. The steward picks a model and persona
  for each task from a pool. No fixed roster, no named agents.
- The **hive substrate** persists identity, memory, plans, board state,
  messages, runs, and sessions across restarts.
- The **gateway** is a live operator console over the same substrate.

Because of that separation:

- prompts and files define coordination behavior
- runtimes can change without rewriting the system
- process restarts do not erase the hive's memory or state
- the steward picks the right model for each task dynamically

## Why Files

HIVE keeps coordination in inspectable artifacts instead of hidden runtime
state.

- `PLAN.md` defines the mission
- `BOARD.md` tracks live work and blockers
- `LOG.md` records durable session history
- `msg/*.md` is the message bus; assignment files trigger worker launches
- `memory/` accumulates cross-project learning
- `projects/<project>/state/` holds disposable derived state

If everything stops, the hive is still there on disk.

## Quick Start

### 1. Build the CLI

```bash
bun build --compile ./bin/hive.ts --outfile hive
./hive help
```

Or run directly: `bun run bin/hive.ts help`

### 2. Bootstrap the hive

```bash
hive init
```

This scaffolds `~/.hive/` with:

- `SOUL.md`, shared culture and standards
- `IDENTITY.md`, what the hive is
- `SELF.md`, user preferences
- default personas (steward, architect, craftsman, critic, scout)
- default skills
- memory directories
- the global config and feed

### 3. Make it yours

Edit these first:

- `~/.hive/SOUL.md`, shared values every agent carries
- `~/.hive/IDENTITY.md`, who the hive is
- `~/.hive/SELF.md`, who you are and how you work

### 4. Register a project

```bash
hive project add myapp /absolute/path/to/myapp
```

### 5. Configure your model pool

Edit `~/.hive/config.md` and define available models:

```md
## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse
- haiku: claude, claude-haiku-4-5-20251001, fast triage
- gpt54: codex, gpt-5.4, OpenAI frontier
- qwen: ollama, qwen3:4b, local fast triage
```

The model pool is hive-wide, available to all projects. The steward sees
this pool and picks model + persona per task. No fixed team roster.

### 6. Start operating

```bash
hive start --open
```

This starts the gateway (web UI), managed supervisor, and file watchers.
Open the console and talk to the steward.

Or from the terminal:

```bash
hive say "build the auth system"
hive console
```

## The Core Loop

```
Human speaks
  → Steward responds immediately (warm persistent session)
  → If work needed: steward writes assignment message to msg/
  → File watcher fires (~200ms) → dispatch → worker launches
  → Worker completes → run watcher fires (~200ms) → notification queued
  → Next steward turn drains notifications → synthesizes → responds
  → Loop continues
```

Coordination is event-driven through file system watchers. The supervisor
poll (120s) is only a safety net for zombie cleanup.

## Ephemeral Workers

Workers are ephemeral model+persona combinations that the steward creates on
demand.

The steward writes an assignment file:

```md
---
from: steward
to: craftsman-opus-001
type: assign
project: myapp
task: AUTH-001
persona: craftsman
runtime: claude
model: claude-opus-4-6
scope: src/auth/
launch: auto
---

Implement POST /api/auth/login with JWT tokens.
```

The watcher detects the file, the supervisor launches the worker, the worker
runs with the craftsman persona on opus, completes, and the steward gets
notified.

Available personas:
- **architect**: system design, structure, trade-offs
- **craftsman**: implementation, code quality
- **critic**: review, edge cases, testing
- **scout**: research, exploration, alternatives

## Mental Model

### The Hive

The durable operating system:

- soul, identity, user preferences
- memory (knowledge, decisions, entities)
- projects, sessions, feed, messages

### The Steward

The persistent coordinator:

- talks to the human
- maintains session continuity
- picks models and personas for each task
- delegates through assignment messages
- synthesizes worker results
- auto-wakes when workers complete (silent when nothing new)

### The Workers

Ephemeral runs with scoped assignments:

- spawned from the model pool with a persona
- read the substrate, do their work, report back, exit
- any runtime: Claude, Codex, Gemini, Ollama

## Gateway

The gateway is the live UI over the hive substrate.

```bash
hive start --open
```

It provides:

- persistent console sessions with the steward
- live active-agent view with persona and model info
- process log inspection
- session history and timeline
- cognition panel (routing policy, execution lane, budget tracking)

Screens:

![Console session with the steward](hive1.png)

![Process logs and run details](hive2.png)

![Multiple agent types working together](hive_multi.png)

## File Layout

```text
~/.hive/
├── SOUL.md
├── IDENTITY.md
├── SELF.md
├── AGENTS.md
├── TRUST.md
├── config.md
├── feed.md
├── personas/
├── skills/
├── memory/
│   ├── knowledge.md
│   ├── decisions.md
│   ├── projects/
│   ├── journal/
│   ├── entities/
│   └── state/
├── projects/
│   └── <project>/
│       ├── config.md        # model pool, rules, stack
│       ├── PLAN.md
│       ├── BOARD.md
│       ├── LOG.md
│       ├── runs/
│       ├── supervisor/
│       └── state/
├── msg/                     # assignment messages trigger worker launches
├── sessions/
├── approvals/
├── events/
└── archive/
```

## Core Commands

### Setup

| Command | Purpose |
| --- | --- |
| `hive init` | Scaffold `~/.hive/` |
| `hive project add <name> <path>` | Register a project |
| `hive work [project]` | Show or switch the active project |

### Human Interface

| Command | Purpose |
| --- | --- |
| `hive start [--open]` | Start gateway + managed supervisor |
| `hive console` | Interactive steward session |
| `hive say <message>` | One-shot steward turn |

### Workers / Supervision

| Command | Purpose |
| --- | --- |
| `hive launch <agent>` | Run a worker manually |
| `hive supervise` | Background auto-launch loop |
| `hive supervise status` | Show supervisor state |
| `hive supervise stop` | Stop the supervisor |
| `hive ps` | Show active and recent runs |
| `hive stop <agent\|run>` | Stop an active run |

### Coordination

| Command | Purpose |
| --- | --- |
| `hive msg <from> <to> <body>` | Create a message |
| `hive msg show <id>` | Show a message |
| `hive msg resolve <id> <actor> <answer>` | Resolve a thread |
| `hive msg close <id> <actor> [note]` | Close a thread |
| `hive inbox [agent]` | Show open messages |
| `hive nudge <message>` | Human priority signal |
| `hive log <message>` | Append durable project log |

### Inspection

| Command | Purpose |
| --- | --- |
| `hive status` | Current board + open-message status |
| `hive feed [count]` | High-signal event stream |
| `hive watch [count]` | Live operator console |
| `hive prompt <agent>` | Assemble the full prompt for an agent |
| `hive runtimes` | Show runtime adapters |
| `hive cognition` | Show cognitive routing policy |

### Memory / Maintenance

| Command | Purpose |
| --- | --- |
| `hive memory` | Show project memory |
| `hive memory fact\|convention\|decision\|question <text>` | Append memory |
| `hive memory extract` | Rebuild derived memory state |
| `hive sync` | Copy plan into the repo |
| `hive archive` | Snapshot and roll the session |

## Configuration

### Global config: `~/.hive/config.md`

```md
runtime: claude
model: claude-sonnet-4-6

pi-provider-claude: anthropic
pi-model-claude: claude-sonnet-4-6
pi-auth-anthropic: oauth-only

cognitive-bias: balanced
cognitive-max-fanout: 4
cognitive-max-parallel: 3
tier1_local: qwen3:4b
ollama-base-url: http://127.0.0.1:11434
```

### Project config: `~/.hive/projects/<project>/config.md`

```md
path: /absolute/path/to/repo

## Rules
- All database changes require a migration file.
- Tests must pass before any task is marked done.
```

## Requirements

- [Bun](https://bun.sh/) 1.3+
- macOS or Linux shell environment

Optional, depending on your model pool:

- `claude` CLI for Claude models
- `codex` CLI for OpenAI models and Ollama routing
- `gemini` CLI for Gemini models
- `ollama` for local models (routed through codex with `--oss`)

## Development

```bash
bun test
bun build --compile ./bin/hive.ts --outfile hive
```

Environment variables:

- `HIVE_HOME`: override `~/.hive/`
- `HIVE_FIXED_NOW`: deterministic timestamps in tests

## Current Status

Implemented:

- file-native hive substrate
- persistent steward session via Pi-agent SDK
- ephemeral model pool (steward picks model+persona per task)
- event-driven coordination with file watchers (~200ms handoffs)
- auto-wake steward on worker completion (silent when nothing new)
- runtime adapters for Claude, Codex, Gemini, and Ollama
- gateway web UI with live agent view
- disposable worker runs with persona assignment
- cognitive routing policy surface

Still to do:

- gateway UI updates for ephemeral worker display
- idle log and memory compression
- external event integration
- IDENTITY.md / steward persona separation

## Further Reading

- [docs/CORE-LOOP-CONSOLIDATION.md](./docs/CORE-LOOP-CONSOLIDATION.md)
- [docs/USAGE.md](./docs/USAGE.md)
- [docs/PERSISTENT-STEWARD-DESIGN.md](./docs/PERSISTENT-STEWARD-DESIGN.md)
- [docs/COGNITIVE-RESOURCE-MANAGEMENT.md](./docs/COGNITIVE-RESOURCE-MANAGEMENT.md)
- [docs/PHASE-5-GATEWAY.md](./docs/PHASE-5-GATEWAY.md)
- [docs/FINAL-PRD.md](./docs/FINAL-PRD.md)
