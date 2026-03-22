# What Hive Is

Hive is a lightweight, multi-model, crash-resilient agent orchestrator.

It belongs to the same family as OpenHands, Claude Code, and Aider — tools
that let AI agents do software engineering work. Hive's contribution is
not a new paradigm. It is a set of architectural bets about how
orchestration should work when you have access to many models, when
processes die, and when coordination costs matter.

## The Honest Framing

Most agent orchestration tools are single-model. Claude Code runs Claude.
Codex runs GPT. OpenHands runs whatever you configure, but the
orchestration layer assumes one model at a time. Hive is multi-model from
the ground up: the coordinator picks a runtime and model for each task
from a pool that spans providers.

That's the core differentiator. Everything else follows from it.

## Four Architectural Bets

### 1. Runtime-Agnostic Orchestration

Hive dispatches work to Claude, GPT, Gemini, DeepSeek, and local Ollama
models through a common runtime adapter interface. The steward — the
persistent coordinator — sees a pool of models and picks the right one
for each task based on the work, not the vendor.

This matters because:

- You are not locked to one provider's pricing, capabilities, or uptime.
- Different models are better at different things. Opus for deep
  reasoning. Sonnet for general coding. A local qwen3 for fast triage.
- Provider outages do not halt all work. The steward routes around them.

### 2. Token Arbitrage

Route cheap work to cheap models, expensive work to expensive models.

A local qwen3:4b handles diff triage in 200ms for free. Haiku classifies
messages for fractions of a cent. Sonnet does the general coding. Opus
gets called for the hard problems. The system tracks token usage and cost
per run, making the economics visible.

This is not just cost — it is latency too. A local model returns in
milliseconds. A frontier API call takes seconds. For coordination tasks
that happen dozens of times per session, the difference compounds.

### 3. File-Native State

All durable state lives in markdown files under `~/.hive/`. No database.
No in-memory queues. No process-bound state that vanishes on crash.

- `PLAN.md` defines the mission.
- `BOARD.md` tracks live work.
- `LOG.md` records history.
- `msg/` is the message bus — one file per message.
- `runs/` records every worker execution with metadata.
- `memory/` accumulates learnings across sessions and projects.

If every process dies, the hive is still there on disk. Restart, read the
files, resume. This is less exciting than a real-time database, but for
long-running autonomous operations it is the right trade-off: durability
over performance, inspectability over abstraction.

The file substrate also means any tool that reads files can participate.
You can `cat BOARD.md` to see what is happening. You can `ls msg/` to
see pending work. You can edit `PLAN.md` in your editor and the system
picks it up. The API is the filesystem.

### 4. Coordination Separated from Execution

The steward coordinates. Workers execute. This is an architectural
constraint, not a convention.

The steward never writes code. It reads the board, talks to the human,
decides what work to do, picks a model and persona for it, writes an
assignment file, and waits for results. Workers are ephemeral processes
that receive a scoped assignment, do the work, report back, and exit.

This separation means:

- The coordinator's context stays clean. It is not polluted with
  implementation details from the work it delegates.
- Workers can run on any runtime. The steward does not need to know how
  Claude's tool use differs from Codex's.
- Failure is contained. A crashed worker does not take down coordination.
  The steward notices the failure and can reassign.

Claude Code had to add "delegate mode" to achieve this separation by
convention. Hive has it by architecture.

## What Hive Is Not

Hive is not a hosted platform. It runs on your machine.

Hive is not a framework for building agents. It orchestrates existing
CLI-based agent runtimes (claude, codex, gemini, ollama).

Hive is not trying to replace your editor, your terminal, or your
workflow. It is the layer between you and a pool of AI models that can
do work in parallel.

## The Core Loop

```
Human speaks
  -> Steward responds immediately (warm persistent session)
  -> If work needed: steward writes assignment to msg/
  -> File watcher fires (~200ms) -> worker launches
  -> Worker completes -> watcher fires (~200ms) -> steward notified
  -> Steward synthesizes -> responds to human
  -> Loop continues
```

Coordination is event-driven through filesystem watchers. Total latency
per coordination hop is ~200ms, not the 30-60s polling intervals common
in other systems. The supervisor's 120s poll is a safety net for zombie
cleanup, not the primary coordination path.

## The Model

### The Hive

The durable substrate. Identity, memory, configuration, and state that
persists across sessions, projects, and process restarts. Lives at
`~/.hive/`.

### The Steward

A persistent coordinator session. Talks to the human. Maintains context
across a conversation. Picks models and personas for each task. Delegates
through assignment messages. Synthesizes worker results. Never executes
code itself.

### Workers

Ephemeral processes with scoped assignments. Spawned from the model pool
with a persona (architect, craftsman, critic, scout). Read the substrate,
do their work, report back, exit. Any runtime: Claude, Codex, Gemini,
Ollama.

### Personas

Cognitive orientations, not job titles. A persona defines how a worker
thinks — an architect reasons about structure and trade-offs, a craftsman
focuses on implementation quality, a critic finds edge cases, a scout
explores alternatives. The steward picks the persona that matches the
work.

## Design Values

**Inspectability over abstraction.** The state of the system is always
readable in plain text. `cat ~/.hive/projects/myapp/BOARD.md` tells you
what is happening. No query language, no dashboard required.

**Durability over performance.** File I/O is slower than in-memory state.
But files survive crashes, are trivially backed up, and can be versioned
with git. For a system designed to run for hours unattended, this is the
right trade-off.

**Policy over infrastructure.** Routing decisions — which model handles
which work — are configuration in `config.md`, not a distributed
scheduler. Change the policy, change the behavior. No new services to
deploy.

**Simplicity over features.** Zero npm dependencies. Bun built-ins only.
Markdown is the data model. YAML frontmatter for metadata. No build step
beyond `bun build`. The system compiles to a single binary.
