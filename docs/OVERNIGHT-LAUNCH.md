# HIVE Overnight Launch Design

## The Goal

You should be able to say:

```
hive dream "build a CLI tool that watches a git repo and posts a Slack digest on push"
```

Go to sleep. Wake up to a working repo, tests, a shift briefing, and a
recommendation to ship or iterate.

This is the endgame. It depends on everything below it in the stack being
solid first.

---

## Prerequisites: What Must Exist First

Overnight launch is Layer 4 of a four-layer system. Each layer depends on
the ones below it.

### Layer 1: Coordination Substrate (done)

File-backed orchestration, supervisor, workers, board model, messaging,
scope conflict detection, run ledger, gateway.

### Layer 2: Persistent Steward (PERSISTENT-STEWARD-DESIGN.md)

Maya as a live session. Delta-aware. Fast human interaction. Bootstrap once,
refresh via deltas. Falls back to one-shot on failure. The gateway is the
host.

Without this, overnight launch has no head. The steward would cold-start on
every cycle, losing the thread of an evolving multi-hour build.

### Layer 3: Cognitive Resources (COGNITIVE-RESOURCE-MANAGEMENT.md)

Tiered model routing. Local models for compression and triage. Usage
tracking. The escalation ladder: deterministic → small model → worker →
steward.

Without this, overnight launch burns frontier tokens on summarization and
triage. A 6-hour Opus session doing everything is expensive and wasteful.

### Layer 4: Overnight Launch (this document)

Entry point, planning, autonomous execution, synthesis, morning handoff.

**Do not build this until Layers 2 and 3 are working.** The Felix/OpenClaw
lesson learned the hard way: "overcomplicating memory on day one" and
"running expensive models on cheap tasks" are real failure modes.

---

## What We Already Have

The coordination skeleton is real:

- Supervisor loop: detached, crash-safe, parallel workers, scope safety
- Board + message model: steward assigns, supervisor launches, workers report
- Multi-runtime support: claude, codex, gemini adapters
- Gateway: web UI, WebSocket feed, REST API
- Trust ladder: internal-safe / code-safe / external-gated / forbidden
- Event kernel: internal and external event recording
- Memory architecture: layered, entity-aware, with derived state

What is missing is the entry point, the planning pass, and the terminal
synthesis. The middle already works.

---

## The Architecture

### How OpenClaw Does It (And Where We Differ)

OpenClaw's overnight architecture is built around the "Ralph loop" — a
wrapper script that repeatedly launches a coding agent with the same prompt
until the work is done. Each iteration starts fresh with zero accumulated
context. The agent picks up where the last one left off by reading the file
system and git history.

The key insight: **context is a cache, not state.** If an agent can't
reconstruct its situation from files alone, the architecture has a single
point of failure sitting in a context window.

OpenClaw's approach works for single-agent, single-codebase tasks. It's
essentially a retry loop with fresh context on each attempt. The monitoring
is simple: is the agent alive? Is it making progress? Are all PRD boxes
checked? If not, kill and restart.

HIVE's architecture is different in two structural ways:

1. **Multi-agent coordination, not single-agent retry.** HIVE decomposes
   goals into parallel scoped tasks across multiple workers. This is more
   powerful but harder to orchestrate — you need a live head that tracks
   cross-agent state, not just a loop that restarts one process.

2. **File-backed coordination, not context-backed.** OpenClaw's agents
   coordinate through the filesystem too, but HIVE formalizes this: the board
   is the shared state, messages are the communication channel, the
   supervisor is the process manager. This makes overnight runs inspectable
   and recoverable at any point.

The overnight loop should combine the best of both:
- OpenClaw's resilience model (agents are disposable, restart on failure)
- HIVE's coordination model (steward plans, workers execute in parallel,
  board tracks state)

### The Three Phases of an Overnight Run

```
hive dream "idea"
    │
    ▼
PHASE 1: PLAN (Maya, one pass)
    │ Decompose goal → PLAN.md + BOARD.md + assignment messages
    │ Validate: scopes don't overlap, tasks are atomic, "done" is testable
    │ Estimate cost, show plan, wait for confirmation (or --go to skip)
    │
    ▼
PHASE 2: EXECUTE (supervisor + workers, parallel)
    │ Workers run scoped tasks
    │ Steward monitors via deltas (Layer 2)
    │ Tier-1 models compress worker output (Layer 3)
    │ Stale task detection: timeout → retry or escalate
    │ Steward intervenes only for conflicts or blocked workers
    │
    ▼
PHASE 3: SYNTHESIZE (Maya, one pass)
    │ Read all results, repo state, git history
    │ Produce handoff briefing
    │ Surface conflicts, risks, and recommendations
    │ Emit morning notification
    │
    ▼
You wake up → shift briefing → review → ship or iterate
```

---

## Phase 1: Planning

### Maya as Planner

The planner is not a new persona. It's Maya doing a specific job: taking a
vague goal and producing a structured, executable plan.

Why not a separate planner persona? Because planning is the most
context-sensitive task in the system. It needs to know Greg's preferences,
the project's conventions, the team's capabilities, and the codebase's
patterns. Maya has all of this. A new persona would start cold.

### What the Planner Produces

1. **PLAN.md** — structured goal decomposition with task assignments
2. **BOARD.md entries** — one row per task, with status, agent, and scope
3. **Assignment messages** — one per task, with `launch: auto` frontmatter

### Plan Validation

Before launching, the plan is validated:

- Every task has a scope (list of files/directories it may touch)
- No two tasks have overlapping scopes
- Every task has a testable "done" condition (not "implement auth" but
  "auth endpoint returns 200 with valid JWT and 401 without")
- Task count is between 2 and 8 (fewer means the goal is too small for
  overnight; more means the decomposition is too fine)
- Cost estimate is shown (based on expected token usage per task type)

If validation fails, Maya fixes the plan or surfaces the issue.

### Entry Point

```bash
hive dream "build a CLI tool that watches a git repo and posts Slack digest"
hive dream --from spec.md     # read goal from file
hive dream --dry-run          # show plan without launching
hive dream --go               # skip confirmation, launch immediately
```

`hive dream` does:

1. Bootstrap a project directory (or use active project)
2. Run Maya in planning mode
3. Show the plan, cost estimate, and task breakdown
4. On confirmation, emit assignment messages and start supervision

---

## Phase 2: Execution

Execution uses the existing supervisor loop. The overnight additions are:

### Worker Resilience

Workers are disposable. The supervisor already handles crash recovery. For
overnight runs, add:

- **Task timeout**: if a worker has been active for >30 minutes with no
  file changes, mark it stale
- **Stale recovery**: kill the process, restart with a fresh context (the
  Ralph loop insight — a fresh agent reading files is better than a confused
  agent in a corrupted context window)
- **Retry budget**: max 3 restarts per task before escalating to human inbox

### Steward Oversight

The persistent steward (Layer 2) monitors via delta packets:

- Worker completions trigger tier-1 summarization (Layer 3)
- Maya sees compact digests, not raw output
- She intervenes only for: cross-agent conflicts, blocked workers that
  exhausted retries, plan-level problems

Most overnight cycles, Maya does nothing. The workers work. The supervisor
supervises. Maya sleeps unless something needs judgment.

### Worker Isolation

Each worker gets its own git worktree:

```bash
git worktree add -b task/auth /tmp/hive-worker-alpha main
git worktree add -b task/api  /tmp/hive-worker-beta  main
```

Workers can't stomp on each other's files. When a worker completes, its
branch is ready for review or merge. The synthesizer reads all branches.

---

## Phase 3: Synthesis

### What Synthesis Actually Is

When all board tasks are done (or a configurable timeout is reached), Maya
runs a synthesis pass. This is not a new persona — it's Maya in a different
mode.

The synthesizer reads:
- All completed task results
- The current repo state across all worker branches
- Git diffs from each branch
- The original goal from PLAN.md
- Any conflicts or unresolved issues

The synthesizer produces:
- **Handoff briefing**: what was built, what's left, what to look at first
- **Branch status**: which branches are clean, which have conflicts
- **Risk notes**: anything the steward noticed during the run that the
  leader should know about
- **Ship recommendation**: ship / iterate / needs-human, with reasons

### What This Looks Like When You Wake Up

```
━━━ MORNING BRIEFING ━━━━━━━━━━━━━━━━━━━━━━━

  Overnight run: 5h 42m · 6 tasks · $8.14

  ✓ CLI scaffold with arg parsing and config
  ✓ Git watcher using fsnotify
  ✓ Slack webhook integration with formatting
  ✓ Unit tests (23 passing)
  ✓ Integration test with mock Slack endpoint
  ✓ README with usage and installation

  ⚠ One thing to look at:
  The git watcher polls every 5 seconds. I considered
  using inotify but it's not portable to macOS. If you
  want cross-platform file watching, we should discuss
  the approach.

  Branches: 4 merged to main cleanly. No conflicts.
  Tests: all passing.

  Recommendation: ship. The core functionality works.
  The polling interval is configurable if 5s is too
  aggressive.

  → `hive review` to see diffs
  → `hive ship` to push

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

This is the Leadership UI briefing system (HIVE-LEADERSHIP-UI.md) in action.
The shift briefing format already describes this — overnight launch is just
the longest possible "since you left" window.

---

## Trust and Safety

Overnight runs operate within the existing trust ladder:

- **internal-safe + code-safe**: workers act freely (read, write, test, build)
- **external-gated**: anything touching the network goes to the approval
  queue. Workers cannot push, deploy, or send external messages without
  approval.
- **forbidden**: money, contracts, production data — never.

This means overnight runs produce *local* artifacts: branches, tests, code,
documentation. They do not push, deploy, or communicate externally. The
morning handoff is where the human reviews and takes external action.

If the goal requires external actions (e.g., "deploy to staging"), those
steps get queued as approval requests. The human wakes up, reviews the code,
approves the deploy.

### Cost Controls

Before launching, `hive dream` shows an estimated cost based on:
- Number of tasks × expected tokens per task type
- Model tier per task (Layer 3 routing)
- Steward oversight budget (typically low — mostly idle)
- A 2x safety margin

The estimate is not a hard cap. But it sets expectations. If the human
approves a $10 overnight run and it's trending toward $30, Maya should pause
and escalate.

---

## Failure Modes

### "Planner produces bad decomposition"

The most dangerous failure. Mitigation: validation constraints (scope
overlap check, done-condition check, task count bounds). Also: `--dry-run`
as default for the first few uses. Build trust in the planner before
trusting it to launch unsupervised.

### "Worker gets stuck in a loop"

The Ralph loop insight: a stuck agent should be killed and restarted, not
coaxed. Fresh context from files is better than accumulated confusion.
Mitigation: task timeout + retry budget + stale detection.

### "Workers produce conflicting changes"

Git worktree isolation prevents file conflicts. But semantic conflicts
(incompatible API assumptions across tasks) can still happen. Mitigation:
the steward monitors for cross-agent conflicts via summarized outputs.
The synthesis pass also explicitly checks for contradictions.

### "Overnight run goes off the rails"

The trust ladder prevents catastrophic action (no push, no deploy, no
external messages). The worst case for an overnight run is wasted tokens
and incorrect local code — both are reversible. The morning briefing
surfaces problems before the human takes any action.

### "Everything completed but the result is wrong"

The synthesis pass includes a recommendation, not just a status report.
Maya should flag uncertainty: "all tests pass but the architecture feels
over-engineered for what you asked for" or "this works but I'm not confident
about the error handling approach."

The human reviews before shipping. Overnight launch produces candidates,
not releases.

---

## Implementation Order

### Step 1: `hive dream` Entry Point

- New command: `src/commands/dream.ts`
- Maya runs in planning mode with structured output validation
- `--dry-run` shows plan without launching
- `--go` launches supervision after plan validation

### Step 2: Plan Validation

- Scope overlap detection (reuse existing scope conflict logic)
- Done-condition format validation
- Task count bounds
- Cost estimation

### Step 3: Worker Isolation via Worktrees

- Each worker gets a git worktree
- Supervisor manages worktree lifecycle (create on launch, clean on
  completion, merge on success)
- Branch naming convention: `task/<task-id>`

### Step 4: Task Timeout and Stale Recovery

- Supervisor checks worker age and file change recency
- Stale workers: kill, restart with fresh context
- Retry budget with escalation to human inbox

### Step 5: Synthesis Pass

- Maya reads all completed task results + repo state
- Produces handoff briefing in shift-briefing format
- Emits morning notification (feed event, optional system notification)

### Step 6: `hive dream --go` (Full Autonomy)

- Skip confirmation, launch immediately
- Only enable after the planner has been validated through `--dry-run` use
- This is trust-ladder Rung 4: full autonomy for low-stakes, reversible
  actions

---

## What This Is Not

This is not a framework. There is no agent-to-agent API, no plugin system,
no new runtime.

Every piece runs through existing file-backed coordination:
- Maya writes PLAN.md and BOARD.md
- Supervisor reads those and launches workers
- Workers produce code in git worktrees
- Maya reads results and writes a briefing
- Everything is inspectable on disk at any point

The overnight loop is the existing loop, with a structured entry point,
resilient execution, and a synthesized terminal condition.

---

## Relationship to OpenClaw

OpenClaw and HIVE aim at the same outcome — make an AI useful overnight —
with fundamentally different architectures.

### The Critical Difference

OpenClaw is **session-oriented**. Each run is bounded, serialized, and has
a timeout. There is no built-in goal tracker that persists and drives work
across sessions. Autonomy is assembled from composable primitives — cron
jobs fire at intervals, heartbeats check in every 30 minutes, sub-agents
decompose parallel work — but the continuation impulse must come from
outside: a cron schedule, a Ralph loop bash script, or the user.

HIVE is **goal-oriented**. The board IS the goal tracker. The supervisor IS
the continuation engine. `hive dream` sets a goal, the board tracks progress
toward it, and the supervisor keeps driving work until the board is clean.
No external script needed. The system itself knows when it's done.

This is why `hive dream` is genuinely novel, not just a wrapper around
existing agent patterns.

### Architecture Comparison

| | OpenClaw | HIVE |
|---|---|---|
| **Identity** | Single agent, SOUL.md injected every turn (20K char cap per file) | Multi-persona hive, SOUL.md inlined in prompt, identity files by reference |
| **Continuation** | Session-oriented. External trigger needed (cron, Ralph, user) | Goal-oriented. Board + supervisor drive work until done |
| **Coordination** | Sub-agents via Gateway RPC. Depth-limited. Push-based completion | File-backed board + messages. Workers scoped. Supervisor launches |
| **Resilience** | Ralph loop (external bash script, restart single agent) | Supervisor + worktrees (restart individual workers, multiple in parallel) |
| **Context** | Compaction (summarize old turns). Pre-flush: agent writes facts to disk before compression | Delta packets (only changes since last turn). Workers start fresh each time |
| **Trust** | Approval via messaging channel (Telegram/Slack) | File-backed approval queue + trust ladder + gateway UI |
| **Memory** | Two-layer (daily logs + curated MEMORY.md) + optional vector search | Four-layer (operating knowledge, project memory, journal, entities) |
| **Wake-up** | Morning check-in via Telegram | Shift briefing via gateway or CLI |

### What HIVE Should Learn From OpenClaw

**Workers should be as disposable as Ralph loop iterations.** Fresh context
from files beats accumulated confusion. Kill and restart, don't coax.

**The "is it done?" check should be mechanical.** OpenClaw's Ralph loop
checks if PRD boxes are ticked. No negotiating with a confused model. HIVE's
board tasks should have the same binary clarity.

**The morning handoff should feel personal.** OpenClaw's conversational
interface creates intimacy. HIVE's briefing system should create the same
feeling through narrative, not chat — "while you were away, here's what
your team built" is more compelling than a status table.

**Pre-compaction memory flush is smart.** Before context compression,
OpenClaw gives the agent a turn to write durable facts to disk. HIVE
workers should do something similar before exiting — flush learnings to
the log and memory before the context window dies.

**Sub-agents get minimal context.** OpenClaw only gives sub-agents AGENTS.md
and TOOLS.md, not the full identity stack. HIVE workers should get their
assignment, their persona, and the relevant scope — not the full hive state.
Layer 3 (cognitive resources) already designs for this.

### Where HIVE Is Structurally Better

**Parallel execution.** OpenClaw's sub-agents can parallelize but it's
Gateway-mediated and depth-limited. HIVE's supervisor natively manages
multiple workers in parallel with scope isolation. An overnight run with
4 workers completing 4 tasks simultaneously is 4x faster than serial.

**Inspectable coordination.** OpenClaw's coordination lives in context
windows and Gateway memory. HIVE's lives in files on disk. You can kill
every process, restart, and the board + messages tell the system exactly
where to pick up. Nothing is lost.

**Goal persistence.** OpenClaw's Ralph loop reads a PRD file but doesn't
maintain cross-session state about what's been tried, what failed, and why.
HIVE's board tracks task status, worker results, and steward decisions
across any number of restarts.

---

## The Full Stack

```
Layer 4: Overnight Launch
         hive dream → plan → execute → synthesize → brief
         (this document)
              │
Layer 3: Cognitive Resources
         tiered models, local inference, usage tracking
         (COGNITIVE-RESOURCE-MANAGEMENT.md)
              │
Layer 2: Persistent Steward
         live Maya session, delta-aware, fast interaction
         (PERSISTENT-STEWARD-DESIGN.md)
              │
Layer 1: Coordination Substrate
         files, board, messages, supervisor, workers, gateway
         (implemented — Phase 1-5)
```

Build up. Each layer makes the next one possible.
