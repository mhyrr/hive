# Heartbeat Standing Orders: {{projectName}}

## Authorized Actions

### Auto-dispatch (do it, log it to inbox.md)
- Standalone documentation tasks (ticket type: task, clearly writing-only)
- Chores and cleanup tickets (ticket type: chore)
- Any ticket explicitly tagged `auto-dispatch`
- Goals written to inbox.md, if they map to a clear standalone task

When dispatching: `hive dispatch "<goal>" --ticket <id> --project {{projectName}}`
Log to inbox.md: what was dispatched, the run ID, and why.

**Dependency check:** Before dispatching any `auto-dispatch` ticket, verify its
dependencies are resolved (all `depends` tickets are closed). The context brief
marks blocked tickets — skip them and note why in inbox.md. Only dispatch tickets
marked ✅ READY.

### Auto-act (just do it)
- Memory consolidation (promote log entries to knowledge)
- Close tickets that are clearly done based on git history
- Add ticket notes with status observations
- Update ticket status when evidence is clear
- Create chore tickets from hygiene checks (tag: hygiene)
- Add notes to existing hygiene tickets with updated metrics

### Suggest only (write to inbox.md)
- Code features and bug fixes — suggest dispatching, don't dispatch
- Architecture changes
- Anything where the approach isn't obvious from the ticket spec

### Never
- Push to remote
- Merge PRs
- Deploy anything
- Delete branches or data
- Anything that violates TRUST.md (external actions or the hard limit)

## Health Checks

### Working Directory
- Run `git status --short`. Classify changes:
  - **Work-in-progress** (modified source): note what's being worked on
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

## Code Hygiene (daily)

Run these checks once per day. Skip if already reported today.

### Mechanical Checks (no LLM needed)
Run each command, report to inbox.md only if changed since last report.
If a metric crosses a threshold, create a ticket (type: chore, priority: p2, tag: hygiene).
If a ticket already exists for that metric, add a note instead of creating a duplicate.

**Detect project type first:**
- If `mix.exs` exists → Elixir project. Use `lib/` as source root, `*.ex` as extension.
- If `package.json` exists → JS/TS project. Use `src/` as source root, `*.ts` as extension.

**Debug pollution:**
- Elixir: `grep -rn "IO.inspect\|dbg(" lib/ --include="*.ex" | wc -l`
- TypeScript: `grep -rn "console.log" src/ --include="*.ts" | wc -l`
- Threshold: >10 → ticket ("Clean up N debug statements")

**Overgrown files (>1000 LOC):**
- Elixir: `find lib/ -name "*.ex" -exec wc -l {} + | awk '$1 > 1000' | sort -rn`
- TypeScript: `find src/ -name "*.ts" -not -path "*__tests__*" -exec wc -l {} + | awk '$1 > 1000' | sort -rn`
- Threshold: any file >1500 LOC → ticket ("Split <file> (N LOC)")

**Untested source files:**
- For each source file, check if a corresponding test file exists.
- Threshold: >5 untested source files → ticket

**Anti-patterns:**
- Elixir: `grep -rn "Mix.env()" lib/ --include="*.ex" | wc -l`
- Elixir: `grep -rn "String.to_atom" lib/ --include="*.ex" | wc -l`
- TypeScript: `grep -rn "catch {" src/ --include="*.ts" | wc -l`
- Threshold: any occurrence → ticket

Report format: one line per metric, only deltas from last check.
If all metrics unchanged: skip, don't clutter inbox.

## Code Health Review (weekly, Mondays)

Run once per week. This one uses judgment.

Pick 3-5 files changed in the last 7 days (`git log --since="7 days ago" --name-only`).
For each, quickly assess:
- Does the CLAUDE.md still accurately describe this area?
- Any patterns that contradict documented conventions?
- Test coverage: was a test added/updated for the change?
- Error handling: any new catch blocks that swallow errors?

Write a brief (5-10 line) health note to inbox.md.
Create tickets for anything concrete and actionable (type: chore, tag: hygiene).
If everything looks clean: "Weekly review: no issues found." and move on.
Do NOT auto-fix or auto-dispatch from this review. Report and ticket only.

## Escalation
- Build failure or failed dispatch → write to inbox.md
- Stale P1 ticket → mention in response
- Everything routine → 2-3 lines or HEARTBEAT_OK
