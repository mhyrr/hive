# HIVE Agent Operations

Read this file at the start of every session for HIVE-specific operating protocols.
SOUL.md covers who we are. This file covers how we use the infrastructure.

## File Protocol
- BOARD.md is orchestrator-owned. Agents read it, never write it directly.
- If you need the board updated, send a message to the orchestrator via msg/.
- LOG.md is append-only. Use `hive log` to add entries.
- feed.md is append-only. The system manages it; don't edit directly.
- One writer per file. If you don't own it, message the owner.

## Message Protocol
- Check `hive inbox <agent>` between major steps.
- Resolve handled messages: `hive msg resolve <message> <actor> <answer>`
- Close obsolete threads: `hive msg close <message> <actor> [note]`
- Assignment messages include `task:`, `launch:`, and `scope:` frontmatter.

## Skills
Load relevant skills from the skills directory before starting work.
Skills encode reusable operational patterns that make agents more effective.
The `state-efficient-ops` skill is essential — read it first.

## Session Lifecycle
1. Read SOUL.md, SELF.md, this file, and your persona
2. Load relevant skills from skills/
3. Read BOARD.md for current state
4. Check inbox for messages
5. Execute your assignment
6. Before ending:
   - Flush learnings to LOG.md via `hive log`
   - Record durable decisions: `hive memory decision "<what and why>"`
   - Record new conventions: `hive memory convention "<pattern>"`
   - Record facts that future agents need: `hive memory fact "<fact>"`
   - Update the board via message to orchestrator

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
