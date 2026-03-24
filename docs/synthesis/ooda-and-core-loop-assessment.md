# OODA and Core Loop Assessment

This assessment is based on the five loop-design docs plus the live wiring in `src/commands/think.ts`, `src/lib/ooda-watcher.ts`, `src/lib/evaluation-dispatcher.ts`, `src/lib/tactical-evaluator.ts`, `src/lib/strategic-loop.ts`, `src/lib/watcher.ts`, `src/lib/goals.ts`, and `src/commands/dream.ts`.

## Verdict

HIVE has a real fast tactical loop. It does **not** yet have a real autonomous strategic loop.

What exists today is:

- fast filesystem observation
- a cheap evaluation pass
- routing into existing watcher handlers
- a thin reactive "what should happen next?" pass

What does **not** exist yet is the thing the north star requires: a steward that can hold a goal for hours, accumulate understanding, revise the plan, coordinate multiple workers, and terminate or escalate with confidence.

The blunt version: HIVE has reflexes. It does not yet have campaign management.

## Built vs Stubbed vs Missing

| State | What exists | What that actually means |
| --- | --- | --- |
| Built | `src/lib/watcher.ts` watches `feed.md`, `msg/`, each project `BOARD.md`, and `runs/active/` with 200ms debounce. `src/lib/evaluation-dispatcher.ts`, `src/lib/tactical-evaluator.ts`, `src/lib/orientation.ts`, and `src/lib/anthropic-client.ts` are wired. | The observe/evaluate/route front door is real. |
| Partial | `hive think`, interrupt handling, orientation regen, gateway OODA wrapper, strategic pass. | These work in reduced form, but not at the level described in the docs. |
| Missing | Goal-centric ORIENT→INTEGRATE loop, durable strategic state, evidence integration, executable tactical actions, multi-agent portfolio management, completion/stuck semantics tied to a goal. | This is why the steward is still below the coordination layer. |

## 1. What the current OODA loop actually does end-to-end

The current loop is layered on top of the watcher-driven coordination work from `CORE-LOOP-CONSOLIDATION`, not a replacement for it.

### What fires it

`src/lib/watcher.ts` is the real clock. It watches:

- `feed.md`
- `msg/`
- every project `BOARD.md`
- every project `runs/active/`

The debounce is 200ms. That part is real, and it is the best-built part of the design.

### What happens on a signal

1. Gateway mode or `hive think` wraps the raw watcher callbacks with `createProjectOodaWatcher`.
2. `createProjectOodaWatcher` refreshes runtime state before evaluation and regenerates orientation if it is missing or stale.
3. `createEvaluatedWatcherEvents` turns watcher callbacks into coarse signals and sends them to `evaluateSignal`.
4. `evaluateSignal` calls Anthropic Haiku, parses a tactical decision, and appends one JSON line to `eval-log`.
5. The dispatcher routes the event:
   - `discard`: drop it
   - `log`: call the original watcher handler
   - `tactical`: call the original watcher handler and log a queued command
   - `wake_strategic`: call the original watcher handler and invoke the strategic callback
   - `interrupt`: skip the original handler and call `interruptWorker`

### What actions it can actually take today

The important distinction is between "designed action surface" and "live action surface."

Live today:

- launch workers through the existing assignment watcher path
- broadcast watcher events through the gateway
- notify the persistent steward about completed runs through the existing gateway path
- append tactical evaluation logs
- fire a one-shot strategic pass from `hive think`
- attempt a worker interrupt via SIGTERM

Not live today:

- execute tactical commands beyond logging them
- run a full ORIENT→INTEGRATE strategic cycle
- revise a goal file based on evidence
- replan a multi-agent investigation as a durable campaign

### What the strategic loop really is right now

This is the biggest doc/code mismatch.

The docs describe the strategic loop as the deep reasoning layer: goal file, evidence, plan revision, resolution/stuck detection, long-running autonomy.

The implementation in `src/lib/strategic-loop.ts` is much thinner:

- it reads the board
- it reads the last 20 log lines
- it counts open messages
- it takes the triggering tactical evaluation
- it asks Haiku for exactly one action: `dispatch`, `log`, or `escalate`
- if `dispatch`, it writes one assignment message
- if `escalate`, it writes one nudge to steward

That is not the strategic loop from the docs. It is a reactive next-action classifier.

### Concrete gaps inside the current OODA path

- `hive think` ignores its CLI args. The docs describe `hive think "why is X happening?"`; the command actually just starts the watcher loop for the active project.
- `buildProjectActiveContext` uses the `projectId` as the "goal title." There is no actual active-goal object in the OODA path.
- Orientation regen uses project id, board digest, recent delta summaries, and active run ids. It does not read goal files, current understanding, open questions, or evidence logs.
- The signal payloads are thin. For most events the evaluator gets a filename or basename, not the content of a result, message, or evidence digest. That sharply limits what "positional evaluation" can mean in practice.
- `tactical_action` is a stub. The dispatcher logs the command; it does not execute it.
- The interrupt path is incomplete. It sends SIGTERM and marks stop requested, but the interrupt file path is still `runs/active/<runId>/interrupt.md` even though active runs are flat `.md` records, so the "preserve partial work through an interrupt file" story is shaky.
- In gateway mode, `onStrategicTrigger` only logs. So the always-on runtime has tactical evaluation but no live strategic action.

## 2. What the current core loop timing and event model is

### Primary timing model

The primary coordination substrate is genuinely event-driven:

- watcher debounce: 200ms
- managed gateway worker-launch scheduling: another 200ms
- run-completion detection: watcher-based

That part of `CORE-LOOP-CONSOLIDATION` is real.

### Where polling still exists

It is **not** pure event-driven end-to-end.

The supervisor still has a 120-second safety-net poll. That is explicit in code and comments, not just in the docs:

- `DEFAULT_SUPERVISOR_INTERVAL_SECONDS = 120`
- gateway comments still describe watcher-driven launch and completion handling as best-effort, with the periodic supervisor pass as fallback

So the honest answer is:

- primary path: event-driven
- failure/reconciliation path: polling

That is a reasonable design choice. It just is not "no polling."

### Where the strategic event model falls short

The docs describe two triggers for the strategic loop:

- tactical wake on meaningful events
- a safety-net timer, default 5 minutes

The implementation only has the first one, and only when `hive think` is running. There is no timer-driven strategic wake in `think.ts`.

There is also an operational split:

- if gateway is running for the active project, `hive think` refuses to start
- gateway mode wraps the watcher with OODA evaluation
- but gateway mode only logs strategic triggers instead of acting on them

That means the "always on" mode is still mostly:

- watcher-driven mechanics
- 120s supervisor fallback
- best-effort steward notifications

not:

- watcher-driven mechanics
- active strategic brain
- autonomous replanning

### Is the nested loop split real?

Only partially.

The docs justify nested loops with different tempo, different state, and different cost/depth. Current implementation only really has different tempo.

Right now:

- tactical evaluator: Haiku
- orientation regen: Haiku
- strategic pass: Haiku

So the fast loop and the slow loop are not meaningfully different in reasoning depth or state representation. The architecture has the shape of two loops, but not yet the substance.

## 3. Biggest gap between current state and "steward can run autonomously for hours on a goal"

The biggest gap is **not** watcher speed anymore. That part is mostly solved.

The biggest gap is the absence of a durable, goal-centric strategic control plane.

Right now HIVE can do one of two things:

- react quickly to filesystem events
- plan a one-shot batch of work (`hive dream`)

It cannot yet close the loop between those two modes.

Why that matters:

- `hive think` does not start from a goal question
- the OODA path does not read or update canonical goal state
- the strategic pass does not integrate evidence into understanding
- the strategic pass does not revise a plan over time
- the strategic pass can choose only one next action
- `hive dream` is still one-shot planning and its synthesis phase is explicitly TODO

So Greg still has to operate at the task layer whenever the work stops being obvious. HIVE can launch workers quickly. It cannot yet own the campaign.

If you reduce the problem to one sentence:

> HIVE has a fast trigger loop, but no durable memory-and-decision loop that turns triggers into long-running autonomous coordination.

## 4. What the steward needs to operate at the coordination layer instead of the task layer

### 1. A real canonical goal state

The current `src/lib/goals.ts` is much thinner than the reasoning-loop design. It stores:

- description
- status
- plan
- evidence bullets

That is not enough for autonomous coordination. The steward needs durable state for:

- current understanding
- open questions
- discarded hypotheses
- active plan
- pending decisions
- budgets and checkpoints
- explicit resolved / stuck / needs-human tests

Without that, every strategic pass is amnesiac.

### 2. A strategic runtime that actually owns that goal state

The steward needs more than "run Haiku once when a watcher says something happened."

It needs a persistent strategic runtime that can:

- wake on events
- wake on cadence
- read and rewrite goal state
- compare new evidence against current understanding
- decide whether to continue, escalate, pause, or terminate

Today that runtime does not exist. `hive think` is a watcher shell around a one-shot strategic pass.

### 3. Real decomposition and portfolio management

Operating at the coordination layer means the steward can take "improve the auth system" and turn it into a managed portfolio:

- split into multiple workstreams
- assign 4-10 workers in parallel
- set scopes and done conditions
- track dependencies
- notice when the plan is wrong
- reassign or kill work that became irrelevant
- synthesize results into the next plan

Current strategic code can dispatch one assignment. That is still task-level thinking.

### 4. Evidence ingestion, not just status ingestion

The docs are right that a reasoning loop needs evidence, not just task completions.

The current OODA path mostly sees:

- board digest
- recent log lines
- active run ids
- filenames from watcher events

That is enough to know that something happened. It is not enough to know what was learned.

The steward needs structured result ingestion that answers:

- what changed in understanding
- what hypothesis was strengthened or killed
- what new question appeared
- whether the goal is converging or diverging

### 5. Real actuation primitives

Several control surfaces still need to become real:

- tactical actions need an executor
- interrupts need a correct preservation path and discipline
- gateway mode needs to do more than log strategic triggers
- strategic dispatch should run as the steward, not as an orphan sidecar

Until those are solid, the loop can observe more than it can act.

### 6. One authoritative autonomy path

Right now HIVE autonomy is fragmented across:

- watcher-driven coordination
- persistent-steward notifications
- OODA tactical evaluation
- `hive think`
- `hive dream`
- goal-file CRUD

Those are useful pieces, but they are not yet one system. The steward needs one authoritative path that unifies:

- goals
- decomposition
- dispatch
- monitoring
- synthesis
- replanning
- escalation

That is what operating at the coordination layer actually means.

## Bottom Line

The current system is closer to:

> "fast event-driven orchestration with a cheap strategic suggestion layer"

than to:

> "self-directing steward that can run a goal for hours."

That is still meaningful progress. The watcher/evaluation substrate is real, and it matters. But the main missing piece is now obvious: not another prompt, not another watcher, but the durable strategic loop that turns fast signals into sustained autonomous coordination.
