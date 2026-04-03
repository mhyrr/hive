# Heartbeat Standing Orders: {{projectName}}

## Checks

### Git Status
- Any uncommitted changes in the working directory?
- Any new commits on main since last tick?

### Tickets
- Any P1 tickets open with no recent activity (>24h)?
- Any tickets tagged "blocked"?

### Dispatch Runs
- Any running dispatches? How long have they been going?
- Any failed/crashed dispatches since last tick?

### Memory Consolidation
- Read recent session log entries (last 7 days) via `read_hive_memory`
- For each log entry not yet in knowledge:
  - If it's durable and non-obvious, promote it to knowledge with `write_hive_memory` (include tags)
  - If it contradicts an existing knowledge entry, use `write_hive_memory` with `supersedes` to replace it
  - If it's transient or session-specific, skip it
- Check for stale open questions — any that have been answered by recent decisions?

## Standing Instructions
<!-- Add project-specific instructions below -->
<!-- Examples: -->
<!-- - If tests fail on main, write to inbox.md -->
<!-- - Watch for changes in src/lib/ and note any new patterns -->

## Escalation
- Failed dispatch or test failure on main → write to inbox.md
- Everything else → log silently, morning briefing picks it up
