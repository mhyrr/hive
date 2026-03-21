# Memory Lifecycle

## Problem

Hive has the structural foundations for memory — entity storage, journal
extraction, heat tracking, revision deltas — but lacks the automated
maintenance loop that keeps memory alive over time. Without lifecycle
management, memory is a write-only graveyard: facts accumulate, nothing
decays, nothing gets validated, and context budgets eventually blow.

The comparison points here are Felix/OpenClaw (Nat Eliason's "How to
Hire an AI" playbook) and Arden (Sam's persistent VPS agent). Both
solved memory lifecycle problems that Hive hasn't yet addressed.

## Where Hive Already Leads

**Revision + delta + fingerprint system.** Felix relies on a nightly
prose summary to capture what changed. Hive computes precise structural
diffs via SHA1 fingerprints of state objects and maintains a JSONL delta
history. This is mechanically superior — you can answer "what changed"
without relying on a summarization prompt to get it right.

**Multi-agent context scoping.** Felix is a single agent. Hive's worker
brief system already scopes context per agent, loading only relevant
messages, scope roots, and related run results. Memory lifecycle should
preserve this property — agents should get hot facts for *their* scope,
not everything.

**Structured entity storage.** The `memory/entities/` directory with
`summary.md` + `items.jsonl` per entity already mirrors Felix's PARA
layout. The skeleton is there.

## What's Missing

### 1. Fact-Level Decay

**Current state:** Heat tracking exists at the project level (hot/warm/cold
in `memory-heat.json`), but individual facts within a project have no
temperature. A project with 50 facts loads all 50 or none.

**Target state:** Each fact in `items.jsonl` carries:
- `lastAccessed` — timestamp of last inclusion in a prompt
- `accessCount` — how many times loaded
- Derived temperature: hot (≤7 days), warm (8–30 days), cold (30+ days)

Hot facts get featured in `summary.md`. Warm facts are included at lower
priority. Cold facts drop from summaries but remain in `items.jsonl` for
retrieval on demand. Facts that get accessed frequently resist decay —
they stay warm longer. Cold facts can be "reheated" when referenced again.

**Key rule: nothing is ever deleted.** Decay controls *prominence*, not
existence.

### 2. Nightly Extraction

**Current state:** `extractMemory()` and the journal system exist, but
it's unclear whether automated extraction runs on a schedule. The
cognition system has tasks for memory-hotset and stale-memory, but those
read memory state rather than writing new facts from conversations.

**Target state:** A scheduled cognition task that runs daily (or at session
end) and:
1. Reviews the day's session turns
2. Extracts durable facts (skip small talk, transient requests)
3. Stores them in the appropriate entity folders
4. Updates daily journal with a timeline
5. Bumps `accessCount` on any facts that were referenced

This is the heartbeat of the memory system. Without it, memory only
grows when someone manually adds to it.

**What counts as a durable fact:**
- Decisions made (technology choices, architecture decisions)
- Status changes (project phase transitions, deadlines moved)
- Relationships learned (who works on what, who to contact about X)
- Preferences discovered (communication style, tool preferences)
- Conventions established (naming patterns, workflow rules)

**What to skip:**
- Transient debugging context
- One-off questions and answers
- Implementation details derivable from code
- Anything already in git history

### 3. Fact Supersession

**Current state:** Facts are either present or absent. No versioning, no
conflict resolution. Two contradictory facts can coexist with no way to
know which is current.

**Target state:** Each fact in `items.jsonl` gains:
- `status: "active" | "superseded" | "archived"`
- `supersededBy: "<fact-id>"` — pointer to the replacing fact

When a new fact contradicts an old one, the old fact gets marked
`superseded` with a pointer. The chain is preserved so you can trace how
understanding evolved:

```json
{
  "id": "proj-003",
  "fact": "Project uses Next.js",
  "status": "superseded",
  "supersededBy": "proj-007"
}
```

This is cheap to implement and prevents the worst failure mode: stale
facts getting loaded into context and causing wrong decisions.

### 4. Summary Rewriting

**Current state:** Entity `summary.md` files are written once and updated
manually.

**Target state:** Summaries are regenerated periodically (weekly or when
heat distribution changes significantly):
- Hot facts get top billing
- Warm facts included at lower priority
- Cold facts dropped from summary, remain in `items.jsonl`
- Superseded facts excluded entirely

The summary becomes a *view* over the fact store, not a separate source
of truth.

## What to Deprioritize

**Vector search / semantic retrieval.** Felix uses a QMD vector backend
that reindexes every 5 minutes. This matters when you have thousands of
heterogeneous facts about people, companies, and conversations across
many domains. For a coding-focused Hive, structured file paths + grep
get you most of the way. If the Hive eventually gets comms access and
starts tracking hundreds of external entities, revisit then.

**Cross-entity relationship graphs.** Felix tracks `relatedEntities` on
facts. Useful for a CEO agent managing a company's full context. Less
critical for a coding team where relationships are implicit in the
project structure. Nice to have, not load-bearing.

## Implementation Order

1. **Fact-level fields** — add `lastAccessed`, `accessCount`, `status`,
   `supersededBy` to the JSONL item schema. Update read/write functions.
2. **Supersession** — when writing a new fact that contradicts an existing
   one, mark the old one superseded. Start with manual supersession via
   steward judgment; automate conflict detection later.
3. **Nightly extraction** — build or enable a cognition task that harvests
   facts from session turns daily. The journal infrastructure already
   exists; the automation may not.
4. **Decay + summary rewriting** — compute fact temperature from
   `lastAccessed`, regenerate summaries based on heat. This is the
   payoff step where memory starts feeling alive.

## Design Constraints

- **File-first.** No external databases. Memory lives in markdown and
  JSONL files that any agent (or human) can read with `cat`.
- **Agent-scoped.** The lifecycle must respect worker scope boundaries.
  An agent working on project A shouldn't have its context polluted
  with cold facts from project B.
- **Deterministic.** No probabilistic retrieval for core memory. Grep
  and structured paths, not embeddings. Predictability over cleverness.
- **Append-only storage.** Facts are never deleted, only superseded or
  decayed. The full history is always recoverable.

## Open Questions

- Should extraction run at session end, on a fixed schedule, or both?
- How aggressive should decay be? 30 days to cold may be too fast for
  projects with long quiet periods.
- Should the steward be able to explicitly pin facts as "always hot"
  to prevent decay on critical conventions?
- When the Hive gets comms, how does external-facing memory differ
  from internal project memory? Different decay rates? Different
  access controls?
