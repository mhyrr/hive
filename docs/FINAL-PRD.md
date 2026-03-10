# HIVE: Local Multi-Agent Orchestration

## Product Requirements Document — Final

---

## What This Is

A persistent, local-first orchestration layer for heterogeneous AI coding
agents. HIVE lives at `~/.hive/` on your machine. It works across multiple
projects. Agents are transient — spun up for a task, torn down when done.
The hive itself persists: its memory, its personas, its soul.

Everything is markdown files on disk. No servers. No databases. Any agent
that can read and write files is on the team.

---

## Core Concepts

### The Hive Is a Persistent Entity
HIVE isn't project-scoped. It lives in your home directory and works on
many projects. When it works on DealSplit, it loads that project's context.
When it switches to Matreas, it loads that one. Memory, personas, and
identity carry across everything.

### Agents Are Transient
Agents are spun up for a session and torn down when done. They have no
persistent state of their own — they read the hive's files on startup and
write results back before shutdown. Any learnings go into the hive's memory,
not the agent's.

### Two Speeds of Communication
- **Slow lane** (PLAN.md, BOARD.md, LOG.md): shared state, visibility, handoffs
- **Fast lane** (.hive/msg/): file-per-message, agents check between tool calls

### BOARD.md Is Orchestrator-Owned
Agents never write to BOARD.md. They post messages to msg/ and the
orchestrator updates the board. One writer, zero contention.

### Personas Are Mindsets, Not Job Titles
"Craftsman scoped to backend" is more powerful than "backend developer."
Personas define how an agent thinks. Domain scoping defines where it works.

### Small Models Coordinate, Big Models Create
The orchestrator loop, hive chat, message routing, and memory curation
can run on a local 8B model. The expensive models do the actual coding.

### `hive chat` Is the Meta-Interface
Talk to the hive about itself. Create personas, configure teams, query
memory, adjust behavior — conversationally.

---

## Directory Structure

```
~/.hive/
├── SOUL.md                      # Culture: how we think, what we value
├── SELF.md                      # Identity: who we serve, their preferences
├── config.md                    # Global config: hive mind model, defaults
│
├── personas/                    # Mindsets (reusable across projects)
│   ├── architect.md
│   ├── craftsman.md
│   ├── critic.md
│   ├── scout.md
│   └── steward.md
│
├── memory/
│   ├── knowledge.md             # Curated cross-project durable facts
│   ├── decisions.md             # Architecture decisions (append-only)
│   ├── projects/                # Per-project learnings
│   │   ├── dealsplit.md
│   │   └── matreas.md
│   ├── personas/                # Per-persona accumulated learnings
│   │   ├── craftsman.md
│   │   └── architect.md
│   └── journal/                 # Daily append-only logs
│       └── 2026/
│           └── 03/
│               ├── 09.md
│               └── 10.md
│
├── projects/                    # Active projects
│   └── {name}/
│       ├── config.md            # Repo path, default team, project rules
│       ├── PLAN.md              # Current mission
│       ├── BOARD.md             # Current state (orchestrator-owned)
│       └── LOG.md               # Current session log
│
├── msg/                         # Fast lane: one file per message
│
└── archive/                     # Past sessions
    └── 2026/
        └── 03/
```

Everything in one place. No split brain. Projects are subdirectories
with a path reference to the repo on disk.

---

## Core Files

### SOUL.md
The hive's culture. Injected into every agent's context, always first.
Not instructions — identity. Ships as a default, user customizes.
(See standalone SOUL.md artifact.)

### SELF.md
Who the hive serves. The user's preferences, working style, values.
```markdown
# Self

## Who I Serve
Greg — founder, builder-behind-experts. 20+ years software development.

## Preferences
- Elixir/Phoenix for backend. React for frontend when needed.
- PostgreSQL always.
- Minimal dependencies. If the standard library can do it, use it.
- Direct analysis. No hedging, no "it depends" without a follow-up.
- Prefers depth over breadth. Get one thing right.
- Serious about code quality but pragmatic about shipping.

## Communication Style
- Unvarnished. Say what you think.
- Skip the preamble. Lead with the insight.
- If something is wrong, say it's wrong. Don't soften.

## Working Patterns
- Often works across DealSplit and Matreas in the same day.
- Likes to set direction and let agents execute.
- Nudges via quick messages, not long briefings.
- Values the overnight build: set up work in the evening, review in morning.
```

### Project config.md
Per-project configuration.
```markdown
# Project: DealSplit

## Repo
path: /Users/greg/code/dealsplit

## Stack
Elixir/Phoenix 1.8, PostgreSQL 16, React 19, Vite

## Default Team
- orchestrator: steward, claude-opus-4 via claude-code
- alpha: craftsman (backend), claude-sonnet-4 via claude-code
- beta: craftsman (frontend), codex
- gamma: critic, claude-opus-4 via claude-code

## Rules
- Multi-tenant by brokerage_id on all tables
- API-only backend, no server-rendered HTML
- JWT auth via Joken
```

### PLAN.md
The current mission for a project. Written by the orchestrator after
the human gives a goal. Read by every agent at session start.
```markdown
# Plan: User Authentication

## Goal
JWT-based auth for the API + login form for the frontend.

## Agents

### orchestrator (steward, claude-opus-4)
Decomposes, assigns, monitors, adjusts.

### alpha (craftsman → src/api/**, src/db/**)
Task: POST /api/auth/login with JWT generation
Delivers: Working endpoint + tests + API contract via msg to orchestrator

### beta (craftsman → src/web/**, assets/**)
Task: Login form calling the auth API
Depends on: alpha's API contract
Delivers: Working form + manual test confirmation

### gamma (critic → entire codebase)
Task: Review both implementations when orchestrator signals ready

## Rules
- Read BOARD.md before starting work
- Check ~/.hive/msg/ for messages between major steps
- Post all deliverables and status changes via msg to orchestrator
- Append decisions and learnings to LOG.md
- Write durable learnings to journal before session ends
```

### BOARD.md
The live state of the project. **Orchestrator-owned. Agents read only.**

The orchestrator maintains this in whatever format works best. Agents
read it for state awareness. When agents need to update state, they
send a message to the orchestrator via msg/.

```markdown
# Board

## Tasks
- 001: Auth endpoint [alpha] [done] [14:52]
- 002: Login form [beta] [active] [15:01]
- 003: Code review [gamma] [waiting:002] 
- 004: Rate limiting [queued]

## Agents
### alpha (craftsman → backend)
status: idle
completed: 001
last-active: 14:52

### beta (craftsman → frontend)
status: active on 002
last-active: 15:01
note: Reading API contract below

### gamma (critic)
status: waiting for 002
blocked-by: beta

## Contracts
### Auth API (alpha → beta, 14:52)
POST /api/auth/login
Body: { "email": string, "password": string }
200: { "token": string, "expires_at": ISO8601 }
401: { "error": "invalid_credentials" }

## Blockers
(none)

## Decisions
- 14:15: Joken for JWT over Guardian. Lighter for API-only.
- 15:10: Token expiry format is ISO 8601 (alpha → beta via msg).
```

### LOG.md
Append-only session record. Any agent can append.
```markdown
# Log: 2026-03-09 Auth Feature

## 14:00 — orchestrator
Session started. Goal: user authentication.
Decomposed into 3 tasks + 1 stretch.

## 14:15 — alpha
Decision: Joken for JWT over Guardian. Lighter for API-only auth.

## 14:52 — alpha → orchestrator (msg)
task-001 complete. 4 tests passing. API contract attached.

## 15:08 — beta → alpha (msg)
Q: Token expiry format? A: ISO 8601 string.
```

---

## The Message System

File-per-message in `~/.hive/msg/`. One writer per file (sender creates,
recipient resolves). Agents check between tool calls (5-30s natural heartbeat).

### Message Format
```markdown
---
from: beta
to: alpha
type: question
status: open
ts: 2026-03-09T15:08:00Z
project: dealsplit
---

Is the JWT `expires_at` in epoch seconds or ISO 8601?
Need this for the token refresh logic.
```

### Resolved Message
Recipient changes status and appends answer:
```markdown
---
from: beta
to: alpha
type: question
status: resolved
ts: 2026-03-09T15:08:00Z
resolved: 2026-03-09T15:10:00Z
project: dealsplit
---

Is the JWT `expires_at` in epoch seconds or ISO 8601?
Need this for the token refresh logic.

## Answer (alpha, 15:10)
ISO 8601. Example: "2026-03-10T15:08:00Z".
Told orchestrator to update BOARD.md contract.
```

### Message Types
- **question** — blocks sender until answered
- **notify** — FYI, no response needed
- **handoff** — "your dependency is ready"
- **status** — agent → orchestrator: task update, completion, contract
- **assign** — orchestrator → agent: here's your task
- **nudge** — human → orchestrator: priority/direction change
- **escalate** — agent → human: needs a decision

---

## Memory Architecture

### Three Tiers

**Tier 1: Curated Knowledge (loaded every session, <4K tokens each)**
- SELF.md — user preferences
- memory/knowledge.md — cross-project durable facts
- memory/projects/{name}.md — per-project learnings

**Tier 2: Accumulated Learnings (searched on demand)**
- memory/personas/{name}.md — per-persona patterns
- memory/decisions.md — architecture decision log

**Tier 3: Raw History (archived, searched rarely)**
- memory/journal/YYYY/MM/DD.md — daily logs
- archive/YYYY/MM/{session}.md — completed sessions

### Write Patterns
Agents append to today's journal file (fire-and-forget, append-only).
The hive mind curates Tier 1 from journal entries periodically.

### Context Recovery (Agent Restart)
Five file reads to fully resume:
1. SOUL.md — culture
2. SELF.md — user preferences
3. memory/projects/{current}.md — project knowledge
4. Active PLAN.md — mission
5. Active BOARD.md — current state

### Pre-Compaction Flush
Every agent prompt includes instruction to write durable learnings
to today's journal before session end or context exhaustion.

### Memory Curation
The hive mind (via `hive curate` or `hive chat`) periodically:
1. Reads recent journal entries
2. Promotes durable facts to Tier 1/2 files
3. Prunes superseded entries from knowledge.md
4. Updates persona learnings

A local 8B model handles this. It's summarization, not code generation.

### Scaling
- Months 1-12: `grep -r ~/.hive/memory/` 
- Year 1+: SQLite FTS5 via `hive recall <query>`
- Year 2+: Vector embeddings over same files (hybrid BM25 + vector)
- Temporal decay on search: recent memories rank higher, old ones fade

Year/month directory nesting keeps any directory under 31 entries.
After 3 years: ~1,095 journal files across 36 month directories.

---

## The Orchestrator (Steward Persona)

The orchestrator is still an agent. It reads state, assigns work,
monitors progress, and adjusts the plan.

### Modes
- **Interactive:** Human drives. "What's next?" triggers assessment.
- **Loop:** Autonomous. Cycles every 30-60s. Human nudges via msg.
- **Headless (future):** Launched by the supervisor without a human
  manually pasting prompts.

Same prompt, same files, different cadence.

(See steward.md persona for the full operational prompt.)

### The Supervisor

Auto-launch should not be implemented inside the steward prompt itself.
The steward decides. A deterministic supervisor loop launches and observes
runs based on files written by the steward.

That preserves the architecture:

- the steward remains the thinker
- the supervisor remains the launcher
- `BOARD.md` stays steward-owned
- run state stays on disk

See [PHASE-4-AUTO-LAUNCH.md](./PHASE-4-AUTO-LAUNCH.md) for the concrete
design.

---

## `hive chat` — The Meta-Interface

Opens a conversation with the hive itself. Backed by a configurable
model (can be local). The hive mind reads/writes ~/.hive/ files.

Use cases:
- "What projects are you tracking?"
- "What did you learn last week?"
- "Add a persona for database optimization."
- "For Matreas, default to two craftsmen and one critic."
- "Curate your memory."
- "What's the status across all projects?"

The hive chat is how you configure, query, and adjust the hive without
editing files directly. The files are always the source of truth —
hive chat is a conversational interface over them.

---

## Multi-LLM Integration

| Runtime      | Invocation                                       | Good For         |
|-------------|--------------------------------------------------|------------------|
| claude-code | `claude --session X --prompt "..."`              | Code generation  |
| codex       | `codex --session X` + prompt                     | Code generation  |
| gemini-cli  | `gemini --session X` + SKILL.md                  | Code generation  |
| ollama      | `ollama run MODEL` + prompt                      | Orchestration    |
| lmstudio    | HTTP API at localhost                             | Orchestration    |
| custom      | Any command accepting prompt via stdin/arg        | Anything         |

"Two Claudes and one Codex" = three lines in project config.md.

---

## CLI

```bash
hive init                        # Bootstrap ~/.hive/
hive project add <project> <path># Register a project with repo path
hive work [project]              # Set/show active project
hive orchestrate [goal]          # Build a steward pass prompt
hive launch <agent>              # Manual one-shot runtime launch
hive supervise                   # Autonomous launch + supervision loop
hive ps                          # Show active runs
hive stop <agent|run>            # Stop a supervised run
hive feed [n]                    # Show recent feed entries
hive watch                       # Tail feed.md
hive status                      # Pretty-print active BOARD.md + open msgs
hive log <message>               # Append to active LOG.md
hive msg <from> <to> <body>      # Create message
hive nudge <message>             # Human → orchestrator shortcut
hive prompt <agent-id>           # Generate full prompt (soul+self+persona+context)
hive chat                        # Talk to the hive (meta-interface)
hive curate                      # Run memory curation
hive archive                     # Archive session + curate
hive sync                        # Copy PLAN.md to repo .hive/ for sharing
hive help                        # Usage
```

Written in TypeScript, runs on Bun. Zero npm dependencies.
Compiles to standalone binary via `bun build --compile`.

---

## Implementation Plan

### Phase 1: Core Primitives
- [ ] `hive init` — register a project
- [ ] `hive work` — set/show active project
- [ ] `hive status` — format BOARD.md + open messages
- [ ] `hive log` — append to LOG.md with timestamp
- [ ] `hive msg` — create message file
- [ ] `hive nudge` — human → orchestrator
- [ ] `hive prompt` — assemble: soul + self + persona + project context
- [ ] `hive archive` — session → archive/, fresh LOG
- [ ] Scaffold ~/.hive/ with defaults on first run
- [ ] Ship SOUL.md + SELF.md template + 5 personas

### Phase 2: Orchestrator
- [ ] Steward persona with full run-loop prompt
- [ ] Interactive mode (human drives)
- [ ] Loop mode (autonomous with nudge)
- [ ] Task decomposition from natural language goal
- [ ] Stuck detection + reassignment

### Phase 3: Hive Chat
- [ ] `hive chat` — conversational meta-interface
- [ ] Persona creation via chat
- [ ] Project configuration via chat
- [ ] Memory querying via chat
- [ ] Local model support (Ollama integration)
- [x] One-shot `hive launch <agent>` runtime invocation
- [x] `hive feed` / `hive watch` human event stream

### Phase 4: Autonomous Launch And Supervision
- [x] `hive supervise` — deterministic supervisor loop
- [x] Supervisor-owned run records under `projects/<project>/runs/`
- [x] Orchestrator-triggered worker auto-launch from assignment messages
- [x] Parallel worker dispatch with explicit scope guards
- [x] `hive ps` / `hive stop` operational control
- [x] Restart recovery from on-disk run state

### Phase 5: Rich Human Modes
- [ ] Persistent console over the hive files
- [ ] Notification and escalation surfaces
- [ ] Transport adapters (desktop, Slack, Telegram, iMessage, etc.)
- [ ] Cross-project status and steering from one human interface

### Phase 6: Memory Intelligence
- [ ] `hive curate` — memory curation pass
- [ ] Auto-curation on archive
- [ ] `hive recall <query>` — search across memory
- [ ] SQLite FTS5 index
- [ ] Vector embeddings (future)

### Phase 7: Integration & Polish
- [ ] Additional runtime adapters
- [ ] `hive sync` — copy PLAN to repo
- [ ] Template library (shareable project configs)

---

## What This Is NOT

- Not a required daemon (foreground supervision is enough; backgrounding is
  optional)
- Not a general-purpose process manager (HIVE only supervises its own agent
  runs)
- Not an LLM router in the framework sense (HIVE launches explicitly
  configured runtimes; it does not become the model layer)
- Not a framework (no SDK, no library imports)
- Not project-scoped (lives in home dir, works across projects)
