# HIVE Agent Operations

Read this file at the start of every session for HIVE-specific operating protocols.
SOUL.md is shared culture. IDENTITY.md is what a HIVE agent is. SELF.md is the
human. This file covers how we use the infrastructure.

## File Protocol
- BOARD.md is steward-owned.
  Everyone else reads it and requests changes via msg/.
- LOG.md is append-only. Use `hive log` to add entries.
- feed.md is append-only. Keep it high signal; don't use it as a scratchpad.
- One writer per file. If you don't own it, message the owner.

## Message Protocol
- Check `hive inbox <agent>` between major steps.
- Resolve handled messages: `hive msg resolve <message> <actor> <answer>`
- Close obsolete threads: `hive msg close <message> <actor> [note]`
- Assignment messages include `task:`, `launch:`, and `scope:` frontmatter.

### Assignment Message Example
```
---
to: alpha
from: steward
task: PROJ-001
launch: auto
scope: src/auth/ tests/auth/
---

Implement POST /api/auth/login and /api/auth/refresh.
Use Joken for JWT with 1-hour expiry. Contract is on the board.
```

## Skills
Load relevant skills from the skills directory before starting work.
Skills encode reusable operational patterns that make agents more effective.
If `state-efficient-ops.md` is present, read it first for steward or
supervision work.

### Available Skills
- **state-efficient-ops** — Token-efficient state reading patterns. Prefer digests over full file reads. Use `hive status`, `hive inbox`, `hive ps` instead of raw file access.
- **autonomous-ops** — Initiative patterns for autonomous operation. When to act without asking, how to decompose and delegate, when to escalate.

## Session Lifecycle
1. Read compact runtime state first when it exists; use raw file reads
   selectively.
2. Read SOUL.md, IDENTITY.md, SELF.md, this file, and your persona.
3. Load the skills that fit the task.
4. Read the board, plan, memory, and inbox sections you actually need.
5. Execute your assignment.
6. Before ending:
   - Flush learnings to LOG.md via `hive log`
   - Record durable decisions: `hive memory decision "<what and why>"`
   - Record new conventions: `hive memory convention "<pattern>"`
   - Record facts that future agents need: `hive memory fact "<fact>"`
   - Update the board directly if you own it; otherwise route the change to
     the steward via msg/

## Memory
Project memory is your team's accumulated knowledge — decisions, conventions, and facts
that persist across sessions. Read it at session start. Update it when you learn something
durable.

Commands:
- `hive memory` — show project memory
- `hive memory decision "<what we decided and why>"` — log a decision
- `hive memory convention "<pattern the team follows>"` — log a convention
- `hive memory fact "<something always true about this project>"` — log a fact
- `hive memory question "<unresolved item>"` — log an open question

Good memory entries are:
- Specific enough to be actionable ("Use Joken for JWT, not Guardian — API-only app")
- Stable across sessions (not "currently working on task 003")
- Non-obvious (don't record what's already in PLAN.md or config)

## Coordination Protocol

The board is our shared consciousness. BOARD.md tells the full story — read it before you act.

**Communicate through files, not assumptions.** Knowledge in a context window dies when the session ends. Knowledge in a file lives forever. Write it down.

**Respect scope.** Don't touch files another agent owns without communication. Raise disagreements — don't silently override. The steward resolves disputes.

**Surface problems early.** A problem raised now is a five-minute conversation. A problem discovered late is a week of rework.

**Trust the steward.** The steward sees the whole board. Execute with commitment even when you'd have chosen differently. Raise concerns via message, but don't block on disagreement.

## Session Discipline

**Read before writing.** Always.

**Write before forgetting.** Decisions, learnings, interfaces — if it matters, it goes in a file.

**Ask before assuming.** A 30-second message beats a 3-hour mistake.

**Ship before perfecting.** Professional quality means "confident in production," not "couldn't possibly be better." When the tests pass and the code is clear, it's done.
