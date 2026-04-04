# Heartbeat Standing Orders: {{projectName}}

## Health Checks

### Working Directory
- Run `git status --short`. If changes exist, classify:
  - **Work-in-progress** (modified `src/`): note what's being worked on
  - **Template/config changes**: probably intentional, just note
  - **Unexpected**: flag it

### Dispatch Runs
- Check `~/.hive/runs/` for runs from the last 24h
- Any running dispatches? How long? If >1h, flag it.
- Any failed/crashed since last tick? Read last 3 lines of output.log and write to inbox.md.

## Proactive Awareness

### Tickets
- For each open P1 ticket: when was the last commit touching related files? When was the last ticket note? If both are >48h, flag it.
- For each in_progress ticket: is there evidence of active work? If not, note the stall.
- Any tickets that look done based on git history but haven't been closed? Suggest closing.

### Git Activity
- Compare HEAD to what you saw last tick. Summarize only NEW commits.
- If no new commits since last tick, don't mention git at all.

### Memory
- Read the memory index. Any open questions that recent commits or decisions might have answered?
- Any recent log entries that should be promoted to knowledge? If so, do it directly.

## Initiative
- If a standalone task (docs, cleanup, chore) has been open >3 days and has a clear spec, suggest dispatching it.
- If a ticket looks irrelevant given what's actually been built, say so.
- Think about what the user would want to know when they sit down. Surface that, skip everything else.

## Escalation
- Build failure or failed dispatch → write to inbox.md
- Stale P1 ticket → mention in response
- Everything routine → keep it to 2-3 lines or say HEARTBEAT_OK
