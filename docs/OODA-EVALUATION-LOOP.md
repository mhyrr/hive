# OODA Evaluation Loop

Design document. March 2026.

Builds on: [Autonomous Reasoning Loop](./AUTONOMOUS-REASONING-LOOP.md), [Autonomous Loop Research](./AUTONOMOUS-LOOP-RESEARCH.md)

---

## The Frame

Greg's insight: the frontier model already has GM-level positional evaluation. What it lacks is the *loop* — the architectural trigger that says "evaluate now," the interrupt that says "stop, the board changed," and the orientation context that makes evaluation meaningful rather than generic.

The autonomous reasoning loop design got the goal representation right. What it got wrong — or rather, what it didn't attempt — is the *tempo*. `hive think` as designed is a sequential ORIENT→INTEGRATE cycle with workers doing the heavy lifting and Maya synthesizing between rounds. That's fine for deep investigation. But it's one loop where there should be two, and it has no interrupt capability. A worker discovers the premise is wrong on iteration 3, and Maya doesn't find out until the integration step of iteration 3. That's Boyd's lesson: the adversary who cycles faster wins, and "faster" is an architectural property, not a cognitive one.

This document designs the two-loop OODA architecture that makes HIVE cycle fast.

---

## Two Loops, Not One

### The Tactical Loop (~200ms cycle)

Event-driven. Cheap. Runs continuously while HIVE is active.

This is the **observe-evaluate-route** loop. It doesn't reason deeply. It watches for signals, evaluates whether they matter, and routes them to the right response. Think of it as the peripheral vision — always on, mostly quiet, but it catches the thing moving at the edge of the frame.

```
event arrives (file change, worker completion, human message, error)
    │
    ▼
signal filter: is this noise or signal?
    │ noise → discard
    │ signal ↓
    ▼
positional evaluation: what does this mean given current orientation?
    │
    ▼
route decision:
    ├── no action needed → log, continue watching
    ├── tactical response → dispatch immediately (update board, ack message, reassign)
    ├── strategic trigger → wake the strategic loop
    └── interrupt → break in-flight work, start new OODA cycle
```

**What runs it:** The existing `watcher.ts` infrastructure. It already fires on file changes in feed.md, msg/, BOARD.md, and runs/active/ with 200ms debounce. Today it dispatches mechanically — assignment detected → launch worker. The change is adding an *evaluation pass* between detection and dispatch.

**What the evaluation costs:** A single Haiku/Sonnet call with a focused prompt. ~500 input tokens (signal description + orientation summary), ~100 output tokens (classification + routing decision). Under 200ms latency, under $0.001 per evaluation. Cheap enough to run on every signal.

### The Strategic Loop (minutes to hours)

Goal-driven. Deep. Runs when triggered by the tactical loop or on a cadence.

This is the **orient-decide-act** loop from the reasoning loop design. Maya reads the goal, assesses progress against evidence, revises the plan, and dispatches work. The ORIENT→INTEGRATE cycle from the previous design lives here, nearly unchanged.

```
trigger arrives (tactical loop wakes it, timer fires, human nudge)
    │
    ▼
full orientation: read goal file, board, evidence, messages
    │
    ▼
deep evaluation: what's the state of this investigation?
    │ resolved → terminate
    │ stuck → escalate
    │ budget exceeded → pause
    │ human checkpoint → surface
    │ on track ↓
    ▼
plan revision: given new evidence, is the plan still right?
    │
    ▼
dispatch: assign workers, update goal file, update board
    │
    ▼
    └── return to waiting (tactical loop watches for completions)
```

**What runs it:** A new `think-loop` driver that wraps the persistent steward session. This is the "reasoning driver" from the previous design, now explicitly positioned as the inner strategic loop that the tactical loop triggers.

**Cadence:** Not fixed. The tactical loop wakes it when something meaningful happens — a worker completes, evidence arrives, a human message lands. There's also a safety-net timer (configurable, default 5 minutes) that wakes it even if the tactical loop hasn't fired, to catch state that accumulated below the signal threshold.

### How They Nest

```
┌─────────────────────────────────────────────────────┐
│  TACTICAL LOOP (continuous, event-driven, ~200ms)   │
│                                                     │
│  watcher → signal filter → evaluation → route       │
│       ↑                          │                  │
│       │                          ├── tactical action │
│       │                          ├── log + continue  │
│       │                          └── wake strategic  │
│       │                                   │         │
│  ┌────┼───────────────────────────────────┼────┐    │
│  │    │   STRATEGIC LOOP (on-demand)      │    │    │
│  │    │                                   ▼    │    │
│  │    │   orient → evaluate → decide → act     │    │
│  │    │       ↑                        │       │    │
│  │    │       └────────────────────────┘       │    │
│  │    │                                        │    │
│  │    │   dispatches workers, updates goals    │    │
│  └────┼────────────────────────────────────────┘    │
│       │                                             │
│       └── watches for worker completions            │
└─────────────────────────────────────────────────────┘
```

The tactical loop is the clock. The strategic loop is the brain. The tactical loop runs always; the strategic loop runs only when there's something worth thinking about. This separation is what gives the system its tempo advantage — you don't pay Opus prices to notice a file changed, and you don't use Haiku to reason about whether an investigation is stuck.

---

## The Evaluation Pass

This is the new primitive. Everything else is existing infrastructure with better wiring.

### What It Is

A fast, focused model call that takes a signal and an orientation context, and returns a classification and routing decision. It's the GM glancing at the board — not calculating 20 moves deep, just recognizing the pattern and knowing what kind of move this position calls for.

### Prompt Shape

```
You are the tactical evaluator for a running HIVE system.

## Current Orientation
{orientation_summary}

## Signal
{signal_type}: {signal_description}
{signal_payload_excerpt}

## Active Context
- Goal: {active_goal_title_or_none}
- Workers in flight: {worker_count} ({worker_summaries})
- Board state: {board_digest}
- Last strategic evaluation: {timestamp}

## Evaluate
Given the orientation and signal:
1. CLASSIFICATION: [noise | status_update | evidence | blocker | reorientation_trigger | interrupt]
2. URGENCY: [background | normal | urgent | critical]
3. ROUTING: [discard | log | tactical_action:{action} | wake_strategic | interrupt:{worker_id}]
4. REASONING: One sentence explaining why.
```

### Model Choice

Haiku for the tactical evaluation. This needs to be fast and cheap, not deep. The evaluation is pattern recognition, not reasoning — "a worker completed with new evidence" is an obvious strategic trigger; "a file changed in an unrelated directory" is noise. Haiku handles this.

If Haiku classification confidence is low (the model hedges or outputs contradictory signals), escalate to Sonnet for a second opinion. This should be rare — less than 5% of evaluations. If it's higher, the orientation context is stale or the signal taxonomy is wrong.

**Latency budget:** 300ms total for the evaluation pass, including network. Haiku's typical response time is 100-200ms. That leaves room for prompt assembly and parsing. If it regularly exceeds 300ms, something is wrong with the prompt size.

**Token budget:** 800 tokens in, 150 tokens out. The orientation summary and signal excerpt must fit in this envelope. If they don't, they're too verbose — compress them, don't expand the budget.

### What It Reads

The evaluation pass does NOT read files. It receives pre-assembled context:

- **Orientation summary:** A compressed snapshot of current orientation (see next section). Cached, updated only when orientation changes. ~200 tokens.
- **Signal description:** What happened, generated by the watcher. Type + path + excerpt. ~100 tokens.
- **Active context:** Board digest, worker list, goal title. Already computed by the watcher/supervisor. ~200 tokens.

Everything the evaluation needs is already in memory or cheaply derivable. No disk reads in the hot path.

### What It Outputs

A structured response parsed into a `TacticalEvaluation`:

```typescript
type SignalClass = 'noise' | 'status_update' | 'evidence' | 'blocker' | 'reorientation_trigger' | 'interrupt';
type Urgency = 'background' | 'normal' | 'urgent' | 'critical';

type TacticalRouting =
  | { action: 'discard' }
  | { action: 'log' }
  | { action: 'tactical'; command: string }  // e.g., "ack_message", "update_board", "reassign_worker"
  | { action: 'wake_strategic' }
  | { action: 'interrupt'; workerId: string };

type TacticalEvaluation = {
  classification: SignalClass;
  urgency: Urgency;
  routing: TacticalRouting;
  reasoning: string;
  timestamp: string;
};
```

### The Evaluation Log

Every evaluation is appended to a rotating log: `~/.hive/projects/<project>/eval-log.jsonl`. One line per evaluation. Capped at 1000 entries, oldest rotated out. This is the system's operational telemetry — how fast is the loop cycling, what percentage of signals are noise, how often does the tactical loop wake the strategic loop, how often do interrupts fire.

This log is never loaded into a prompt. It's for the human operator and for future meta-evaluation (tuning signal filters, adjusting thresholds).

---

## Orientation: The Lens, Not the Data

### What Orientation Is

Orientation is the accumulated context that makes evaluation meaningful. It's not "what happened" (that's observation). It's "what matters and why" — the interpretive frame.

In HIVE, orientation is composed of:

1. **Soul context.** SOUL.md, IDENTITY.md, persona. The system's values and character. Changes rarely (deliberate edits only).
2. **Project context.** Board state, plan, active goals, recent decisions. Changes with every strategic cycle.
3. **Situational model.** "What's happening right now" — active workers, in-flight goals, pending human decisions, known blockers. Changes with every significant event.
4. **Learned patterns.** Project memory — conventions, past decisions, facts. Changes as the team learns.

Layers 1 and 4 are slow-moving. Layer 2 is medium-tempo. Layer 3 is fast. The orientation update mechanism respects these different rates of change.

### The Orientation Summary

A compressed text artifact (~200 tokens) that the tactical evaluator reads. Generated and cached. NOT a prompt that's assembled fresh each time — that would defeat the speed requirement.

```markdown
## Orientation [updated: 2026-03-22T23:15:00Z]
Active goal: Why is the write path 3x slower than expected?
State: Root cause identified (journaling fsync). Evaluating batching safety.
Workers: architect profiling storage, scout researching group commit.
Posture: converging — evidence quality high, plan on track.
Watch for: worker completions with evidence, contradictory findings re: fsync safety.
Ignore: routine file changes in src/, board formatting updates.
```

This is what makes the tactical evaluator fast and accurate. Without it, every evaluation is from scratch — expensive and noisy. With it, the evaluator has the interpretive frame it needs to classify signals correctly.

### When Orientation Updates

Orientation is NOT updated on every signal. That would couple the fast loop to the slow loop and destroy tempo. Instead:

**Patch updates** (fast, frequent):
- Worker completes → update worker list in situational model
- Board changes → update board state
- Human message arrives → note pending human input
- Goal file changes → update goal state summary

These are mechanical — no model call required. Parse the change, update the cached summary fields.

**Full reorient** (slow, deliberate):
- Strategic loop completes a cycle → regenerate orientation summary from goal file + board + evidence
- Orientation age exceeds threshold (default: 10 minutes without strategic cycle) → force reorient
- `reorientation_trigger` classification from tactical evaluator → immediate reorient

A full reorient is a Sonnet call that reads the current goal file, board, recent evidence, and produces a fresh orientation summary. ~1000 tokens in, ~200 tokens out. Takes 500ms-1s. Runs inside the strategic loop, not the tactical loop.

**The rule:** Tactical loop patches orientation mechanically. Strategic loop regenerates orientation with cognition. If the tactical loop can't classify a signal confidently, that's a symptom of stale orientation — trigger a reorient, don't make the evaluation smarter.

---

## The Interrupt Protocol

### The Problem

A worker is mid-execution. Three minutes into a 10-minute profiling run, a human message arrives: "Stop — we found it's a config issue, not a code issue." Or: another worker completes and its evidence makes the current worker's task moot.

Today, HIVE has no interrupt. Workers run to completion. The steward finds out at integration time. That's the "finish task then check in" anti-pattern Boyd warned about.

### Signal-Based Interrupt

Workers in HIVE are child processes (Claude Code, Codex, Gemini CLI). They can be signaled but not mid-stream redirected — these aren't cooperative coroutines, they're LLM sessions.

The realistic interrupt protocol:

1. **Tactical evaluator classifies signal as `interrupt`.** Includes the worker ID.
2. **Interrupt file written:** `~/.hive/projects/<project>/runs/active/<run-id>/interrupt.md` with reason and instructions.
3. **Worker process receives SIGTERM** (not SIGKILL — give it a chance to flush).
4. **Partial work preserved.** Whatever the worker has written to disk stays. The run record is updated with `status: interrupted` and `interrupt_reason:`.
5. **Strategic loop wakes immediately.** Evaluates the interrupted worker's partial output alongside the interrupting signal. Decides: reassign, redirect, or discard.

### What Gets Preserved

- Files the worker has already written or modified
- The run record with timing and any partial output captured
- The interrupt reason (so the next cycle understands why)

What's lost: the worker's in-flight context window. That's acceptable. Workers are disposable — continuity lives in files, not sessions. This is exactly the "Ralph loop" insight from the research: fresh workers are fine if the steward can reconstruct state from disk.

### Interrupt Discipline

Not every signal justifies killing a worker. The tactical evaluator must meet a threshold:

- **`interrupt`** classification requires `critical` urgency. Anything less gets `wake_strategic`, which processes the signal after the worker finishes naturally.
- Interrupts of workers that are >80% through their estimated work are downgraded to `wake_strategic` — let them finish, the marginal cost of waiting is lower than the cost of lost work.
- No more than one interrupt per 60 seconds per worker. If the tactical loop is firing interrupts that fast, something is wrong at the strategic level — escalate to the human.

---

## Mapping to Existing HIVE Components

### What Exists and Gets Extended

| Component | Current Role | OODA Role |
|---|---|---|
| **`watcher.ts`** | Detects file changes, triggers worker launches | The **observation** primitive. Extended with signal classification dispatch to the evaluation pass. |
| **Supervisor** | Manages worker lifecycle, launches on assignment | Unchanged for launch. Gains **interrupt capability** (SIGTERM + interrupt file). |
| **Steward (Pi Agent session)** | Orchestrates work via prompts and delegation | Becomes the **strategic loop brain**. Orientation context replaces generic prompt context. |
| **Board** | Task tracking | Unchanged. Strategic loop reads and writes it as before. |
| **Messages** | Agent-to-agent communication | Unchanged. Tactical loop watches for new messages as signals. |
| **Goal files** | (New in reasoning loop design) Investigation state | Unchanged from previous design. Strategic loop's primary state artifact. |
| **Run ledger** | Process tracking | Extended with `interrupt` status and `interrupt_reason` field. |
| **Tier-1 compression** | Worker output summarization | Unchanged. Strategic loop reads compressed output at integration time. |
| **Gateway** | Web UI and API | Extended with `/api/eval-log` endpoint for evaluation telemetry and `/api/orientation` for current orientation snapshot. |

### What's New

| Component | Purpose | Size Estimate |
|---|---|---|
| **Tactical evaluator** | Signal → classification → routing. The evaluation pass. | ~200 lines. Prompt template + Haiku call + response parser. |
| **Orientation cache** | Cached orientation summary with patch and regenerate operations. | ~150 lines. In-memory summary + mechanical patch + Sonnet regen. |
| **Evaluation dispatcher** | Sits between watcher events and current dispatch logic. Routes to tactical evaluator, then to existing handlers or strategic loop. | ~100 lines. Event handler that wraps existing watcher callbacks. |
| **Interrupt handler** | Writes interrupt files, sends SIGTERM, updates run records. | ~80 lines. Extends supervisor. |
| **Eval log** | JSONL append + rotation for evaluation telemetry. | ~50 lines. |
| **Think loop driver** | Orchestrates the strategic ORIENT→INTEGRATE cycle, triggered by tactical loop or timer. | ~300 lines. This is the "reasoning driver" from the previous design, now event-triggered. |

Total new code: ~880 lines. That's a feature, not a rewrite.

---

## What's Buildable Now vs. What Requires New Infrastructure

### Buildable Now (existing infrastructure is sufficient)

**1. Evaluation dispatcher as a watcher wrapper.**
The watcher already fires typed callbacks (`onAssignment`, `onRunChange`, `onBoardChange`, `onMessageChange`). Wrapping these in an evaluation dispatch that calls Haiku before routing is straightforward. The watcher doesn't need to change — the dispatcher sits between watcher events and the existing callback handlers.

**2. Orientation cache with mechanical patches.**
Board digest, worker list, goal title — all of this is already computed by existing code (`digest.ts`, `board.ts`, `context.ts`). The orientation cache composes these into a compressed summary and patches it mechanically when components change. No new data sources required.

**3. Interrupt via SIGTERM + file.**
Worker processes are already tracked by the supervisor with PIDs. `process.kill(pid, 'SIGTERM')` and writing an interrupt file are trivial. The run record update is a frontmatter edit.

**4. Eval log as JSONL.**
`appendFileSync` to a JSONL file. Rotation is a file-size check + rename. Nothing exotic.

**5. Strategic loop as an event-triggered reasoning driver.**
The reasoning loop design already specced the ORIENT→INTEGRATE cycle. Making it event-triggered instead of self-scheduling is simpler, not harder — remove the internal loop, expose a `runStrategicCycle()` function, and let the tactical loop call it.

### Requires New Work

**1. Haiku call path.**
The runtime adapter system (`runtime.ts`) is designed for launching worker processes, not making fast API calls. The tactical evaluator needs a direct HTTP call to the Anthropic API — not a spawned Claude Code session. This means a lightweight API client for Haiku/Sonnet calls that bypasses the runtime adapter system entirely.

This is the single largest infrastructure gap. It's also the most valuable piece — a fast, cheap model call path unlocks evaluation, orientation regen, signal classification, and eventually any operation where you want model judgment without spawning a full agent session.

**Estimated work:** ~200 lines for a minimal Anthropic API client (Messages API, streaming optional, response parsing). Uses the existing `ANTHROPIC_API_KEY` from the environment. No SDK dependency — raw `fetch` calls.

**2. Orientation regeneration via Sonnet.**
Depends on the API client above. The regen prompt is simple but needs to be tuned — the orientation summary must reliably compress into ~200 tokens and must be specific enough that the tactical evaluator can act on it.

**3. Signal taxonomy tuning.**
The six signal classes (`noise`, `status_update`, `evidence`, `blocker`, `reorientation_trigger`, `interrupt`) are a starting hypothesis. They'll need tuning based on real evaluation log data. This isn't infrastructure — it's prompt engineering and threshold adjustment over time.

**4. Gateway extensions.**
`/api/eval-log` and `/api/orientation` endpoints. Small. Depends on the eval log and orientation cache existing.

---

## Positions Taken

**The evaluation pass is worth the cost.** Every tactical evaluation costs ~$0.001 and 200ms. In a session with 100 signals, that's $0.10 and 20 seconds total. The alternative is either (a) evaluating every signal in the strategic loop (slow, expensive) or (b) routing mechanically without evaluation (fast, dumb). The evaluation pass is the sweet spot — fast enough to not bottleneck the tactical loop, smart enough to filter noise and trigger interrupts.

**Haiku, not a rule engine.** It's tempting to build the signal classifier as a deterministic rule engine — "if worker completes and goal is active, wake strategic." Rules are faster and cheaper. But they're also brittle. The whole point of using a model is that it can handle novel signal combinations that rules can't anticipate. "A worker completed, but the human just said to stop, and another worker is about to complete with related evidence" — a rule engine needs explicit handling for every combination. Haiku handles it with orientation context.

That said: the signal filter *before* the evaluation can and should be rule-based. "File changed in a directory nobody's watching" → discard. Don't waste an API call on obvious noise. The model handles the ambiguous signals, not the obvious ones.

**Orientation summary, not orientation database.** There's an attractive nuisance here: build a structured orientation object with typed fields and change-tracking. Don't. The orientation summary is natural language because the consumer is a language model. Structured data would need to be serialized into the prompt anyway. Write it as prose, cache it as a string, patch it by string replacement or regeneration. When the orientation is wrong, you'll see it in evaluation quality, and you'll fix it by fixing the regen prompt, not by adding fields to a schema.

**Workers remain disposable.** The interrupt protocol doesn't try to "pause" workers or "resume" them. It kills them and preserves their partial output. This is the right tradeoff. LLM sessions aren't checkpointable in any meaningful way. Trying to build session pause/resume is a rat hole that adds complexity for marginal benefit. Kill, preserve partial work, reassess, reassign if needed.

**The API client is the real unlock.** The evaluation pass is the use case, but the lightweight API client is the infrastructure. Once HIVE can make fast, cheap model calls without spawning a full agent session, the design space opens dramatically — not just for evaluation, but for pre-flight prompt validation, cost estimation, message triage, and any operation where you want judgment without commitment. Build the API client right and it pays for itself ten times over.

**The 120s supervisor poll stays.** The tactical loop doesn't replace the safety-net poll. The poll catches the case where the watcher fails (filesystem events are not reliable on all platforms), where the evaluation dispatcher crashes, or where an edge case slips through. Belt and suspenders. The poll is cheap and prevents silent failure.

---

## The Unhobbling Argument, Concretely

Greg's framing: the model has GM-level evaluation capability. What it lacks is the loop.

Here's what that looks like in practice. Today when a worker completes with evidence that contradicts the current plan:

1. Worker writes results to disk.
2. Watcher detects completion after 200ms.
3. Supervisor marks the run complete.
4. Nothing happens until the steward's next turn (human-initiated in console, or next iteration in think).
5. Steward reads the results, realizes the plan is wrong, revises.

Steps 2-4 are dead time. The evidence exists but nothing evaluates it. The system has the signal but no trigger to process it.

With the OODA loop:

1. Worker writes results to disk.
2. Watcher detects completion after 200ms.
3. Tactical evaluator classifies: "worker completed with evidence bearing on active goal → `wake_strategic`."
4. Strategic loop wakes. Reads evidence. Revises plan. Dispatches next worker.

Dead time goes from "until human acts" to ~500ms. That's not incrementally better. It's categorically different. The system now *reacts to its own outputs* — which is what a reasoning loop actually is.

The moat is real: this loop speed is a property of the framework, not the model. A competitor using the same Opus for strategic reasoning but polling every 30 seconds instead of evaluating every 200ms will always be a full cycle behind. And orientation context — SOUL.md, project memory, the specific interpretive frame — is inherently local. Frontier labs can't ship your orientation.

---

## Build Sequence

1. **Lightweight Anthropic API client.** This unblocks everything else. Raw `fetch` to Messages API, Haiku and Sonnet, response parsing. ~200 lines.

2. **Orientation cache.** In-memory orientation summary with mechanical patch operations. Regeneration via Sonnet call (depends on #1). ~150 lines.

3. **Tactical evaluator.** Prompt template, Haiku call (depends on #1), response parser, eval log writer. ~200 lines.

4. **Evaluation dispatcher.** Wraps watcher event callbacks. Calls tactical evaluator, routes to existing handlers or strategic loop trigger. ~100 lines.

5. **Interrupt handler.** SIGTERM + interrupt file + run record update. Extends supervisor. ~80 lines.

6. **Think loop driver (event-triggered).** The strategic ORIENT→INTEGRATE cycle from the reasoning loop design, now triggered by the tactical loop instead of self-scheduling. ~300 lines.

7. **Gateway extensions.** `/api/eval-log`, `/api/orientation`. Small.

Steps 1-4 are the critical path. They give you event-driven evaluation with orientation context — the core of the OODA loop — without requiring the full strategic loop to be built. You can validate the evaluation pass in isolation: wire it to the watcher, watch the eval log, tune the prompt and signal taxonomy, and verify that it classifies signals correctly before connecting it to anything that acts.

Steps 5-6 are the completion path. They give you interrupts and the full strategic reasoning loop. These can be built and validated independently of each other.

Step 7 is observability. Build it when you want to watch the loop from the gateway UI.

---

## Open Questions

**1. Evaluation pass failure mode.** If the Haiku call fails (network error, rate limit, timeout), the tactical loop should fall back to mechanical routing — the pre-OODA behavior. Never block the observation loop on a model call. Is this fallback path tested?

**2. Orientation drift under load.** If many signals arrive in a burst (e.g., three workers complete simultaneously), the orientation cache may be stale for the second and third evaluations. Does this matter? Probably not — the evaluations will correctly wake the strategic loop, which does a full reorient. But the edge case where burst evaluations produce contradictory routing decisions deserves attention.

**3. Cost at scale.** 100 evaluations per session = $0.10. But a long-running `hive think` session with active workers might generate 500+ signals over 4 hours. That's $0.50 in evaluation costs alone, on top of worker costs. Still cheap relative to the strategic loop's Opus costs, but worth tracking.

**4. Evaluation quality feedback loop.** How do we know the evaluations are good? The eval log gives us raw data, but there's no automated metric for "this signal was classified correctly." Initially this is human review of the eval log. Eventually it could be a periodic Sonnet review of recent evaluations — meta-evaluation. Not building that now, but the eval log format should support it.

**5. Multi-goal tactical evaluation.** The current design assumes one active goal. If HIVE eventually supports multiple concurrent goals, the tactical evaluator needs to route signals to the correct goal's strategic loop. The orientation summary would need to cover multiple goals. This doesn't change the architecture — it changes the orientation regen prompt and adds a goal-routing field to the evaluation output. Defer until multi-goal is actually needed.
