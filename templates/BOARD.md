# Board

## Tasks
<!-- Pipe-delimited format: - ID | description | status | owner: agentId | deps: ID,ID
     Valid statuses: queued, active, waiting, done
     Example:
- PROJ-001 | Implement auth endpoints | active | owner: alpha | deps: none
- PROJ-002 | Auth frontend form | queued | owner: beta | deps: none
- PROJ-003 | Review auth implementation | waiting | owner: gamma | deps: PROJ-001,PROJ-002
-->
(none yet)

## Agents
<!-- Format: - agentId | status | task: description | last-active: timestamp
     Example:
- steward | active | task: monitoring auth implementation | last-active: 2026-03-13T14:00:00Z
- alpha | idle | task: done PROJ-001 | runtime: claude
-->
(none yet)

## Contracts
<!-- Output contracts define what a task must deliver.
     Example:
- PROJ-001 output contract:
  Implement POST /api/auth/login and /api/auth/refresh.
  JWT tokens via Joken with 1-hour expiry.
  Confirm tests pass.
-->
(none yet)

## Blockers
(none yet)

## Decisions
(none yet)