# HIVE Memory Architecture

This document adapts the strongest memory ideas from OpenClaw-style systems to
HIVE’s file-first multi-project runtime.

The core principle stays the same:

- memory should compound
- retrieval should stay cheap
- durable knowledge should not be trapped in chat history

## Problem

HIVE already has:

- `SOUL.md`
- `IDENTITY.md`
- `SELF.md`
- project memory files
- journal scaffolding

What it does not yet have is a strong memory lifecycle.

Right now memory is mostly append-only and manual. That is useful, but it does
not yet create institutional knowledge that gets hotter or colder over time.

## Product Goal

The steward should gradually become better informed about:

- Greg’s preferences
- project-specific conventions
- recurring people and entities
- recent decisions
- long-running patterns across projects

without reloading the full archive every turn.

## Memory Layers

### Layer 1: Operating Knowledge

Small curated files loaded often:

- `SOUL.md`
- `IDENTITY.md`
- `SELF.md`
- `AGENTS.md`
- `memory/knowledge.md`

This is HIVE’s durable operating stance.

### Layer 2: Project Memory

Project-local durable learnings:

- `memory/projects/<project>.md`

This remains the current markdown source of truth for conventions, facts,
decisions, and open questions.

### Layer 3: Daily Extraction

Chronological notes:

- `memory/journal/YYYY/MM/DD.md`

These should record:

- key events
- decisions
- changes in project status
- approvals granted or rejected
- incidents and resolutions

### Layer 4: Entity Memory

Structured storage for recurring entities:

- `memory/entities/projects/<id>/summary.md`
- `memory/entities/projects/<id>/items.jsonl`
- `memory/entities/people/<id>/summary.md`
- `memory/entities/companies/<id>/summary.md`

The markdown summary is for fast reads. The JSONL items are the durable atomic
fact store.

## Derived Runtime State

To keep prompts compact, memory should also have derived state:

- `state/memory-summary.json`
- `state/memory-heat.json`
- `state/recent-decisions.json`

These are disposable accelerators, not source of truth.

## Heat / Decay Model

HIVE should eventually track:

- `lastAccessed`
- `accessCount`
- `status` (`active`, `superseded`, `archived`)

This gives the steward a simple hot/warm/cold model without requiring a vector
database first.

## Retrieval Strategy

The retrieval order should be:

1. operating files
2. derived summaries
3. targeted project memory
4. targeted journal slices
5. entity records

The steward should search before reading.

## Write Strategy

Memory writes should be explicit and narrow:

- direct CLI writes for facts/conventions/decisions/questions
- nightly or scheduled extraction for journal/entity updates
- steward-triggered writes only when the knowledge is durable

## First Major Build After Trust

The next major memory slice should be:

1. daily extraction command/job
2. journal file generation
3. structured entity directories
4. derived memory summaries for the steward

That gives HIVE compounding memory without prematurely adopting a heavy search
backend.

## Current Implementation Slice

The first memory slice now has a concrete shape:

- `hive memory extract` builds the daily journal and derived summary JSON
- project entity summaries are generated under `memory/entities/projects/<id>/`
- person and company memory can be updated explicitly through `hive memory entity`
- prompt surfaces read compact memory digests instead of only raw project memory

This is still file-first and deterministic. There is no vector backend, hidden
memory daemon, or opaque retrieval layer.
