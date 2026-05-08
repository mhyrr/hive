# Memory Architecture

HIVE's memory system is inspired by how biological memory works —
specifically the hippocampal mechanisms described in systems like
Hippo (kitfunso/hippo-memory). The core insight: memory shouldn't be
a filing cabinet. Useful things should get stronger over time, unused
things should fade, and search should rank by relevance, not just
substring matching.

> **2026-04-27 — V1 nightly pipeline.** The storage layer (BM25, decay,
> the three-layer model) below is unchanged. The V1 cutover added a
> verifier in front of canon: agents write to a `candidates.md` queue
> mid-session, and the nightly pipeline (Pass A → B → C → V → F) decides
> what becomes canonical. See "V1 Nightly Pipeline" below for the write
> path. Read paths (`searchMemory`, `read_hive_memory`) are unchanged.

## Three-Layer Model

Memory flows from raw capture to compiled intelligence to navigational
summary. Each layer serves a different purpose:

```
Session → Log (Layer 1) → Knowledge (Layer 2) → Index (Layer 3)
           raw capture      compiled facts       auto-generated
           per-day .md      knowledge.md          _index.md
           7-day window     permanent (with decay) loaded at session start
```

**Log** — Raw session capture. Daily markdown files under
`~/.hive/memory/projects/<name>/log/`. Written by `reflect_session`
and `appendToLog`. Entries have timestamps and type labels. Searched
with a 14-day window by default. No metadata tracking — recency is
the implicit ranking signal.

**Knowledge** — Compiled project intelligence. A single `knowledge.md`
with four sections: Durable Facts, Conventions, Decisions, Open
Questions. Written deliberately by agents via `write_hive_memory`.
Entries can be superseded (struck through with a date). This is the
system of record.

**Index** — Auto-generated summary loaded at session start. Built
mechanically by `rebuildIndex()` from knowledge + recent log. Designed
to give a new session enough context to be useful without reading
everything.

## Directory Structure

```
~/.hive/memory/projects/<name>/
├── knowledge.md      # Compiled intelligence (human-editable). Only Pass F writes here.
├── candidates.md     # Mid-session writes pending nightly admission (JSONL).
├── _meta.json        # Strength/decay metadata (engine state)
├── _index.md         # Auto-generated session-start summary
└── log/
    ├── 2026-04-10.md
    ├── 2026-04-09.md
    └── ...

~/.hive/memory/runs/<DATE>/
├── condition.json              # Pass A signal report (sessions/git/tickets/heartbeat)
├── candidates.B.<project>.json # Sonnet's per-project extractions
├── candidates.C.json           # Sonnet's cross-project reflections
├── decisions.json              # Opus's per-candidate verdicts (accept/supersede/merge/reject)
├── verifier-output.json        # Full Pass V structured output (read by Pass F)
├── briefing.md                 # Morning briefing (lands in ~/.hive/briefings/)
├── gaps.md                     # Things Sonnet missed
├── taste.md                    # Principles reinforced / corrected
└── usage.json                  # Per-pass tokens + cost (B/C/V aggregate)
```

## BM25 Search

Search uses BM25 (Best Matching 25), the same algorithm behind
Elasticsearch and Lucene. It replaces the previous substring matching
with ranked relevance scoring.

### How It Works

Given a query like "heartbeat dispatch", BM25 scores each memory
entry by three factors:

1. **Term Frequency (TF)** — How often the query term appears in the
   entry. Saturated via a parameter `k1 = 1.2` so repeating a word
   doesn't linearly increase the score.

2. **Inverse Document Frequency (IDF)** — Terms that appear in fewer
   entries are more discriminating. "heartbeat" scores higher than
   "the" because it's rarer across the corpus.

3. **Document Length Normalization** — Short, focused entries aren't
   penalized relative to long ones. Controlled by `b = 0.75`.

Multi-term queries score each term independently and sum. An entry
matching both "heartbeat" and "dispatch" ranks higher than one
matching only "heartbeat".

### Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `k1` | 1.2 | Term frequency saturation |
| `b` | 0.75 | Document length normalization |

These are the standard defaults used across search engines. They work
well for short documents like memory entries.

### Tokenization

Simple whitespace + punctuation split, lowercased. No stemming or
stop-word removal — the corpus is small enough that exact tokens work
fine, and stemming adds complexity without meaningful recall
improvement at this scale.

## Decay and Strength

Inspired by hippocampal memory dynamics. Every knowledge entry has a
strength score that evolves over time. Strong entries rank higher in
search; weak entries fade toward the bottom.

### Strength Model

Each knowledge entry tracks metadata in `_meta.json`:

```json
{
  "entries": {
    "a1b2c3d4": {
      "createdAt": "2026-04-03",
      "lastRecalled": "2026-04-10",
      "recallCount": 3,
      "halfLife": 30
    }
  },
  "version": 1
}
```

**Entry identity:** First 8 characters of SHA-256 of the cleaned
entry text (tags stripped). Stable across tag edits. Resets if content
changes, which is correct — an edited entry is conceptually new.

**Strength calculation:**

```
age = days since createdAt
decayFactor = 0.5 ^ (age / halfLife)
strength = decayFactor * (1 + log2(recallCount + 1))
```

### Decay Parameters

| Entry type | Half-life | Retrieval boost | Cap |
|------------|-----------|-----------------|-----|
| Knowledge | 30 days | +7 days per recall | 90 days |
| Log | 7 days (implicit) | none | none |

**Decay affects ranking only, never deletes.** Knowledge.md is
human-readable and git-tracked. Low-strength entries rank lower in
search but remain in the file indefinitely. Pruning is a human
decision, not an automated one.

### Retrieval Strengthening

Two paths strengthen entries — explicit search and auto-load. Both update
metadata, with auto-load damped to avoid drowning out genuine retrieval.

**Explicit search** — when `searchMemory()` returns an entry, its metadata
is updated:

- `lastRecalled` set to today
- `recallCount` incremented by 1
- `halfLife` extended by 7 days (capped at 90)

**Auto-load (V1, Group 1 fix)** — when `rebuildIndex()` selects an entry
for the session-start `_index.md`, the entry gets a damped bump:

- `lastRecalled` set to today
- `recallCount` incremented by 0.25 (fractional)
- `halfLife` extended by 1 day (capped at 90)

The intuition: entries you actually use survive longer. An entry recalled
7 times has a half-life of 79 days and a strength multiplier of ~4x from
the recall count factor. Auto-loaded entries earn smaller bumps but still
strengthen — closes the original Hippo gap where index-loaded entries went
un-reinforced even though they were the ones earning a place in the prefix.

### Strength Examples

| Scenario | Age | Recalls | Half-life | Strength |
|----------|-----|---------|-----------|----------|
| Brand new entry | 0 | 0 | 30 | ~1.0 |
| 30 days, never recalled | 30 | 0 | 30 | ~0.5 |
| 30 days, recalled 3x | 30 | 3 | 51 | ~1.9 |
| 60 days, recalled 7x | 60 | 7 | 79 | ~2.1 |
| 90 days, never recalled | 90 | 0 | 30 | ~0.12 |

## Combined Search Ranking

The final score for a search result combines BM25 relevance with
strength:

**Knowledge entries:**
```
finalScore = bm25Score * strength
```

**Log entries:**
```
recencyWeight = linear from 1.0 (today) to 0.1 (14 days ago)
finalScore = bm25Score * recencyWeight
```

Results are sorted by `finalScore` descending across all layers.
Knowledge and log entries compete on the same scale — a highly
relevant log entry from today can outrank a weak knowledge entry.

## Metadata Lifecycle

| Operation | Metadata effect |
|-----------|----------------|
| `appendProjectMemory()` | Creates entry: `createdAt = now`, `halfLife = 30`, `recallCount = 0` |
| `searchMemory()` | Bumps `lastRecalled`, `recallCount += 1`, `halfLife += 7` (cap 90) |
| `rebuildIndex()` | Damped bump for indexed entries: `recallCount += 0.25`, `halfLife += 1` (cap 90). Also reads strength to rank entries. |
| `supersedeEntry()` / `supersedeEntryByHash()` | Removes old entry metadata, creates fresh for new entry |
| `mergeTagsIntoEntry()` | Adds tags to an existing entry; metadata untouched |
| `appendCandidate()` | No metadata effect — candidates queue lives outside the strength model until Pass F admits them |

Metadata is engine state, not part of the knowledge document.
`_meta.json` is not human-edited. If it's deleted or corrupted,
entries default to strength 1.0 — graceful degradation, not failure.

## Index Generation

`rebuildIndex()` produces the `_index.md` loaded at session start.
With strength scoring, the index becomes smarter:

- Entries sorted by strength descending
- If the corpus grows large (50+ entries per section), only the top
  20 strongest entries per section surface in the index, with a note
  to use `search_memory` for deeper queries
- Strength tier indicators (high/medium/low) help the session
  understand which facts are battle-tested vs. recently added

## Candidate Writers

Three paths land entries in `candidates.md` (a JSONL queue under the
project's memory directory). None ratify directly — the nightly verifier
admits, supersedes, merges, or rejects.

| Writer | Source | Provenance prefix |
| --- | --- | --- |
| `write_hive_memory` | Mid-session agent write (a fact, convention, decision, or question the agent wants to capture) | `session:pid-<pid> — agent-write at HH:MM:SSZ` |
| `reflect_session` | End-of-session batch write (durable learnings the agent wants the next session to inherit) | `session:pid-<pid> — reflect_session at HH:MM:SSZ` |
| `hive project bootstrap` | One-shot scan of a registered project — mechanical (`bootstrap:mechanical-scan`) and optionally LLM-inferred (`bootstrap:inference`) | `bootstrap:<mode>` |

`bootstrap` is a project-onboarding primitive. The mechanical mode (no
LLM, <2s) emits stack/build/test/CI/lint facts derived from config files
and entrypoints. The `--infer` mode adds one Sonnet call that reads 3-5
representative files plus the active stack skill (`~/.claude/skills/{stack}-*/SKILL.md`)
and emits 2-4 inferred conventions, an architecture summary, and key
dependencies. CLI: `hive project bootstrap [--infer] [--dry-run]`. MCP:
`bootstrap_infer_conventions`. Idempotent — re-running deduplicates against
existing canon and outstanding candidates.

Optional `provenance_note` on `write_hive_memory` lets the caller add
context the verifier can weigh.

## V1 Nightly Pipeline

The nightly pipeline at 2am is the only path into `knowledge.md`:

```
Pass A — Conditioning (mechanical, no LLM)
  ↓ read Claude Code transcripts from ~/.claude/projects and Codex transcripts from ~/.codex/sessions
  ↓ resolve each transcript to a registered HIVE project by project path / cwd
  ↓ rank session exchanges by tokenCount × novelty + always-include markers
  ↓ skip-if-trivial early exit emits a stub briefing

Pass B — Sonnet, per project with signal (parallel)
  ↓ extract decisions, conventions, durable facts, open questions
  ↓ each candidate carries a free-text provenance string

Pass C — Sonnet, cross-project (single call)
  ↓ extract reflections about Greg, Maya, the system

Pass V — Opus (single call) — reads B + C + candidates.md + canon
  ↓ produces decisions (accept | supersede(hash) | merge(hash) | reject)
  ↓ produces gaps (things Sonnet missed) + taste readout + briefing.md

Pass F — Apply (mechanical)
  ↓ walk decisions: appendProjectMemory / supersedeEntryByHash /
  ↓                 mergeTagsIntoEntry / drop rejected
  ↓ drain candidates.md → runs/{DATE}/candidates.consumed.{name}.md
  ↓ truncate inbox.md, rebuild _index.md per project touched
  ↓ land accepted reflections + project-scoped gaps as questions
  ↓ copy briefing.md → ~/.hive/briefings/{DATE}.md
```

**Provenance discipline.** Every candidate carries a provenance string the
verifier checks against the day's signal. If the cited source can't be
found, Opus can reject with reason `cite_unverifiable`. This is the gate
that keeps the system honest — facts in canon trace back to actual
exchanges or commits, not to plausible hallucinations.

**Run state is durable.** Each pass writes its artifact to
`~/.hive/memory/runs/{DATE}/` before the next pass consumes. Failures
localize: a Pass B failure on one project doesn't block others; a Pass V
failure cleanly skips F with the upstream artifacts intact for inspection.

**Cost.** Three LLM calls per night (two Sonnet, one Opus). Per-pass
token + USD recorded in `runs/{DATE}/usage.json`. Typical cost: $1–3.

**Restartability.** Each `run*` function deletes its target artifact at
the start of an attempt. Failure leaves absence (correct); success writes
fresh. Re-running on the same date overwrites cleanly without leaving
stale outputs from a prior attempt.

## Design Influences

- **Hippo** (kitfunso/hippo-memory): Two-speed storage, half-life
  decay, retrieval strengthening, consolidation. Zero dependencies.
  We adopted the decay math and retrieval strengthening concept but
  implemented against HIVE's markdown-only storage rather than using
  Hippo's SQLite backend.

- **ClawMem** (yoloshii/ClawMem): Hybrid RAG with BM25 + vector +
  RRF + cross-encoder reranking. Tiered injection (HOT/WARM/COLD).
  We adopted BM25 as the base search layer. Vector search and
  reranking are future possibilities if the corpus outgrows BM25.

- **claude-mem** (thedotmack/claude-mem): Progressive disclosure —
  lightweight index first, details on demand. Confirmed our existing
  index → knowledge → search layering is the right architecture.

## What We Chose Not To Do

- **Vector search / embeddings**: Adds API cost and latency. BM25
  handles 90%+ of cases at our current corpus scale (tens to low
  hundreds of entries per project). Revisit if we hit thousands.

- **SQLite / FTS5**: Would give us full-text search for free but
  introduces a storage dependency. HIVE's identity is markdown-only,
  git-trackable, human-readable. Worth the tradeoff.

- **Automatic deletion**: Decay never removes entries. Knowledge.md
  is a curated document. Pruning is a human judgment call.

- **Stemming / NLP**: The corpus is small. Simple tokenization works.
  Stemming would add complexity for marginal recall improvement.
