# HIVE Phase 4: Autonomous Launch And Supervision

## Why This Phase Comes Next

HIVE already has the hard parts of coordination:

- file-backed shared state
- orchestrator-owned `BOARD.md`
- file-per-message inboxes
- prompt assembly
- one-shot runtime launch

What it still lacks is the thing that makes it feel like a team instead of
a toolkit: the hive cannot schedule itself. The human is still the launch
button for every steward pass and every worker pass.

That is the real blocker now. Richer human interfaces can wait. Until HIVE
can launch the steward and workers on its own, a console is mostly a nicer
way to do clerical work.

## Goal

Run one command and let HIVE:

- launch the steward when the project state needs assessment
- launch workers automatically when the steward assigns work
- run multiple workers in parallel when their scopes do not conflict
- record enough run state on disk to recover after crashes or restarts
- keep the human informed through `feed.md` without forcing manual polling

## Non-Negotiables

- Files remain the source of truth.
- `PLAN.md`, `BOARD.md`, `LOG.md`, and `msg/` remain the coordination model.
- The steward stays an agent, not a hardcoded workflow engine.
- Launching and process supervision stay deterministic code, not LLM behavior.
- One writer per file still applies.
- Auto-launch must prefer safety over aggressiveness.

## The Core Decision

The steward should decide work. It should not manage OS processes directly.

Phase 4 introduces a second layer:

- **Steward:** decides what should happen next by updating `PLAN.md`,
  `BOARD.md`, and `msg/`
- **Supervisor:** a deterministic Bun loop that reads the files, launches
  runs, observes exit status, and writes run state

That split matters. It keeps process control out of the LLM, keeps the
filesystem as the API, and makes parallel launch behavior testable.

The orchestrator still "launches" workers in practice, but it does so by
creating assignment messages and updating the board. The supervisor turns
that intent into actual runtime invocations.

## The Launch Contract

Automatic worker launch is driven by open assignment messages from the
orchestrator.

Example:

```md
---
from: orchestrator
to: alpha
type: assign
status: open
project: dealsplit
task: HIVE-005
launch: auto
scope: src/commands,tests,README.md
ts: 2026-03-10T14:11:05Z
---

Add prompt regression coverage for inbox plus resolve/close runtime rules and
add the missing rebuild-after-CLI-change warning wherever `./hive` is
recommended for validation.
```

Phase 4 only needs a few structured keys:

- `task:` stable work identifier
- `launch:` `auto` or `manual`
- `scope:` comma-separated scope roots when the assignment is launchable in
  parallel with other work

Everything else can remain plain markdown body text.

## Scope Rules For Parallel Work

Parallel launch is only safe when HIVE can make a simple, defensible claim
that two runs are unlikely to step on the same files.

Phase 4 should treat scope as explicit operational data:

- `scope:` on the assignment message wins
- otherwise `scope:` on the agent section in `PLAN.md`
- otherwise `scope:` in the project default team
- otherwise the agent is treated as exclusive

Scope is not free-form prose for the scheduler. It is a comma-separated set
of repo roots such as:

```md
scope: src/api,src/db
```

Rules:

- one active run per agent
- one active steward run per project
- agents with overlapping scope roots do not run in parallel
- agents with no explicit scope are exclusive by default
- `scope: *` means exclusive

Conflict matching is path-boundary aware. `src/lib` conflicts with
`src/lib` and `src/lib/foo`, but not `src/lib-utils`.

This is deliberately conservative. HIVE does not need a perfect file-level
lock manager in Phase 4. It needs a safe enough scheduler.

## Supervisor-Owned State

The supervisor needs its own file-backed run state. Agents do not write it.

Add to each project:

```text
~/.hive/projects/{project}/
  runs/
    active/
      orchestrator.md
      alpha.md
      beta.md
    2026/
      03/
        20260310-141105Z-orchestrator/
          run.md
          prompt.md
          result.md
          runtime.log        # debug mode only
```

### `runs/active/<agent>.md`

Supervisor-owned pointer file for the currently active run, if any.

Example:

```md
---
run: 20260310-141105Z-alpha
project: dealsplit
agent: alpha
status: active
pid: 81234
runtime: codex
model: gpt-5-codex
task: HIVE-005
source-message: 20260310-141105Z-orchestrator-to-alpha-HIVE-005.md
scope: src/commands,tests
started: 2026-03-10T14:11:05Z
prompt: /Users/greg/.hive/projects/dealsplit/runs/2026/03/20260310-141105Z-alpha/prompt.md
---
```

### `runs/YYYY/MM/<run-id>/run.md`

Immutable execution record written by the supervisor.

Example:

```md
---
run: 20260310-141105Z-alpha
project: dealsplit
agent: alpha
status: exited
runtime: codex
model: gpt-5-codex
task: HIVE-005
source-message: 20260310-141105Z-orchestrator-to-alpha-HIVE-005.md
scope: src/commands,tests
started: 2026-03-10T14:11:05Z
ended: 2026-03-10T14:14:42Z
exit-code: 0
---

## Summary
- prompt artifact written
- runtime exited cleanly
- assignment message remained open after exit
- supervisor queued steward reconciliation
```

This is the execution record, not the agent's hidden thinking.

### `runs/YYYY/MM/<run-id>/result.md`

LLM-facing reassessment context assembled by the supervisor after the run
finishes.

This file exists because exit code alone is not enough. A worker can exit 0
and still leave the assignment unfinished. The steward needs a compact,
structured summary of what actually happened.

Example:

```md
# Run Result

- run: 20260310-141105Z-alpha
- agent: alpha
- task: HIVE-005
- exit-code: 0
- assignment-message: 20260310-141105Z-orchestrator-to-alpha-HIVE-005.md
- assignment-status-after-exit: open
- assignment-resolved-by-worker: no

## Files Changed
- tests/hive.test.ts
- README.md

## Git Diff Summary
- added explicit prompt assertions for `hive msg close`
- added repo-local rebuild warning guidance

## Final Visible Runtime Output
HIVE-005 is done in the repo, but the assignment message is still open.
The steward should reconcile the board and close the beta thread.
```

The supervisor should build this from:

- run metadata
- exit code
- source assignment message state after exit
- changed file list derived from git state
- a concise diff summary
- the final visible runtime response when available

The steward reassessment prompt should include a recent run results section
assembled from these `result.md` files.

## Output Capture Policy

Default capture should be outcome-oriented:

- `prompt.md` always
- final visible result when the runtime exposes it cleanly
- exit code and timing always
- full stdout/stderr only in debug mode

Do not persist full token streams or internal reasoning by default.
HIVE memory should remain curated, not accidental.

## The Supervisor Loop

New command:

```bash
hive supervise [--interval 30] [--max-parallel 3] [--once]
```

This is the autonomous layer. It is a foreground loop by default. If the
user wants it in the background, they can run it under `tmux`, `nohup`, or a
launchd/systemd wrapper later. HIVE does not need a resident daemon to work.

The supervisor tick can stay relatively short, but the default steward
reassessment interval should be 120 seconds when no event-triggered reason to
run the steward exists.

### Loop Responsibilities

1. Read active project state.
2. Reconcile active run files against live child processes.
3. Archive completed runs and emit high-signal feed events.
4. Decide whether the steward needs a new pass.
5. Launch ready worker assignments up to the configured parallel limit.
6. Sleep until the next interval.

### When The Steward Runs

The supervisor should launch the steward when:

- there is an open `nudge` for `orchestrator`
- there is an open message to `orchestrator`
- a worker run exited or failed since the last steward pass
- an active run became stale or orphaned
- the board claims active work but there are no active worker runs
- the configured reassessment interval elapsed (default: 120 seconds)

Every steward reassessment should include:

- open messages to `orchestrator`
- active run summaries
- recent completed or failed `result.md` summaries
- board entries that appear inconsistent with run state

### When A Worker Runs

The supervisor should launch a worker when all of the following are true:

- there is an open `assign` message addressed to that agent
- `launch:` is `auto` or omitted but project defaults allow auto-launch
- the agent has no active run
- the assignment has not already consumed its current launch attempt
- the agent's scope does not conflict with active runs
- the project-wide parallel limit is not exceeded

### The Important Safety Rule

One open assignment should trigger at most one automatic launch attempt.

If the worker exits and leaves the assignment open, HIVE should not blindly
relaunch it in a loop. That state means the steward needs to look at the
result and decide what to do next.

The next launch should come from one of two things:

- a new assignment message from the steward
- an explicit retry decision recorded by the steward

## Manual Launch While Supervision Is Running

Manual launch and supervised launch must coexist.

Rule:

- `hive launch <agent>` writes the same run artifacts the supervisor would
  write
- if the agent already has an active run, `hive launch` refuses
- if the supervisor is running, it adopts the manual run on the next tick
  rather than trying to spawn a duplicate

That keeps `hive launch` useful as an escape hatch without creating a second
launch path or split-brain run state.

## Failure And Recovery

Phase 4 only needs a small, clear failure model.

### Clean Exit

- mark the run exited
- remove the active pointer
- emit a feed event
- trigger steward reassessment if the assignment is still open

### Non-Zero Exit

- mark the run failed
- remove the active pointer
- write a concise failure summary to the feed
- trigger steward reassessment

### Supervisor Restart

On startup the supervisor reads `runs/active/`.

- if the process is still alive, keep tracking it
- if the process is gone, mark the run stale and trigger steward
  reassessment

Crash tolerance still comes from disk state, not RAM.

## The Role Of `hive launch`

`hive launch` remains valuable, but it stops being the main workflow.

After Phase 4:

- `hive launch` is the manual, one-shot escape hatch
- `hive supervise` is the normal autonomous path
- `hive orchestrate` stays useful for prompt inspection and debugging

## Runtime Adapter Requirements

The existing runtime adapters are enough to start Phase 4 if they support:

- prompt injection
- working directory selection
- extra readable directories such as `~/.hive/`
- exit-code reporting
- optional quiet and debug output modes

Detached long-lived session management is not required for Phase 4. The first
version can supervise one-shot runs only. Stateless repeated passes are still
consistent with the HIVE architecture.

## New CLI Surface

Phase 4 should add only the minimum commands needed for supervision:

```bash
hive supervise [--interval 30] [--max-parallel 3] [--once]
hive ps
hive stop <agent-id|run-id>
```

`hive ps` shows active runs and recent failures.

`hive stop` terminates the matching run, marks it cancelled in the run
record, and emits a feed event. This is the human brake pedal.

## Why This Is Still Aligned With HIVE

This does not turn HIVE into a framework or daemon platform.

- the files still hold the state
- the steward still does the thinking
- the supervisor only launches and observes
- every run can still be reconstructed from disk artifacts
- killing the supervisor does not erase the project state

The architecture is still local-first, stateless, and file-native.

## Validation Strategy

The main risk in Phase 4 is not process spawning. It is prompt quality.

The steward is still a stateless LLM pass that re-reads the files on every
run. Once auto-launch exists, the steward prompt becomes even more critical
because its decisions now cause autonomous work.

Before enabling live parallel auto-spawn by default, Phase 4 should have:

- fixture tests for steward reassessment prompt assembly with known board,
  message, and run-result states
- scheduler tests for scope conflict matching and one-run-per-assignment
  safety
- adoption tests for manual `hive launch` while supervision is active
- dry-run supervision mode to inspect launch decisions before spawning

## Roadmap Consequence

The roadmap should change.

The new order should be:

1. Phase 1: Core primitives
2. Phase 2: Orchestrator prompt and state loop
3. Phase 3: Human interaction slice and one-shot runtime launch
4. Phase 4: Autonomous launch and supervision
5. Phase 5: Rich human modes, persistent console, and transport adapters
6. Phase 6: Memory intelligence and curation automation

This is the right order because a better chat surface without auto-launch is
mostly ergonomics. Auto-launch is what turns HIVE into an actual team.

## Implementation Sequence

Build Phase 4 in four narrow steps:

1. Add supervisor-owned run files and `hive ps`.
2. Add `hive supervise --once` and deterministic steward trigger logic.
3. Add worker auto-launch from assignment messages with one-run-per-assignment
   safety.
4. Add parallel dispatch with scope conflict checks and `hive stop`.

That sequence keeps the risk low and gives you dogfood points after every
step.
