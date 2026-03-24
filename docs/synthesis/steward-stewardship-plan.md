# Steward Abstraction Layer — Build Plan
_Maya's working plan. Updated as critics report in._

## The Real Problem

Greg's prompt distilled: "I want to tell you what to want, not what to do."

Right now HIVE's steward is a reactive loop:
- Human sends message → steward wakes → steward responds or dispatches one task → sleeps
- The strategic loop exists but is Haiku at 300 tokens, reactive to OODA triggers, not proactive on goals
- `hive dream` exists as an entry point but the autonomous iteration loop after dispatch is not wired

The steipete model is different:
- Declare a goal at a high level
- Coordination layer decomposes → N agents work in parallel
- Results synthesized → next wave dispatched autonomously
- Human reviews outcomes, not intermediate steps

## What's Built vs. What's Missing (Preliminary)

### Built ✓
- OODA tactical evaluation loop (fires on events, classifies, can trigger strategic pass)
- Strategic pass: Haiku reads board + log, outputs ACTION/AGENT/ASSIGNMENT
- `hive dream`: goal → Sonnet decomposition → assignments written → supervisor launched
- `hive goal`: CRUD for active goals with status integration
- `hive think`: manual strategic pass trigger
- Worker dispatch, max-parallel enforcement, verification loop
- Seen-results dedup (just fixed)
- Persistent steward session (gateway)

### Missing / Stubbed ✗
- **Goal-driven autonomous iteration**: after `dream` dispatches wave 1 and agents complete, nothing synthesizes results and dispatches wave 2. The loop doesn't close.
- **Steward role separation**: conversational, orchestration, and planning are all in one `workflow.ts`. The strategic loop is separate but barely wired.
- **Supervisor board-completion detection**: `dream.ts` TODOs the morning-briefing synthesis phase — it's not wired.
- **Multi-wave orchestration**: no concept of "wave 1 done → assess → wave 2". Everything is single-shot dispatch.
- **Autonomous critic loop**: no automatic critic-reviews-craftsman before commit pipeline.
- **Goal → task decomposition feedback**: when wave 1 results come in, nobody reads them against the original goal and decides what's left.

## Three-Role Separation (Greg's Ask)

Greg correctly identified that the steward conflates three jobs:

1. **Conversational** — talking to Greg (gateway chat turns)
2. **Orchestration** — managing agents: dispatch, monitor, interrupt, synthesize
3. **Planning/decision** — what to do next given the goal and current state

These should be separable so the orchestration + planning roles can run autonomously without the conversational role being in the loop. Currently they're entangled in `supervise.ts` + `workflow.ts`.

## The Build Plan

Three parallel workstreams, all using Codex craftsmen:

### Stream A — Goal-Driven Autonomous Loop
Make the post-dream iteration loop real. When all agents in a wave complete:
1. Read their results against the active goal
2. Assess: done? partial? blocked?
3. If not done: decompose next wave, dispatch, continue
4. If done: write morning briefing to goal file, notify steward

This is the "closes the loop" work. Lives in: `src/lib/goal-loop.ts` (new) + `src/commands/supervise.ts` integration.

### Stream B — Steward Role Separation  
Extract orchestration logic from `workflow.ts` into a clean `src/lib/orchestrator.ts`:
- `OrchestrationEngine`: maintains goal state, wave state, dispatch queue
- `dispatchWave(goal, tasks[])`: kicks off N agents with proper scope isolation
- `synthesizeWave(goal, results[])`: reads wave results, returns next-wave plan or completion
- Steward's conversational role calls orchestrator; strategic loop calls orchestrator
- No more business logic in `workflow.ts` directly

### Stream C — Autonomous Critic Pipeline
Wire a post-completion critic automatically on craftsman runs:
- When a craftsman run completes with changes, auto-dispatch a critic to review the diff
- Critic can: approve (merge/commit), request-changes (re-dispatch craftsman), or escalate
- This gives us the "generate → review → commit" pipeline that steipete describes
- Lives in: `src/lib/supervisor.ts` + new `src/lib/auto-review.ts`

## Waiting On
- docs/synthesis/ooda-and-core-loop-assessment.md (critic-gpt54-2069)
- docs/synthesis/steward-architecture-assessment.md (critic-gpt54-e734)  
- docs/synthesis/vision-gap-assessment.md (critic-gpt54-21e3)

Will update this plan and dispatch build workers once critics report.

## Agent Run Log
| Agent | Task | Status |
|-------|------|--------|
| critic-gpt54-2069 | OODA + core loop synthesis | running |
| critic-gpt54-e734 | Steward architecture synthesis | running |
| critic-gpt54-21e3 | Vision gap assessment | running |
