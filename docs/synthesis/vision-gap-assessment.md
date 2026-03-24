# Vision Gap Assessment
_Branch checked: `ooda`_
_Recent commits checked: `696d10e`, `08d6f0b`, `aa3cfb1`, `32cd221`, `3cb6b63`_

## Bottom Line

HIVE is no longer just a concept deck. The coordination substrate is real:
watcher-driven dispatch, supervised worker runs, a persistent steward path,
goal files, approvals, event logs, and a first OODA loop are all in code.

But the north star is still not real end-to-end.

The current system can:
- decompose a goal once
- fan work out to workers
- supervise those workers
- react to signals

It cannot yet:
- run a declared goal for hours through multiple autonomous waves
- detect "wave complete, now re-plan"
- isolate parallel workers in worktrees
- synthesize a morning brief automatically
- enforce trust boundaries in execution rather than doctrine

That means HIVE today is a strong coordination substrate plus some serious autonomy primitives, not yet the full "set goal at night, wake up to a finished multi-agent run" machine described in the docs.

## What Was Planned, What Was Built, What Is Still Just a Doc

### 1. Autonomous Pipelines

Status: mostly doc

What is real:
- `hive events` can record normalized internal/external events.
- severe or explicitly routed events can create steward-facing messages.
- approvals and memory extraction leave durable trails.

What is not real:
- no pipeline engine with trigger -> triage -> work -> verification -> closure
- no Sentry autofix pipeline
- no CI triage pipeline
- no deploy-readiness or approval-backed publish pipeline
- no scheduled recurring pipeline framework

Verdict: the intake primitives exist; the pipelines do not.

### 2. Events And Hooks

Status: partial

What is real:
- `src/lib/events.ts` writes JSONL records under `~/.hive/events/internal/` and `~/.hive/events/external/`
- `src/commands/events.ts` exposes `hive events` and `hive events record`
- approval lifecycle and memory updates emit events
- gateway snapshots read recent events

What is not real:
- no HTTP hook endpoint
- no transform module layer for GitHub/Sentry/CI payloads
- no durable derived views like `state/recent-events.json` or `state/open-incidents.json`
- no real hook auth/validation boundary

Verdict: there is an event log, not yet a full hook kernel.

### 3. Trust Ladder

Status: partial

What is real:
- `~/.hive/TRUST.md` exists as policy
- file-backed approval queue exists in `src/lib/approvals.ts`
- CLI request/list/approve/reject exists in `src/commands/approval.ts`
- approvals emit feed entries and events
- gateway UI surfaces pending approvals in snapshots

What is not real:
- no gateway approve/reject action path
- no widespread automatic "classify action, then queue approval" behavior
- no enforcement boundary at runtime or tool layer
- workers still launch with Claude `--permission-mode bypassPermissions`

Verdict: the trust model is durable and inspectable, but mostly advisory. The queue is real; hard execution control is not.

### 4. Memory Lifecycle

Status: partial, better than the future doc assumes

What is real:
- `extractMemory()` exists and writes journal + derived summary/heat/decision artifacts
- idle cognition calls `extractMemory()` automatically
- `memory-hotset` and `stale-memory` tasks exist and materialize packets
- project/entity memory structure is real
- project heat tracks `accessCount` and `lastAccessed`

What is not real:
- no fact-level decay on individual entity items
- no `status/supersededBy` lifecycle on fact records
- no automatic contradiction handling
- no summary rewriting based on hot/warm/cold fact temperature
- no explicit pinning model for "always hot" facts

Verdict: memory extraction and heat exist. Fact lifecycle does not.

### 5. Working-Set Compiler

Status: partly built, then strategically bypassed

What is real:
- `src/lib/cognition/` still contains a workbench, packets, and idle compile tasks
- steward monolith split happened; `src/lib/steward/*` is real
- worker brief generation exists
- idle packets for log rollup, phase summary, memory hotset, and stale memory exist

What is not real anymore:
- the steward does not consume a full compiled working set
- `src/lib/context.ts` explicitly says it replaces the packet/workbench/working-set system with direct rendering
- `src/lib/steward/context.ts` explicitly says the old compiled-state path was replaced by direct runtime-state summaries

Verdict: this future doc is no longer a clean roadmap. It is partly implemented archaeology plus some surviving idle-cognition pieces. The full compiler vision is not the current architecture.

### 6. Overnight Launch

Status: partial

What is real:
- `hive dream` exists
- `src/lib/dream-planner.ts` does model-based decomposition into 2-6 tasks
- `hive goal` exists
- `dream` writes assignment messages and can best-effort start the supervisor
- worker auto-launch and supervision are real
- `think` and the strategic loop exist as reactive autonomy primitives

What is not real:
- `dream` does not update `PLAN.md`
- `dream` does not update `BOARD.md`
- plan validation is mostly prompt-level, not a hard validation pass
- no worktree isolation
- no stale-task timeout/restart loop for overnight runs
- no task-level retry budget except verification retry
- no automatic synthesis pass
- no morning briefing generator
- no board-clean completion detector that closes the run
- no wave-2 / wave-3 autonomous replanning loop

Verdict: `dream` is an entry point plus first-wave dispatch, not the full overnight system described in the doc.

### 7. FINAL-PRD Drift

Status: mixed; parts shipped, parts obsolete

What the PRD got right:
- persistent hive state in `~/.hive/`
- steward-owned coordination
- transient workers
- supervisor-managed launches
- message bus + board + log model

What is now outdated:
- PRD centers `hive chat` and `hive orchestrate`; current CLI centers `hive say` and `hive console`
- PRD frames several things as future that are now shipped: approvals, events, goals, persistent steward, supervisor auto-launch
- PRD's memory roadmap is still aspirational beyond extraction

Verdict: the PRD still describes the philosophy well, but it is not an accurate shipped-feature ledger.

## 1. Capabilities In The Future Docs That Do Not Exist Yet

These are the major missing capabilities, grouped by practical impact:

### Closed-loop autonomy

- Multi-wave goal execution: no "results came back, now re-plan and dispatch next wave"
- Morning synthesis: no automatic final brief with ship / iterate / needs-human recommendation
- Goal completion engine: no runtime that drives a goal until done

### Safe parallelism

- Worktree-per-worker isolation
- hard scope enforcement beyond prompt instructions and launch selection
- semantic conflict detection across parallel branches

### Robust overnight resilience

- stale-task detection based on "active for X minutes with no file changes"
- automatic worker restart with fresh context
- retry budget tied to task execution, not just post-run verification

### Real external automation

- webhook intake endpoints
- transform modules for GitHub / CI / Sentry
- productized autonomous pipelines
- approval-backed external actions wired end-to-end

### Trust as enforcement, not policy text

- gateway/UI approval actions
- automatic routing of gated actions into approvals
- tool/runtime permission enforcement
- credential-aware execution policy

### Living memory

- fact supersession
- fact-level temperature and decay
- summary rewriting from active fact state
- contradiction handling

### Compiler vision leftovers

- shared compiled working set consumed by steward, console, workers, and UI from one path
- event compile / turn-start compile as the default context path

## 2. The Trust / Autonomy Model

The intended model is straightforward:

1. Classify the action.
2. If it is local, reversible, and internal, act.
3. If it touches the network, reputation, credentials, money, prod, or irreversible state, ask through the approval queue.
4. If it is forbidden, stop.

That is the doctrine in `TRUST.md`, and it is the right doctrine.

The problem is that current HIVE only partially operationalizes it. The approval queue is real, but execution enforcement is weak. Workers still run with broad runtime permissions, and most trust decisions are still made by prompt discipline rather than hard boundaries.

So the steward should decide this way:

### Act without asking

- local file reads/writes
- board/log/memory/message updates
- local code changes
- tests, builds, analysis
- local branch/worktree creation
- reversible retries and restarts

### Ask through approvals

- push / PR / merge
- deploy
- external messages
- use of production credentials
- anything that changes external system state
- anything the human would reasonably want to review before execution

### Refuse

- money movement
- contracts
- destructive production actions
- external secret sharing

The key product point: approval is not a chat fallback. It is the durable control plane for autonomy. HIVE understands that in design; it does not yet enforce it reliably in execution.

## 3. What "Overnight Launch" Actually Means In HIVE Terms

In HIVE terms, overnight launch means:

- a goal is declared once
- the steward decomposes it into parallel scoped tasks
- workers execute over hours
- the steward only intervenes when judgment is needed
- the system keeps going until the goal is done or truly blocked
- the morning artifact is a synthesized briefing, not a pile of raw run logs

That is the promised product.

What is wired today is narrower:

- `hive dream` does the initial planning pass
- tasks are emitted as assignment messages
- supervisor can launch workers
- worker results can wake or inform the steward
- OODA tactical/strategic logic can react to events

So the real answer is:

- `dream` is real
- overnight closed-loop execution is not

The best description of current HIVE is "first-wave autonomous fan-out with supervision," not "end-to-end overnight goal execution."

## 4. How HIVE Actually Compares To Other Agent Frameworks

HIVE's real differentiator is not "most autonomous." It is:

- file-native orchestration
- runtime/model heterogeneity
- persistent steward + ephemeral workers
- project memory that survives process death
- a deliberate bet on multi-perspective coordination

Those are real.

The strongest shipped differentiators are:

### Multi-model composition

HIVE really can coordinate different runtimes and models per agent. That is not marketing copy; it is how the system is shaped.

### Durable inspectable state

The board, messages, runs, memory, approvals, and events live on disk. Kill processes and the state is still there.

### Coordination separated from execution

The supervisor launches, the steward coordinates, workers execute. That split is real and valuable.

### Cross-project memory substrate

HIVE is shaped like a durable working environment, not a single chat session.

What is still mostly thesis rather than proof:

### Persona advantage

"Architect + craftsman + critic beats one strong agent" is plausible, but not yet validated in the codebase or research with hard evidence.

### Orchestrator-as-agent superiority

The LLM steward is flexible, but it is also slower and less reliable than deterministic routing in frameworks like OpenClaw. HIVE wins if model quality keeps compounding. It does not win today on raw operational reliability.

### Overnight autonomy

OpenClaw-style overnight usefulness exists today in the ecosystem. HIVE's version is still under construction.

So the honest comparison is:

- HIVE is structurally differentiated
- HIVE is not yet operationally ahead

Its moat is architectural direction, not present-day completeness.

## 5. The Single Highest-Leverage Thing To Build Next

Build the goal loop.

More specifically: a goal-state orchestration layer that closes the loop after first-wave execution.

It should do five things:

1. Watch the active goal plus board state.
2. Detect when the current wave is complete, blocked, or stale.
3. Synthesize completed worker results against the original goal.
4. Decide: done, dispatch next wave, critic review, or escalate.
5. Emit the morning brief when terminal.

Why this is the highest-leverage build:

- The planner already exists.
- The supervisor already exists.
- Worker dispatch already exists.
- Goals already exist.
- Persistent steward exists.
- OODA strategic reaction exists.

Right now those parts do not compose into an hours-long autonomous system. They produce one wave, then stop being a product and become a manual orchestration kit.

If HIVE gets a real goal loop, it crosses the line from "interesting substrate" to "actually behaves like the steipete north star." Worktrees, stronger trust enforcement, and pipeline integrations all matter, but they are second-order until the system can autonomously continue past the first dispatch.

## Recommended Framing For The Team

If Greg asks "what's real?", the answer is:

- The substrate is real.
- The first-wave planner is real.
- The persistent steward path is real.
- Approvals and event logging are real.
- A reactive OODA layer is real.
- The full overnight autonomous multi-agent loop is not real yet.

If Greg asks "what should we build next?", the answer is:

- not another vision doc
- not more idle cognition
- not more UI polish
- the goal loop that turns `dream` from a launch command into an autonomous run

That is the shortest path from impressive architecture to actual throughput.
