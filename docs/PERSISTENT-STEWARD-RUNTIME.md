# HIVE Persistent Steward Runtime

This document replaces the current mental model of "human message -> nudge ->
supervisor -> one-shot orchestrator pass" for the hot interactive path.

The goal is to make HIVE feel like a live head agent with a team behind it,
while keeping the best parts of the existing architecture:

- files remain the API
- durable state stays on disk
- markdown remains the human-readable source of truth
- worker agents stay disposable
- supervision stays deterministic

## Problem

The current system works as workflow automation, but it does not yet work as a
human-facing hive mind.

Today the hot path is:

1. human sends a message
2. HIVE writes a `nudge`
3. detached supervisor notices the `nudge`
4. supervisor launches a fresh `orchestrator` run
5. the orchestrator prompt is rebuilt from disk
6. the orchestrator reads state, acts, exits
7. the human eventually sees the result

This creates three concrete failures:

1. Human latency is tied to a full steward pass.
2. The head of the hive is not persistent, so every turn rehydrates context.
3. The gateway session is not a true conversation with the head agent.

The result is a UI that feels slow and batch-oriented even when the underlying
system is "working."

## Desired Product Shape

The desired experience is:

1. `hive run`
2. the hive mind becomes live
3. the human talks to the hive directly
4. the hive delegates work to agents
5. the session shows what the hive is doing as it happens

The human should not think in terms of nudges, reassessment passes, or prompt
reassembly. Those remain implementation details.

## OpenClaw Inspiration

OpenClaw is the right inspiration for the human-facing layer:

- one primary conversational intelligence
- durable file-backed memory
- resumable sessions
- compact refreshes rather than full re-reads
- explicit memory write path

What HIVE keeps that OpenClaw does not:

- a team, not a single assistant
- file-based worker coordination
- deterministic worker supervision
- project-scoped orchestration across multiple transient agents

The right synthesis is:

- OpenClaw-style persistent head agent
- HIVE-style file-backed multi-agent coordination

## New Runtime Model

HIVE should be split into four layers.

### 1. Steward

The steward is the live head agent.

Responsibilities:

- talk to the human
- maintain working context across turns
- decide what matters
- update `PLAN.md`, `BOARD.md`, and `LOG.md`
- create worker assignments
- interpret worker outcomes
- ask the human for decisions when needed

Properties:

- persistent session, not one-shot pass
- primary conversational interface
- hot context kept in memory
- durable facts still written to files

The human should experience "HIVE" as the steward.

### 2. State Monitor

The state monitor is deterministic and non-LLM.

Responsibilities:

- watch file state and run state
- parse markdown once
- compute compact machine-readable summaries
- detect what changed since the steward last looked
- emit steward delta packets
- avoid reloading unchanged state into the steward

Properties:

- no model calls
- cheap
- restartable
- derived state is disposable

This is the component that should replace the current meaning of
"orchestrator" on the hot path.

### 3. Supervisor

The supervisor is deterministic and non-LLM.

Responsibilities:

- launch and stop worker runs
- recover stale runs
- enforce parallel and scope rules
- maintain the run ledger

Properties:

- no direct human conversation
- no strategic reasoning
- no ownership of board or plan

The supervisor is infrastructure, not the hive mind.

### 4. Workers

Workers remain disposable specialized agents.

Responsibilities:

- execute assigned work
- stay inside scope
- report outcomes back through files

Properties:

- transient
- replaceable
- launched on demand

## Storage Model

The old principle "everything is markdown" is too strong for the runtime path.

The new storage rule should be:

- files are the API
- markdown is the human source of truth
- structured machine state is allowed for runtime acceleration
- derived state is disposable

### A. Human Truth

Keep these as markdown:

- `SOUL.md`
- `SELF.md`
- `AGENTS.md`
- `PLAN.md`
- `BOARD.md`
- `LOG.md`
- long-term memory files
- human-inspectable message files

These are durable, readable, and versionable.

### B. Machine-Derived Runtime State

Add compact JSON or JSONL under a project-local state directory:

`~/.hive/projects/<project>/state/`

Suggested files:

- `revision.json`
- `board-summary.json`
- `open-messages.json`
- `recent-results.json`
- `active-runs.json`
- `steward-delta.json`
- `human-inbox.json`
- `session-context.json`

These are not source of truth. They are fast runtime derivatives.

### C. Ephemeral In-Memory State

The live steward process should keep:

- recent human turns
- recent steward turns
- current mission
- current task focus
- current board summary
- active assignment summary
- recent worker outcomes
- pending questions for the human

If the steward dies, this can be rebuilt from markdown + derived JSON.

## Steward Context Contract

The steward should not reread the whole hive on every human turn.

### Initial Bootstrap

On steward start, provide:

- compact `SOUL.md`
- compact `SELF.md`
- compact `AGENTS.md`
- project identity
- board summary
- active assignments summary
- recent run results summary
- recent decisions summary
- recent conversation tail
- absolute file paths for deeper reads

This is the only heavy bootstrap.

### Refresh Contract

After bootstrap, the steward gets only:

- human messages
- state deltas
- worker completion summaries
- explicit escalation events

The steward should only perform deeper reads when:

- the state monitor marks something relevant as changed
- the human asks a question requiring deeper inspection
- the steward explicitly requests a deeper read

## State Monitor Contract

The state monitor owns change detection.

### Inputs

- `BOARD.md`
- `PLAN.md`
- `LOG.md`
- open message files
- run ledger
- recent run results
- session history

### Outputs

- revision counters or content hashes
- compact summaries
- change packets for the steward
- human-facing progress state for the gateway

### Example Delta Packet

```json
{
  "project": "hive",
  "revision": 42,
  "ts": "2026-03-12T12:00:00Z",
  "changes": [
    {
      "type": "human-message",
      "summary": "User asked for more personality in the prompts."
    },
    {
      "type": "board-change",
      "summary": "HIVE-014 moved from active to done."
    },
    {
      "type": "worker-result",
      "agent": "beta",
      "task": "HIVE-015",
      "summary": "Prompt regression coverage added. Tests passed."
    }
  ]
}
```

This is what the steward should ingest, not whole markdown files.

## Human Interaction Model

The gateway should talk to the live steward session directly.

### Session Rules

- the human session is primary
- feed is secondary
- the session shows ongoing work and decisions
- feed remains a durable event stream

### The Session Should Show

- immediate acknowledgment
- "what I am doing right now"
- assignment decisions
- worker start/completion summaries
- questions for the human
- final answers

### The Feed Should Show

- durable high-signal events
- launches, exits, recoveries, key decisions
- useful operator history

The feed should not be required to understand the current conversation.

## Role Changes

The term `orchestrator` is now overloaded and should be narrowed.

### Current Meaning

"orchestrator" currently means "fresh steward prompt run launched by the
supervisor."

### New Meaning

Use:

- `steward` for the live head agent
- `state monitor` for deterministic state parsing and delta generation
- `supervisor` for process launch and recovery

If the code keeps the `orchestrator` name temporarily, it should map to
`state monitor` responsibilities, not to a one-shot LLM pass.

## What Changes in Practice

### Old Hot Path

`human -> say -> nudge -> supervisor -> orchestrator run -> result`

### New Hot Path

`human -> live steward session -> response`

### Old Worker Path

`orchestrator run -> assignment messages -> supervisor launches workers`

### New Worker Path

`steward -> assignment messages -> supervisor launches workers`

### Old Refresh Model

`rebuild prompt from markdown every time`

### New Refresh Model

`bootstrap once, then apply deterministic deltas`

## Migration Plan

Implement this in five narrow steps.

### Step 1: Add Derived State

Create:

- `projects/<project>/state/`
- board summary generation
- open message summary generation
- recent result summary generation
- revision tracking

Do not change the live interaction model yet.

### Step 2: Introduce State Monitor

Add a deterministic process or command path that:

- watches file changes
- updates derived state
- emits steward delta packets

This can initially be invoked by the gateway and supervisor before becoming a
long-lived loop.

### Step 3: Create Persistent Steward Session

Start a real steward session that:

- bootstraps once from compact state
- remains alive across human turns
- accepts state monitor deltas
- accepts human messages directly

### Step 4: Rewire Gateway

Change the web console and terminal console to:

- attach to the live steward
- show steward output directly
- stop routing normal interaction through one-shot orchestration passes

### Step 5: Demote One-Shot Orchestration

Keep one-shot steward launch only as:

- recovery fallback
- batch/offline mode
- debugging escape hatch

It should no longer be the primary human path.

## Success Criteria

The design is working when:

1. `hey` gets a near-immediate response from the live steward.
2. Human follow-up questions do not trigger full prompt rebuilds.
3. The session shows live work updates without forcing the user to read feed.
4. The steward only rereads markdown when relevant state changed.
5. Worker launches still remain deterministic and supervised.
6. Killing the steward does not lose durable project state.

## Non-Goals

This design does not require:

- a database as source of truth
- abandoning markdown for human-readable state
- a central daemon that owns all state
- removing low-level CLI/operator commands

## Recommended Next Implementation Task

Do not start by tuning the old one-shot orchestrator prompts.

Start with:

1. project-local derived state under `state/`
2. revision and delta generation
3. a persistent steward session contract

That is the prerequisite for a fast, human-oriented HIVE.
