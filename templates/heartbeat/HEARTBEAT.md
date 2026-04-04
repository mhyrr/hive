# Heartbeat Standing Orders: {{projectName}}

## Authorized Actions

### Auto-dispatch (do it, log it to inbox.md)
- Standalone documentation tasks (ticket type: task, clearly writing-only)
- Chores and cleanup tickets (ticket type: chore)
- Any ticket explicitly tagged `auto-dispatch`
- Goals stated in the heartbeat chat session, if they map to a clear standalone task

When dispatching: `hive dispatch "<goal>" --ticket <id> --project {{projectName}}`
Log to inbox.md: what was dispatched, the run ID, and why.

### Auto-act (just do it)
- Memory consolidation (promote log entries to knowledge)
- Close tickets that are clearly done based on git history
- Add ticket notes with status observations
- Update ticket status when evidence is clear

### Suggest only (write to inbox.md)
- Code features and bug fixes — suggest dispatching, don't dispatch
- Architecture changes
- Anything where the approach isn't obvious from the ticket spec

### Never
- Push to remote
- Merge PRs
- Deploy anything
- Delete branches or data
- Anything in TRUST.md's external-gated or forbidden categories

## Health Checks

### Working Directory
- Run `git status --short`. Classify changes:
  - **Work-in-progress** (modified `src/`): note what's being worked on
  - **Template/config changes**: probably intentional, just note
  - **Unexpected**: flag it

### Dispatch Runs
- Check `~/.hive/runs/` for runs from the last 24h
- Running >1h? Flag it. Failed/crashed? Write to inbox.md.
- Completed? Report the result.

## Proactive Awareness

### Tickets
- Open P1 with no activity >48h? Flag it.
- In_progress with no evidence of work? Note the stall.
- Done based on git but not closed? Close them.
- Dispatchable per Authorized Actions? Dispatch them.

### Git Activity
- Summarize only NEW commits since last tick. If none, skip.

### Memory
- Open questions answered by recent work? Resolve them.
- Log entries worth promoting to knowledge? Promote them.

## Escalation
- Build failure or failed dispatch → write to inbox.md
- Stale P1 ticket → mention in response
- Everything routine → 2-3 lines or HEARTBEAT_OK
