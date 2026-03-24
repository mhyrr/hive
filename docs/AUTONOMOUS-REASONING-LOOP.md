# Autonomous Reasoning Loop

Design document. March 2026.

Depends on: [Persistent Steward Design](./PERSISTENT-STEWARD-DESIGN.md), [Cognitive Resource Management](./COGNITIVE-RESOURCE-MANAGEMENT.md), [Overnight Launch](./OVERNIGHT-LAUNCH.md)

---

## The Problem

HIVE has three operational modes today:

1. **`hive say`** — human sends a message, Maya responds, session dies.
2. **`hive console`** — human and Maya converse interactively; Maya can delegate to workers. The human drives every turn.
3. **`hive dream`** (designed, not built) — human provides a goal, Maya plans, workers execute a known plan, Maya synthesizes a morning briefing.

The gap is between 2 and 3. `hive dream` executes a *predetermined plan* — decompose, fan out, collect results, report. That's project management, not reasoning. The plan is fixed at the start. If a worker discovers that the approach is wrong, that the problem was misunderstood, or that a new question needs answering before the original one can be resolved — the system has no way to respond. The plan doesn't learn.

What's missing is the ability to give Maya an *open question* — something where the answer isn't known, the decomposition isn't obvious, and the path forward depends on what she discovers along the way. The human is currently the reasoning loop: they read results, update their understanding, decide what to investigate next, and tell Maya what to do. That loop needs to move inside the system.

This is not `hive dream` with more steps. It's a fundamentally different cognitive mode: **investigation**, not execution.

---

## Core Insight

The key architectural idea is separating *goal state* from *plan state*.

`hive dream` collapses these: the goal IS the plan. "Build X" decomposes into tasks, and tasks are the goal. But for open questions — "Why is latency spiking on the write path?" or "What's the right caching strategy for this workload?" — the goal is a *question to resolve*, and the plan is a hypothesis about how to resolve it that *changes as evidence arrives*.

The reasoning loop needs a first-class **goal object** that:
- Persists across steward cycles (not in the context window)
- Tracks accumulated evidence, not just task completions
- Allows the plan to mutate based on what's learned
- Knows when it's resolved, stuck, or needs the human

The goal object is the thing `hive dream` doesn't have: a representation of *understanding* that evolves.

---

## Goal Representation

### The Data Structure

A goal is a markdown file with YAML frontmatter, stored at:

```
~/.hive/projects/<project>/goals/<goal-id>.md
```

```markdown
---
id: goal-20260322-001
status: active          # active | paused | resolved | stuck | abandoned
created: 2026-03-22T22:00:00Z
updated: 2026-03-22T23:15:00Z
iterations: 3
max_iterations: 12
token_budget: 500000
tokens_spent: 84200
human_checkpoint: 6     # surface to human every N iterations
---

# Why is the write path 3x slower than expected?

## Current Understanding
Write latency is dominated by the journaling layer, not the storage engine.
The fsync policy is per-entry rather than batched, which explains the 3x
gap vs. read path. This is a correctness-vs-performance tradeoff, not a bug.

## Open Questions
- Is batched fsync safe given our crash recovery guarantees?
- What batch window would bring latency within 1.5x of read path?
- Does the WAL implementation already support group commit?

## Evidence Log
### Iteration 3 (2026-03-22T23:15:00Z)
- [architect] Storage engine profiling shows <2ms per write at engine level.
  The 15ms observed latency is above the engine. → Journaling layer is the suspect.
- [scout] Found that fsync is called per journal entry (journal.ts:142).
  No batching. This matches the latency profile exactly.
- **Update**: Revised understanding from "storage engine bottleneck" to
  "journaling fsync policy." Root cause identified. Remaining question is
  whether batching is safe.

### Iteration 2 (2026-03-22T22:45:00Z)
- [craftsman] Benchmark harness built. Write path: 15ms p50, read path: 5ms p50.
  Confirmed 3x gap is real, not measurement artifact.
- [scout] Similar systems (RocksDB, LevelDB) batch fsync at 10ms windows.
  Our system does not.

### Iteration 1 (2026-03-22T22:15:00Z)
- [scout] Codebase scan: write path touches storage engine, journal, and
  index. Three candidate bottlenecks.
- [architect] Architecture review: journal is write-ahead, storage is
  append-only. Suggests journal or fsync as likely bottleneck, not data
  structure overhead.

## Discarded Hypotheses
- "Storage engine B-tree rebalancing" — ruled out by profiling (iteration 3)
- "Index contention" — ruled out; index updates are append-only (iteration 1)

## Plan (current)
1. ✓ Confirm the 3x gap with a benchmark
2. ✓ Profile the write path to isolate the bottleneck
3. ✓ Identify root cause in journaling layer
4. → Research group commit / batched fsync safety
5. · Prototype batched fsync with configurable window
6. · Benchmark the prototype against baseline
```

### Why This Shape

**Markdown, not JSON.** Consistent with every other HIVE artifact. Human-readable. Git-diffable. An agent can read it cold and immediately understand the state of the investigation.

**Evidence log, not task log.** The evidence log records *what was learned*, not just *what was done*. "Architect completed task" is useless. "Architect found that fsync is per-entry, explaining the 3x gap" is knowledge that changes the plan.

**Current Understanding is the primary artifact.** This is the section Maya rewrites after each iteration. It's the running answer to the goal question. When this section is stable and complete, the goal is resolved.

**Discarded Hypotheses prevent loops.** Without tracking what's been ruled out, an autonomous system will re-investigate dead ends. This is the cheapest form of memory for a reasoning loop.

**Plan is mutable.** Steps get added, removed, and reordered as evidence arrives. The plan at iteration 5 may look nothing like the plan at iteration 1. That's the point — the plan serves the goal, not the other way around.

---

## The Reasoning Cycle

One iteration of the loop:

```
┌─────────────────────────────────────────────────┐
│ 1. ORIENT                                       │
│    Read goal file. Read board state.             │
│    Load evidence from last iteration.            │
│    Assess: has anything changed?                 │
│                                                  │
│ 2. ASSESS                                       │
│    Given current understanding + new evidence:   │
│    - Is the goal resolved?          → terminate  │
│    - Is the goal stuck?             → escalate   │
│    - Is the plan still valid?       → continue   │
│    - Does the plan need revision?   → revise     │
│    - Is it time for human checkpoint? → pause    │
│                                                  │
│ 3. DECIDE                                       │
│    What's the highest-value next action?         │
│    Options:                                      │
│    a) Delegate a scoped investigation to a worker│
│    b) Delegate a build task to a worker          │
│    c) Act directly (read files, run commands)    │
│    d) Split the goal into sub-goals              │
│    e) Pause and surface to human                 │
│                                                  │
│ 4. ACT                                          │
│    Execute the decision:                         │
│    - Create assignment messages for workers      │
│    - Update board with new tasks                 │
│    - Update the goal file with revised plan      │
│                                                  │
│ 5. WAIT                                         │
│    Workers execute. Tier-1 compresses results.   │
│    Supervisor manages process lifecycle.          │
│    Watcher detects completions.                  │
│                                                  │
│ 6. INTEGRATE                                    │
│    Read compressed worker results.               │
│    Update Evidence Log.                          │
│    Revise Current Understanding.                 │
│    Update or discard hypotheses.                 │
│    Mark completed plan steps.                    │
│    Write updated goal file to disk.              │
│                                                  │
│         ──→ back to step 1 ──→                   │
└─────────────────────────────────────────────────┘
```

### How This Differs From `hive dream`

`hive dream` does steps 1, 4, 5, and a final synthesis. No assess. No revise. No integrate-and-loop. The plan is static. The steward is a project manager.

The reasoning loop adds the cognitive steps: assess progress against understanding, revise the plan based on evidence, integrate results as knowledge rather than deliverables. The steward is an investigator.

### How This Differs From the Human-Turn Model

In `hive console`, the human performs steps 1-3 (orient, assess, decide) and tells Maya to do step 4 (act). The reasoning loop moves steps 1-3 inside Maya. The human only enters when Maya hits a checkpoint, gets stuck, or resolves the goal.

---

## Termination Conditions

### Resolved

Maya writes a stable Current Understanding that answers the original question. The plan is complete or irrelevant (the answer came from a different direction). Maya produces a resolution summary and marks the goal `resolved`.

**Test:** Can Maya state the answer in 2-3 sentences? If the understanding section keeps changing, the goal isn't resolved.

### Stuck

Three signals:
1. **No progress.** Two consecutive iterations produce no new evidence and no plan changes. The loop is spinning.
2. **Contradiction.** Evidence conflicts and Maya can't resolve it without domain knowledge she doesn't have.
3. **Scope explosion.** Open questions are growing faster than they're being answered. The investigation is diverging, not converging.

When stuck, Maya writes what she knows, what she doesn't, and what she'd try next — then marks the goal `stuck` and surfaces to the human.

### Human Needed

Not stuck, but a decision point requires human judgment:
- The investigation found something that changes the original premise
- A decision has irreversible consequences (architectural choice, data migration)
- The cost of being wrong exceeds the cost of waiting for human input

Maya pauses the goal, writes a clear decision request (options, tradeoffs, recommendation), and marks the goal `paused`.

### Budget Exhausted

Token budget or iteration cap reached. Maya writes a progress summary and pauses. The human can extend the budget or redirect.

---

## Evidence Accumulation

Workers currently produce deliverables: files, code, documents. In reasoning mode, results are also *evidence* — observations that update Maya's model of the problem.

### The Evidence Contract

When Maya delegates to a worker in reasoning mode, the assignment includes a **question**, not just a task:

```markdown
---
type: assign
from: steward
to: architect
task: Profile the write path and identify where the 15ms latency accumulates
scope: src/storage/, src/journal/
launch: auto
goal: goal-20260322-001
evidence-request: Where does time accumulate? What's the split between storage engine, journal, and fsync?
---
```

The `evidence-request` field tells the worker what *knowledge* Maya needs, beyond whatever artifacts they produce. The worker's completion summary (compressed by tier-1) includes an evidence section.

### How Evidence Feeds Back

After tier-1 compresses a worker's output, the digest includes:
- `summary`: what was done
- `outcome`: success / partial / blocked / failed
- `evidence`: answers to the evidence-request questions
- `surprises`: anything unexpected that the steward should know

Maya reads the `evidence` and `surprises` fields to update her understanding. The `summary` and `outcome` update the plan. This separation — knowledge vs. status — is what makes the loop learn instead of just execute.

---

## Cost Governance

An autonomous reasoning loop without throttles is an expensive runaway process. Five mechanisms:

### 1. Iteration Cap

Default: 12 iterations. Configurable per goal. Each iteration = one ORIENT→INTEGRATE cycle. At cap, Maya writes progress summary and pauses.

### 2. Token Budget

Per-goal token budget covering all tiers. Default: 500K tokens (~$5-15 depending on model mix). Maya tracks `tokens_spent` in the goal frontmatter. At 80%, Maya gets a warning in her context. At 100%, hard stop.

### 3. Human Checkpoints

Every N iterations (default: 6), Maya surfaces a progress report even if not stuck. The human can: continue, redirect, pause, or abandon. This prevents silent burn in the wrong direction.

### 4. Diminishing Returns Detection

If the evidence log shows decreasing information gain — each iteration's evidence section is shorter and less novel than the last — Maya should notice and consider whether she's stuck or done, not blindly continue.

### 5. Time Limit

Wall-clock timeout. Default: 4 hours. Prevents runaway loops when the human steps away. Maya writes a progress summary at timeout.

### Cost Visibility

The goal file's frontmatter tracks tokens spent. The gateway's `/api/cognition` endpoint (from the cognitive resource design) reports goal-level spend alongside tier-level spend. The human can see what each investigation costs.

---

## Integration Points

### What Exists and Gets Reused

| Component | Role in Reasoning Loop |
|---|---|
| **Board** | Tasks spawned by reasoning iterations appear on the board like any other task |
| **Messages** | Worker assignments use the existing message system with `goal:` frontmatter |
| **Supervisor** | Launches and manages worker processes, unchanged |
| **Watcher** | Detects worker completions, triggers next iteration |
| **Tier-1** | Compresses worker output into evidence-bearing digests |
| **Persistent steward** | Maya's session persists across iterations within a reasoning run |
| **Run ledger** | Each reasoning loop is a run, trackable via `hive ps` |

### What's New

| Component | Purpose |
|---|---|
| **Goal file** | `goals/<id>.md` — the persistent representation of the investigation |
| **Reasoning driver** | A loop that orchestrates ORIENT→INTEGRATE cycles, calling into the existing steward session |
| **Goal-aware assignment** | Assignment messages with `goal:` and `evidence-request:` fields |
| **Goal-aware tier-1 compression** | Worker output compression that extracts evidence alongside summary |
| **Goal lifecycle commands** | `hive think`, `hive goals` for CLI interaction |

### Architecture Diagram

```
human
  │
  │  hive think "why is the write path slow?"
  │
  ▼
reasoning driver (new)
  │
  │  creates goal file
  │  enters ORIENT→INTEGRATE loop
  │
  ├──→ persistent steward session (existing)
  │      │
  │      │  ORIENT: reads goal file + board
  │      │  ASSESS: evaluates progress
  │      │  DECIDE: picks next action
  │      │  ACT: creates assignment messages
  │      │
  │      ▼
  │    supervisor (existing) ──→ workers (existing)
  │      │                          │
  │      │  manages lifecycle       │  scoped investigation
  │      │                          │
  │      ▼                          ▼
  │    watcher (existing)        results + evidence
  │      │
  │      │  detects completions
  │      ▼
  │    tier-1 compression (existing, enhanced)
  │      │
  │      │  extracts evidence
  │      ▼
  └──→ INTEGRATE: steward updates goal file
         │
         └──→ back to ORIENT
```

The reasoning driver is the only genuinely new component. Everything else is the existing system with minor extensions (goal-aware assignments, evidence-bearing compression).

---

## Entry Point

```bash
# Start an investigation
hive think "why is the write path 3x slower than expected?"

# Start from a file with more context
hive think --from investigation-brief.md

# Review active goals
hive goals

# Check on a specific goal
hive goals goal-20260322-001

# Resume a paused goal
hive goals resume goal-20260322-001

# Abandon a goal
hive goals abandon goal-20260322-001
```

### How `hive think` Differs From `hive dream`

| | `hive dream` | `hive think` |
|---|---|---|
| **Input** | A deliverable to build | A question to answer |
| **Plan** | Fixed at start | Evolves with evidence |
| **Workers produce** | Code and artifacts | Evidence and artifacts |
| **Steward role** | Project manager | Investigator |
| **Termination** | All tasks complete | Understanding achieved |
| **Output** | Morning briefing + branches | Resolution summary + evidence trail |

### Why Not `hive pursue`?

"Think" is more honest. "Pursue" implies the system will relentlessly chase an outcome. "Think" implies the system will reason about a question and might conclude "I don't know" or "this needs your input." The command name should set accurate expectations about what the system actually does.

---

## What We're NOT Building

**Not a general AGI loop.** This is scoped to investigation and analysis within a codebase and its surrounding context. Maya can read files, run commands, delegate to workers, and reason about results. She can't browse the web, call APIs, or interact with external systems (trust ladder applies).

**Not planning-as-reasoning.** `hive dream` remains the right tool for "build X." The reasoning loop is for "understand X" or "decide X." If Maya's investigation concludes with "here's what to build," the human can feed that into `hive dream`.

**Not infinite autonomy.** Human checkpoints are mandatory, not optional. The iteration cap and token budget are hard limits. This is a tool for extending human cognition, not replacing it.

**Not a hypothesis tree data structure.** The goal file tracks hypotheses in prose (Current Understanding + Discarded Hypotheses), not as a formal tree. Prose is more expressive, easier for agents to read and write, and doesn't require a parser. If we discover that prose is insufficient — that Maya loses track of branching hypotheses — we can formalize later. Start simple.

**Not multi-goal orchestration.** One active goal per reasoning run. If an investigation spawns sub-questions, they're tracked as Open Questions within the goal file, not as separate goal objects. Multi-goal orchestration is a future concern that adds coordination complexity we haven't earned yet.

---

## Open Questions

**1. Goal file vs. steward context window.** The goal file is the durable state, but the steward also accumulates context across iterations in its Pi Agent session. If the session crashes mid-investigation, the goal file should contain enough state to resume. Is the current design sufficient for cold restart? Needs testing.

**2. Worker evidence quality.** The evidence contract asks workers to answer specific questions. Can workers reliably produce useful evidence summaries, or will tier-1 compression lose the signal? May need structured evidence output formats rather than free-text.

**3. Iteration pacing.** Should iterations run as fast as workers complete (potentially multiple iterations per minute), or should there be a deliberate pause between iterations for the steward to "think"? Fast iteration burns tokens quickly. Slow iteration wastes wall clock. The right pace probably depends on the complexity of the question.

**4. Goal decomposition threshold.** When should Maya split a goal into sub-goals (separate files, separate reasoning loops) vs. tracking sub-questions within a single goal? The design says single-goal for now, but large investigations may need decomposition. What's the trigger?

**5. Interaction between `think` and `dream`.** If Maya's investigation concludes with a build plan, can she directly launch a `dream` run? Or should she always surface to the human first? The trust ladder says surface, but the user experience might benefit from chaining: investigate → plan → build → report.

**6. Evidence persistence beyond goal resolution.** When a goal is resolved, should the evidence and understanding persist somewhere accessible? Future investigations might benefit from knowing "we already looked into fsync behavior in March 2026." This connects to HIVE's broader memory architecture but isn't scoped here.

**7. Steward model choice.** Investigation requires the steward's best reasoning — Opus-class. But 12 iterations of Opus ORIENT→INTEGRATE is expensive. Could some iterations (especially early reconnaissance) use a cheaper model? The cognitive routing design supports model swapping mid-session, but the policy for when to downgrade during reasoning is undefined.
