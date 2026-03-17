# HIVE

HIVE is a file-native orchestration layer for AI coding agents.

It gives you:

- a persistent hive substrate in `~/.hive/`
- a steward that coordinates work
- a disposable worker fleet with different personas
- runtime-agnostic execution across Claude, Codex, Gemini, and future CLIs
- a gateway UI for live leadership, history, and operations

The core bet is simple: files are the API. Durable state lives in markdown and
JSON under `~/.hive/`; agents are replaceable.

![HIVE Gateway](hive.png)

## What HIVE Is

HIVE is not a monolithic agent runtime. It is a shared operating surface for a
team of minds.

- The **steward** owns direction, synthesis, routing, and continuity.
- **Workers** are disposable specialists: architect, craftsman, critic, scout,
  or whatever personas you define.
- The **hive substrate** persists identity, memory, plans, board state,
  messages, runs, and sessions.
- The **gateway** is a live operator console over the same substrate.

That separation matters:

- prompts and files define coordination behavior
- runtimes can change without rewriting the system
- process restarts do not erase the hive's memory or state

## Why Files

HIVE keeps coordination in inspectable artifacts instead of hidden runtime
state.

- `PLAN.md` defines the mission
- `BOARD.md` tracks live work and blockers
- `LOG.md` records durable session history
- `msg/*.md` is the message bus
- `memory/` accumulates cross-project learning
- `projects/<project>/state/` holds disposable derived state

If everything stops, the hive is still there on disk.

## Quick Start

## 1. Run the CLI

From the repo:

```bash
bun run bin/hive.ts help
```

Optional standalone binary:

```bash
bun build --compile ./bin/hive.ts --outfile hive
./hive help
```

## 2. Bootstrap the hive

```bash
hive init
```

This scaffolds `~/.hive/` with:

- `SOUL.md`
- `IDENTITY.md`
- `SELF.md`
- default personas
- default skills
- memory directories
- the global config and feed

## 3. Make it yours

Edit these first:

- `~/.hive/SOUL.md`
- `~/.hive/IDENTITY.md`
- `~/.hive/SELF.md`

This is the durable shared culture and relationship model every agent carries.

## 4. Register a project

```bash
hive project add myapp /absolute/path/to/myapp
```

That creates `~/.hive/projects/myapp/` and activates the project.

## 5. Define the mission

Edit:

- `~/.hive/projects/myapp/config.md`
- `~/.hive/projects/myapp/PLAN.md`
- `~/.hive/projects/myapp/BOARD.md`

## 6. Start operating

```bash
hive gateway --open
```

or

```bash
hive orchestrate "Build auth"
```

or

```bash
hive console
```

## Mental Model

### The Hive

The hive is the durable operating system:

- soul
- identity
- user preferences
- memory
- projects
- sessions
- feed
- messages

### The Steward

The steward is the head of the hive:

- talks to the human
- maintains continuity
- updates plan and board state
- delegates to workers
- synthesizes results
- routes cognitive depth

### The Workers

Workers are transient runs with scoped assignments:

- architecture
- implementation
- critique
- research

They read the same substrate, do their work, report back, and exit.

## Cognitive Routing

HIVE now has a first-class cognitive routing policy surface.

The steward should choose the cheapest cognition likely to improve the answer:

1. **Direct answer**  
   Answer from compact state or fresh worker output when extra depth is
   unlikely to change the result.

2. **Targeted inspection**  
   Read the exact missing files, runs, or facts that could change the answer.

3. **Plural synthesis**  
   Fan out to distinct perspectives only when ambiguity, stakes, or trade-offs
   justify it.

The policy is inspectable:

```bash
hive cognition
```

It now reports:

- the active session lane when a live steward session exists
- the default lane when no session is active
- tier-1 local/cloud preferences
- per-project tier usage and budget status when a live project is in focus
- discovered Ollama models at the configured base URL

Config knobs:

```md
cognitive-bias: balanced
cognitive-max-fanout: 2
cognitive-max-parallel: 2
cognitive-window-hours: 24
cognitive-budget-tier1-tokens: 50000
cognitive-budget-tier2-tokens: 200000
cognitive-budget-tier3-tokens: 50000
cognitive-budget-warn-ratio: 0.9
tier1_local: qwen3:4b
tier1_cloud: haiku
tier1_cloud_provider: anthropic
tier1_cloud_model: claude-haiku-4-5-20251001
tier1_fallback: haiku
tier1_fallback_provider: anthropic
tier1_fallback_model: claude-haiku-4-5-20251001
ollama-base-url: http://127.0.0.1:11434
```

### Runtime Lanes

HIVE separates direct runtime lanes from Pi-backed session lanes.

- Claude has an implicit Pi route and defaults to the Anthropic OAuth lane.
- Codex defaults to a direct CLI-backed lane unless you explicitly set
  `pi-provider-codex`.
- Gemini defaults to a direct CLI-backed lane unless you explicitly set
  `pi-provider-gemini`.

Inspect current runtime policy with:

```bash
hive runtimes
```

## Gateway

The gateway is the live UI over the same hive substrate.

It provides:

- persistent console sessions
- live active-agent view
- process log inspection
- leadership queue and timeline surfaces
- session history and steering
- a cognition panel that exposes routing policy, active execution lane, local-model discovery, and rolling tier usage
- a topbar tier-3 budget chip with a dropdown breakdown by tier
- per-turn model/tier routing chips plus route traces in the detail modal
- conservative front-door routing for console turns:
  - tier-0 deterministic answers for obvious status, project, runtime, and time queries
  - tier-1 local/cloud preprocessing for short context-bound questions
  - steward escalation when the preprocessor says the turn still needs depth

### Local Tier-1 Setup

If you want to prepare the small-model lane now, use Ollama and pull one or both
starter models:

```bash
ollama pull qwen3:4b
ollama pull gemma3:4b
```

Then add one of them to `~/.hive/config.md`:

```md
tier1_local: qwen3:4b
tier1_cloud: haiku
tier1_cloud_provider: anthropic
tier1_cloud_model: claude-haiku-4-5-20251001
tier1_fallback: haiku
tier1_fallback_provider: anthropic
tier1_fallback_model: claude-haiku-4-5-20251001
ollama-base-url: http://127.0.0.1:11434
```

Verify with:

```bash
hive cognition
```

The current cognition surface will show whether Ollama is reachable and which
models are present. When `tier1_local` is set, completed non-steward worker
runs are compressed through that local model, and short console questions can
be preprocessed through the same tier-1 lane before the steward wakes. When
`tier1_cloud_*` is explicitly configured, HIVE can fall back to Haiku through
`pi-ai` for both worker compression and message preprocessing.

To try a persistent steward on Haiku instead of the default Claude route:

```md
pi-provider-claude: anthropic
pi-model-claude: claude-haiku-4-5-20251001
pi-auth-anthropic: env
```

Then start a fresh steward session or switch the live session runtime/model so
the active session stops using the older lane.

References:

- [Ollama API tags](https://docs.ollama.com/api/tags)
- [Ollama library: qwen3](https://ollama.com/library/qwen3)
- [Ollama library: gemma3](https://ollama.com/library/gemma3)

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
│       ├── config.md
│       ├── PLAN.md
│       ├── BOARD.md
│       ├── LOG.md
│       ├── runs/
│       ├── supervisor/
│       └── state/
├── msg/
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

### Steward / Human Interface

| Command | Purpose |
| --- | --- |
| `hive gateway [--open]` | Start the web UI |
| `hive console` | Interactive steward session |
| `hive chat <message>` | One-shot steward turn |
| `hive ask [question]` | Fast digest or answer |
| `hive say <message>` | Send a message and kick supervision |
| `hive orchestrate [goal]` | Build an orchestrator/steward pass |

### Workers / Supervision

| Command | Purpose |
| --- | --- |
| `hive launch <agent>` | Run a worker once |
| `hive supervise` | Detached/background auto-launch loop |
| `hive supervise status` | Show detached supervisor state |
| `hive supervise stop` | Stop the detached supervisor |
| `hive ps` | Show active and recent runs |
| `hive stop <agent\\|run>` | Stop an active run |

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

### Policy / Inspection

| Command | Purpose |
| --- | --- |
| `hive status` | Current board + open-message status |
| `hive feed [count]` | High-signal event stream |
| `hive watch [count]` | Live operator console |
| `hive prompt <agent>` | Assemble the full prompt for an agent |
| `hive runtimes` | Show runtime and Pi lane policy |
| `hive cognition` | Show cognitive routing policy |

### Memory / Maintenance

| Command | Purpose |
| --- | --- |
| `hive memory` | Show project memory |
| `hive memory fact|convention|decision|question <text>` | Append memory |
| `hive memory extract` | Rebuild derived memory state |
| `hive sync` | Copy plan into the repo |
| `hive archive` | Snapshot and roll the session |

## Configuration

Global config lives at `~/.hive/config.md`.

Example:

```md
runtime: claude
model: claude-sonnet-4-6

direct-auth-claude: subscription
direct-auth-codex: cli
direct-auth-gemini: cli

pi-provider-claude: anthropic
pi-model-claude: claude-sonnet-4-6
pi-auth-anthropic: oauth-only

cognitive-bias: balanced
cognitive-max-fanout: 2
cognitive-max-parallel: 2
tier1_local: qwen3:4b
tier1_cloud: haiku
tier1_cloud_provider: anthropic
tier1_cloud_model: claude-haiku-4-5-20251001
tier1_fallback: haiku
tier1_fallback_provider: anthropic
tier1_fallback_model: claude-haiku-4-5-20251001
ollama-base-url: http://127.0.0.1:11434
```

## Requirements

- [Bun](https://bun.sh/) 1.3+
- macOS or Linux shell environment

Optional, depending on how you run workers and steward turns:

- `claude`
- `codex`
- `gemini`
- `pi` for persistent steward sessions
- `ollama` for local tier-1 discovery and execution
- Anthropic credentials if you want Haiku via `pi-ai`

## Development

```bash
bun test
bun build --compile ./bin/hive.ts --outfile hive
```

Useful environment variables:

- `HIVE_HOME` — override `~/.hive/`
- `HIVE_FIXED_NOW` — deterministic timestamps in tests
- `HIVE_ENABLE_PERSISTENT_STEWARD=1` — enable Pi-backed persistent steward path

## Current Status

Implemented:

- file-native hive substrate
- steward/orchestrator prompts
- disposable worker runs
- detached supervisor
- runtime adapters for Claude, Codex, and Gemini
- gateway web UI
- persistent steward path via Pi
- inspectable runtime lane policy
- inspectable cognitive routing policy
- local tier-1 config, discovery, and worker-output compression
- front-door tier-0/tier-1 console routing for deterministic status/meta replies and conservative simple-query preprocessing
- Pi-backed cloud tier-1 route via `pi-ai`
- per-turn routing telemetry in the console
- rolling usage and budget tracking in `/api/cognition` and the gateway

Still to do:

- diff triage for steward-worthiness
- idle log and memory compression / curation
- migrate the persistent steward off the external `pi` CLI and onto the in-process Pi dependency
- external transport adapters

## Further Reading

- [docs/USAGE.md](./docs/USAGE.md)
- [docs/PERSISTENT-STEWARD-DESIGN.md](./docs/PERSISTENT-STEWARD-DESIGN.md)
- [docs/COGNITIVE-RESOURCE-MANAGEMENT.md](./docs/COGNITIVE-RESOURCE-MANAGEMENT.md)
- [docs/PHASE-5-GATEWAY.md](./docs/PHASE-5-GATEWAY.md)
- [templates/SOUL.md](./templates/SOUL.md)
- [templates/IDENTITY.md](./templates/IDENTITY.md)
- [templates/SELF.md](./templates/SELF.md)
