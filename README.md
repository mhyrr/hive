# HIVE

A team orchestration layer for AI coding agents. Multiple minds, different
cognitive styles, coordinating through shared files across multiple projects.

No server. No database. No daemon. No dependencies. Just markdown files
in `~/.hive/` and the conventions that make them useful.

## Why This Exists (and How It Differs from OpenClaw)

HIVE borrows good ideas from [OpenClaw](https://github.com/opensouls/openclaw):
SOUL.md, markdown-as-memory, pre-compaction flush, persistent workspace in
the home directory. These are good ideas and we use them. Acknowledging this
upfront is important.

But HIVE and OpenClaw answer fundamentally different questions.

**OpenClaw asks:** "How do I make one AI agent as capable as possible?"

**HIVE asks:** "How do I make a team of AI agents work together on real
software projects with the quality standard of a senior engineering team?"

Here's where that divergence matters:

### 1. One Mind vs Many Minds

OpenClaw is a single agent with one personality. SOUL.md defines that agent's
identity. When it delegates to sub-agents, they get stripped-down context and
run a single task — they're hands, not minds.

HIVE is a team of minds. Each agent carries the shared culture (SOUL.md) but
thinks through a different cognitive lens — a *persona*. The architect sees the
system. The craftsman sees the code. The critic sees the risks. The scout sees
the options. They don't agree. They're not supposed to.

This isn't sub-agent delegation. It's multi-perspective reasoning on the same
problem. An architect misses implementation details. A craftsman misses
system-level coupling. A critic misses the creative solution hiding behind the
risk. The output is better because no single viewpoint, no matter how capable,
catches everything.

### 2. Infrastructure vs Files

OpenClaw is a Node.js gateway: WebSocket connections, channel adapters
(WhatsApp, Discord, Telegram, Slack), session management in JSONL, message
routing through code, health monitoring, cron jobs, sandbox management.
It's a server.

HIVE is markdown files in a directory. The entire coordination layer is:
read a file, write a file. No process needs to be running for the system
state to be valid. You could shut down every agent and every terminal, come
back a week later, and the state is sitting there in `~/.hive/` waiting
for you.

This isn't minimalism for its own sake. It's a bet: agents are getting smarter
faster than infrastructure gets simpler. A year from now, frontier models won't
need structured message queues and WebSocket routing to coordinate. They'll need
a shared folder of markdown files and the judgment to coordinate themselves.
HIVE keeps the protocol as thin as possible so the intelligence stays in the
agents, not the plumbing.

### 3. Orchestrator-as-Agent vs Orchestrator-as-Code

OpenClaw's routing logic is implemented in JavaScript — functions that match
patterns, resolve sessions, dispatch messages. When you want to change how
coordination works, you change code.

HIVE's orchestrator is an LLM agent with a persona prompt (`steward.md`).
When you want it to coordinate differently, you change the prompt. When models
get smarter, the orchestrator gets smarter automatically. The steward prompt
that works with today's models will work better with whatever replaces them
next year — no code changes.

HIVE's coordination intelligence scales with model capability.
OpenClaw's coordination intelligence scales with engineering effort.

### 4. Multi-Project Memory

OpenClaw is one workspace, one agent, one memory system. It doesn't have the
concept of "I worked on MyApp this morning and I'm switching to SideProject
this afternoon."

HIVE tracks multiple projects with per-project memory, team configurations,
and context switching. Crucially, it accumulates cross-project learnings:
"this Ecto pattern worked in MyApp, apply it to SideProject." "The user always
prefers Joken over Guardian — don't ask again." The hive gets smarter across
its entire surface area, not just within one workspace.

### 5. Runtime Agnosticism

OpenClaw runs its own agent loop. Sub-agents are OpenClaw-managed sessions.
Everything lives inside the OpenClaw ecosystem.

HIVE doesn't run agents at all. It writes files that agents read. Claude Code
reads `.hive/PLAN.md`. Codex reads `.hive/PLAN.md`. Gemini CLI reads
`.hive/PLAN.md`. A bash script reads `.hive/PLAN.md`. The agent doesn't need
to know HIVE exists — it just needs to read and write markdown files.

When a new coding agent launches next month, it works with HIVE on day one.
Because it can read files. OpenClaw requires an integration, adapter, or
channel plugin.

### The Short Version

OpenClaw is a personal AI agent platform — sophisticated infrastructure for
a single agent that connects to your messaging apps, tools, and digital life.

HIVE is a team orchestration layer — multiple AI minds with different cognitive
styles, working in parallel across multiple projects, communicating through
shared files. No infrastructure. Just conventions and markdown.

---

## What It Does

HIVE separates the persistent system from the transient agents:

- **The hive persists:** identity, memory, personas, project state, history.
- **Agents are disposable:** spin them up, give them a prompt, let them work,
  shut them down.
- **Coordination happens through files:**
  - `PLAN.md` for mission
  - `BOARD.md` for live state
  - `LOG.md` for the session record
  - `msg/` for file-per-message communication

The core idea: files are the API.

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
hive init
```

This creates `~/.hive/` and scaffolds core files: `SOUL.md`, `SELF.md`,
default personas, memory directories, and the base project structure.

### 3. Make it yours

Edit these first:

- `~/.hive/SOUL.md` — the shared culture every agent carries
- `~/.hive/SELF.md` — who you are, what you care about

This is where your hive stops being a template and starts becoming yours.

### 4. Register a project

```bash
hive project add myapp /absolute/path/to/myapp
```

This creates the project workspace under `~/.hive/projects/myapp/`
with its own config, plan, board, log, and memory files.

### 5. Write the mission

Edit the files in `~/.hive/projects/myapp/`:

- `config.md` — team composition, runtime defaults
- `PLAN.md` — what you're building and how
- `BOARD.md` — current state of all work

### 6. Launch

Kick off orchestration:

```bash
hive orchestrate "Build auth"
```

Or launch a specific agent:

```bash
hive launch --runtime codex alpha
```

Or let the supervisor handle it:

```bash
hive supervise --detach --max-parallel 3
```

## How It Works

### The Team

HIVE ships with five default personas:

| Persona | Role |
|---------|------|
| **Steward** | Orchestrator. Reads the board, assigns work, resolves conflicts, maintains the plan. |
| **Architect** | System thinker. Sees boundaries, data flows, integration points. |
| **Craftsman** | Builder. Writes the code, runs the tests, ships the feature. |
| **Critic** | Reviewer. Finds risks, edge cases, quality gaps, security issues. |
| **Scout** | Researcher. Explores options, reads docs, evaluates tradeoffs. |

Each persona is a markdown file. Change them, add new ones, or remove the
ones you don't need. They're prompts, not code.

### The Flow

1. Human writes the plan and registers the project
2. `hive orchestrate` builds a steward prompt from plan + board + messages
3. The steward reads state, creates assignments, updates the board
4. `hive launch` or `hive supervise` runs workers against their assignments
5. Workers communicate through `hive msg` — questions, handoffs, status
6. `hive feed` and `hive watch` give the human a live view
7. `hive chat` lets the human talk to the hive through a runtime

### The Files

```text
~/.hive/
├── SOUL.md                    # shared culture
├── SELF.md                    # human identity
├── config.md                  # global defaults
├── feed.md                    # event stream
├── personas/
│   ├── steward.md
│   ├── architect.md
│   ├── craftsman.md
│   ├── critic.md
│   └── scout.md
├── memory/
│   ├── knowledge.md           # cross-project learnings
│   ├── decisions.md           # decision log
│   ├── projects/              # per-project memory
│   └── journal/               # session journals
├── projects/
│   └── <project>/
│       ├── config.md
│       ├── PLAN.md
│       ├── BOARD.md
│       ├── LOG.md
│       └── runs/
├── msg/                       # inter-agent messages
└── archive/                   # session snapshots
```

### Messages

Agents communicate through markdown files with simple frontmatter:

```markdown
---
from: beta
to: alpha
type: question
status: open
ts: 2026-03-09T15:08:00Z
project: myapp
---

Need the auth contract for the login form.
```

Message types: `question`, `notify`, `handoff`, `status`, `assign`,
`nudge`, `escalate`.

## Commands

### Project Management

| Command | Description |
|---------|-------------|
| `hive init` | Bootstrap `~/.hive/` with default files |
| `hive project add <name> <path>` | Register a project |
| `hive work [project]` | Show or switch active project |
| `hive status` | Print board and open messages |
| `hive sync` | Copy plan into repo at `<repo>/.hive/PLAN.md` |
| `hive archive` | Snapshot session and start fresh log |

### Orchestration

| Command | Description |
|---------|-------------|
| `hive orchestrate [goal]` | Build steward prompt; optionally record a new goal |
| `hive prompt <agent>` | Assemble full agent prompt for any persona |
| `hive launch <agent> [goal]` | Run a one-shot agent pass through a runtime |
| `hive supervise` | Auto-launch workers and steward reassessments |
| `hive supervise status` | Show detached supervisor state |
| `hive supervise stop` | Stop the detached supervisor |
| `hive ps` | Show active and recent runs |
| `hive stop <agent\|run>` | Signal an active run to stop |

### Communication

| Command | Description |
|---------|-------------|
| `hive msg <from> <to> <body>` | Send a message between agents |
| `hive msg show <id>` | Print a full message |
| `hive msg resolve <id> <actor> <answer>` | Mark resolved with answer |
| `hive msg close <id> <actor> [note]` | Close without answer |
| `hive nudge <message>` | Human-to-orchestrator priority signal |
| `hive inbox [agent]` | Check open messages for an agent |
| `hive log <message>` | Append to project log |

### Human Interface

| Command | Description |
|---------|-------------|
| `hive gateway [--open]` | Start the web UI at localhost:4200 |
| `hive gateway status` | Check if Gateway is running |
| `hive gateway stop` | Stop the Gateway |
| `hive console` | Interactive terminal session with the hive |
| `hive chat <message>` | One-shot conversation with the hive |
| `hive say <message>` | Send a message + auto-start supervision |
| `hive ask [question]` | Status digest or LLM-powered answer |
| `hive feed [count]` | Show recent high-signal events |
| `hive watch [count]` | Live operator console |
| `hive runtimes` | List installed runtime adapters |

## Design Constraints

These are deliberate:

- Zero npm dependencies
- Markdown and plain files as the data model
- No daemon or background process required
- No database
- No runtime lock-in
- If the machine restarts, the state is still there

## Development

```bash
bun test                                       # run tests
bun build --compile ./bin/hive.ts --outfile hive  # build binary
```

Environment variables:

- `HIVE_HOME` — override `~/.hive/`
- `HIVE_FIXED_NOW` — deterministic timestamps in tests

## Documentation

- [USAGE.md](./docs/USAGE.md) — practical guide to using HIVE day-to-day
- [FINAL-PRD.md](./docs/FINAL-PRD.md) — full product requirements
- [PHASE-5-GATEWAY.md](./docs/PHASE-5-GATEWAY.md) — Gateway and multi-runtime design
- [CLAUDE.md](./docs/CLAUDE.md) — implementation constraints and scope
- [SOUL.md](./templates/SOUL.md) — default hive culture template

## Current Status

Phases 1 through 5 are implemented:

- **Phase 1-2:** File model, CLI primitives, orchestration prompts
- **Phase 3:** Event feed, one-shot chat, agent launch
- **Phase 4:** Run records, supervisor with auto-launch, detached background supervision
- **Phase 5:** Multi-runtime adapters (claude/codex/gemini), Gateway web UI at localhost:4200,
  WebSocket feed streaming, persistent console sessions

Not yet implemented:

- Memory intelligence and curation automation
- External transport adapters (Slack, Discord, notifications)
