# Board

## Tasks
- HIVE-001 | Dogfood baseline audit | done | owner: alpha | deps: none
  Deliverable: completed in `20260310-020408Z-alpha-to-steward-0862a50b.md`.
- HIVE-002 | Convert baseline into prioritized fixes | done | owner: steward | deps: HIVE-001
  Deliverable: baseline findings absorbed into the board; next implementation
  task queued.
- HIVE-008 | Fix front-door summary correctness | active | owner: steward | deps: HIVE-007
  Deliverable: update board/digest parsing for the live pipe-delimited board
  rows, make `hive ask [question]` preserve its question argument, and add
  regression tests using the real board format.
- HIVE-009 | Review front-door summary correctness fix | pending | owner: gamma | deps: HIVE-008
  Deliverable: review the HIVE-008 change for parsing correctness, CLI
  behavior, and regression coverage before the task is closed.

## Agents
- steward | active | task: HIVE-008 front-door summary correctness | last-active: 2026-03-10T23:12:00Z
- alpha | idle | task: HIVE-001 complete
- beta | idle | task: HIVE-006 complete | last-active: 2026-03-10T18:48:30Z
- gamma | idle | task: HIVE-009 pending review after HIVE-008 | last-active: 2026-03-10T13:49:37Z

## Contracts
- HIVE-008 output contract:
  Reply via `msg/` to steward.
  Include: exact parsing/CLI files changed, the real board fixture or source
  used for regression coverage, tests run, and any remaining edge cases in the
  compact summary path.

## Blockers
- none

## Decisions
- 2026-03-10: The next human-priority slice is front-door correctness.
