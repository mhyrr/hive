# Autonomy Foundation Eval — 2026-03-28

## Verdict
fail

## Critical Issues
- Verification does not gate work-graph progress. `reconcileWorkGraphFromRuns()` marks a task `done` whenever the archived run exits `0` (`src/lib/orchestrator.ts:139-151`). But verification runs later in the supervisor and can still fail, close the original assignment, and enqueue a retry or block for steward review (`src/commands/supervise.ts:253-321`, `src/commands/supervise.ts:473-489`). Result: a graph task can be treated as complete and unblock dependents even when its `verify` command failed.
- Auto-review is not actually a critic gate. The supervisor only dispatches a critic assignment (`src/commands/supervise.ts:491-514`). `processReviewVerdict()` exists (`src/lib/auto-review.ts:78-89`) but has no call site, and nothing in graph reconciliation or supervisor flow waits on a verdict before advancing work. In practice this is advisory side-work, not a gate.
- The goal loop is disconnected from the graph-driven `dream` path. `dreamCommand()` creates a goal, writes a per-goal graph, and only updates `goal.plan` (`src/commands/dream.ts:105-123`). Goals start with `waveAgents: []` (`src/lib/goals.ts:116-133`), and supervisor only checks goals where `waveAgents.length > 0` (`src/commands/supervise.ts:593-607`). `dispatchNextWave()` is defined (`src/lib/goal-loop.ts:110-127`) but not imported into supervisor (`src/commands/supervise.ts:52-55`) or called anywhere. Result: graph-driven goals never enter wave synthesis and never autonomously dispatch another wave.

## Non-Critical Issues
- The `agentId` reconciliation bug called out in the brief is fixed. `advanceWorkGraph()` now generates persona-shaped agent ids and stores them on the task (`src/lib/orchestrator.ts:65-92`), and launch preserves `message.to` as the run `agentId` (`src/commands/launch.ts:205-227`, `src/commands/launch.ts:313-323`). The lookup in `reconcileWorkGraphFromRuns()` can match.
- The auto-review flood concern is mostly fixed for the normal single-supervisor case. `dispatchAutoReview()` writes a pending marker before sending the critic assignment (`src/lib/auto-review.ts:35-50`), so repeated ticks will see the file and skip redispatch. Caveat: the check/write is still a non-atomic TOCTOU sequence, so two concurrent supervisor processes could still double-dispatch the same review.
- Goal synthesis does pass a longer timeout. `callAnthropic()` defaults to `5000ms` (`src/lib/anthropic-client.ts:47`), but `checkGoalWaveCompletion()` overrides it with `15000ms` (`src/lib/goal-loop.ts:53-57`).
- `isPulseTick` ordering is correct. It is declared at the start of `runSupervisorPass()` (`src/commands/supervise.ts:407-410`) before the goal-wave block at step 5b (`src/commands/supervise.ts:593-607`).
- `isGraphFailed()` does exist and is exported from `work-graph.ts` (`src/lib/work-graph.ts:120-123`). The real drift is elsewhere: `orchestrator.ts` keeps a private `isGraphComplete()` that only treats all-`done` graphs as complete (`src/lib/orchestrator.ts:39-41`), while the shared helper treats `failed` as terminal too (`src/lib/work-graph.ts:116-123`). That makes the supervisor’s `complete:` summary pessimistic for terminally failed graphs.
- The reconciliation step is launched fire-and-forget (`src/commands/supervise.ts:427-437`) and graph advancement runs immediately after (`src/commands/supervise.ts:439-454`). That does not break correctness by itself, but it can delay dependent dispatch by one supervisor interval because step 2 can read the pre-reconciliation graph snapshot.
- `writeMorningBrief()` does not write a morning brief artifact. It only appends a log line (`src/lib/goal-loop.ts:94-107`), so the current implementation falls short of the file-producing behavior implied by the function name and the overnight autonomy design docs.

## What's Working
- Per-goal graph storage is wired correctly now. New dreams write to `goalWorkGraphPath(projectPaths, goalRecord.id)` (`src/commands/dream.ts:112-116`, `src/lib/paths.ts:355-361`) instead of the legacy single `state/work-graph.json`.
- The specific `agentId` mismatch feared in the assignment is no longer present; graph tasks use real worker-style ids and run reconciliation keys off those same ids (`src/lib/orchestrator.ts:65-92`, `src/lib/orchestrator.ts:139-145`).
- The review dedupe mechanism is materially better than the older draft suggested because the pending review marker is created before critic dispatch (`src/lib/auto-review.ts:35-50`).
- Goal synthesis timeout is explicitly extended to 15 seconds (`src/lib/goal-loop.ts:53-57`), so the default 5-second client timeout is not the active behavior there.
- `isPulseTick` is in scope before step 5b, and `isGraphFailed()` is present/exported, so those two wiring concerns are closed.

## Recommended Fixes
- Make verification first-class in the work graph. A task should not transition to `done` on worker exit alone when it has a `verify` command. Persist verification outcome alongside the run and reconcile against that state, not just `run.exitCode`.
- Decide whether critic review is a real gate or just telemetry. If it is a gate, wire `processReviewVerdict()` into supervisor/orchestrator and block task completion or dependent dispatch until the verdict is `approve`. If it is not a gate, stop describing it as one.
- Unify the goal loop with graph execution. Either populate `goal.waveAgents` from graph dispatches and call `dispatchNextWave()` on synthesis, or retire the `waveAgents` path and drive synthesis directly from the per-goal work graph state.
- Make review dedupe atomic if multiple supervisors can run. A lockfile or create-with-exclusive semantics is safer than `exists()` followed by `write()`.
- Remove the duplicated `isGraphComplete()` in `orchestrator.ts` and use the shared graph terminal-state helpers from `work-graph.ts` so reporting semantics stay consistent.
- Either have `writeMorningBrief()` write a durable artifact under the goal, or rename it to match the current log-only behavior.
