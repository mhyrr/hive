# Board

## Tasks
- HIVE-016 | Gateway UX redesign (glassmorphism, markdown, charts, command palette) | done | owner: steward | deps: none
- HIVE-017 | UX Phase 6: glassmorphism wiring + input affordances + streaming redesign | done | owner: gamma | deps: HIVE-016
- HIVE-018 | Strategic loop wiring: onStrategicTrigger orient→decide→dispatch | done | owner: alpha | deps: none
- HIVE-019 | Goal file system: goals/<id>.md, hive goal commands, status integration | done | owner: beta | deps: none
- HIVE-020 | hive dream command: 3-phase overnight autonomous entry point | done | owner: alpha | deps: HIVE-018
- HIVE-021 | Autonomy foundation: goal-loop, work-graph, orchestrator, auto-review | done | owner: steward | deps: HIVE-020
- HIVE-022 | Autonomy loop bug fixes: agentId, dispatch ordering, review flood, stale replay, per-goal graphs | done | owner: steward | deps: HIVE-021

## Agents
- orchestrator | idle | task: none | last-active: 2026-03-28
- alpha | idle | task: none | runtime: claude
- beta | idle | task: none | runtime: claude
- gamma | idle | task: none | runtime: claude

## Contracts
- HIVE-022 scope: src/lib/orchestrator.ts, src/lib/auto-review.ts, src/lib/goal-loop.ts, src/lib/paths.ts, src/commands/supervise.ts, src/commands/dream.ts

## Blockers
- none

## Decisions
- 2026-03-28: HIVE-022 done — autonomy loop bugs fixed: (1) agentId was UUID, now persona-model-xxxx; (2) advanceWorkGraph ran after dispatchWorkerLaunchPass, now before; (3) auto-review flood fixed with pending marker + 24h recency gate; (4) stale run replay fixed with started-at guard; (5) global work-graph.json replaced with per-goal state/work-graphs/<goalId>.json; (6) goal synthesis timeout raised to 15s, no longer clears waveAgents on failure.
- 2026-03-28: planGoalToGraph added to orchestrator.ts — LLM decomposes goal into WorkGraph with real task nodes, dependsOn resolution, persona/model/scope assignment. dream.ts upgraded to use it; steward nudge is fallback only.
- 2026-03-24: HIVE-021 done — autonomy foundation: goal-loop.ts, work-graph.ts, orchestrator.ts, auto-review.ts built. supervise.ts wired with all three: reconcileWorkGraphFromRuns (1b), advanceWorkGraph (2), auto-review gate (3b), goal wave check (5b).
- 2026-03-24: HIVE-020 done — hive dream command.
- 2026-03-24: HIVE-019 done — hive goal CRUD commands.
- 2026-03-22: cog branch merged to main (PR #10).
