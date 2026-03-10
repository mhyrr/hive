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
6. Before ending: flush learnings to LOG.md, update the board via message
