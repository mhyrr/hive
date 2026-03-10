---
name: state-efficient-ops
scope: all-agents
description: Efficient state and token management for HIVE agents
---

# Skill: State-Efficient Operations

This skill teaches agents to manage HIVE state without wasting tokens.
Load this skill at the start of every session.

## File Reading Discipline

### Append-Only Files (LOG.md, feed.md, journals)
- Use `tail -n 20` to read the recent window, never the full file
- Only read more history if the recent window is insufficient
- When writing, always append — never rewrite

### Structured State Files (BOARD.md, PLAN.md, config.md)
- Use `grep`/`rg` to find the exact section or key first
- Read only the section you need, not the whole file
- For BOARD.md: read the Tasks and Agents sections first, skip Decisions unless relevant

### Message Files (msg/)
- Read frontmatter headers first (the YAML block between `---` markers)
- Only read the full body when the header indicates relevance
- Filter by `status: open` and your agent id before reading bodies
- Use `hive inbox <agent>` instead of manually scanning the msg directory

## Prompt Token Budget

### What Belongs Inline (always loaded)
- Your assignment or goal
- Compact state digest (board summary, run status)
- Identity (SOUL.md — keep this small)
- Messages addressed to you

### What Belongs Path-Referenced (read on demand)
- Full BOARD.md (use digest first, read full only when needed)
- Full PLAN.md (read your section, not the whole plan)
- Persona files (read once at session start)
- AGENTS.md (read once at session start)
- SELF.md (read once at session start)
- Project config, memory, knowledge (read when relevant)
- LOG.md (tail recent entries only)

### The Rule
If you can answer the question from the digest, don't read the full file.
If you can find the answer with grep, don't read the whole file.
If you only need recent history, use tail, not cat.

## Markdown as Searchable Store

Large markdown files are searchable stores, not prompt cargo.

Patterns:
- `rg "## Tasks" BOARD.md` — jump to the tasks section
- `rg "status: active" runs/active/` — find active runs
- `tail -n 5 LOG.md` — recent log entries
- `rg "^### alpha" PLAN.md` — find your plan section
- `rg "status: open" msg/*.md` — find open messages

## State Update Efficiency

### Writing State
- Append a single entry, don't rewrite the file
- Use `hive log`, `hive msg`, `hive feed` commands instead of manual file writes
- One write per update, not read-modify-write cycles

### Checking State
- `hive inbox <agent>` — cheaper than scanning msg/ yourself
- `hive status` — cheaper than reading BOARD.md + msg/ yourself
- `hive ps` — cheaper than scanning runs/active/
- `hive feed 5` — cheaper than reading feed.md

## Token Budget Targets

For a typical worker session:
- Prompt overhead: <1,500 tokens (identity + assignment + digest + rules)
- First file reads: ~2,000 tokens (AGENTS.md + persona + relevant board section)
- Total orientation cost: <4,000 tokens before starting real work

For a steward session:
- Prompt overhead: <2,000 tokens (identity + goal + signals + digests + messages)
- First file reads: ~3,000 tokens (AGENTS.md + persona + full board + recent results)
- Total orientation cost: <5,000 tokens before starting orchestration
