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

> **2026-08-17 — Context layer.** Search now caps and floors its results,
> leaves session logs out unless asked, and stems tokens. Taste units admit
> themselves. The behavior is described below; the design and its evidence are
> in [specs/2026-08-16-context-layer-design.md](specs/2026-08-16-context-layer-design.md),
> which is the authority where the two differ.

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
and `appendToLog`. Entries have timestamps and type labels. Search
leaves logs out unless the caller sets `include_logs` (CLI: `--logs`);
then it reads a 14-day window. No metadata tracking — recency is the
implicit ranking signal.

**Knowledge** — Compiled project intelligence. A single `knowledge.md`
with four sections: Durable Facts, Conventions, Decisions, Open
Questions. Written deliberately by agents via `write_hive_memory`.
Entries can be superseded (struck through with a date). Tags are
metadata on the line, and so is the legacy recurrence marker
(`_(seen 3×, last 2026-08-17)_`) that TK-147 wrote on recurring gap
questions until 2026-08-28. `entryHash` strips both, so an entry's
identity is its prose. Nothing writes or updates the marker now.
The verifier's own gaps ("Sonnet missed X") never enter this file — they
are the pipeline reporting on itself and live in the briefing and
`runs/{DATE}/gaps.md`. This is the system of record.

**Index** — Auto-generated summary loaded at session start. Built
mechanically by `rebuildIndex()` from knowledge + recent log. Designed
to give a new session enough context to be useful without reading
everything.

## Directory Structure

```
~/.hive/memory/projects/<name>/
├── knowledge.md      # Compiled intelligence (human-editable). Only Pass F writes here.
├── archive.md        # Entries that left canon: retired by V, or superseded (TK-166). Search reads it; V and the index don't.
├── candidates.md     # Mid-session writes pending nightly admission (JSONL).
├── _meta.json        # Strength/decay metadata (engine state)
├── _index.md         # Auto-generated session-start summary
└── log/
    ├── 2026-04-10.md
    ├── 2026-04-09.md
    └── ...

~/.hive/memory/runs/<DATE>/
├── condition.json              # Pass A signal report (sessions/git/tickets/inbox)
├── candidates.B.<project>.json # Sonnet's per-project extractions
├── candidates.C.json           # Sonnet's cross-project reflections
├── decisions.json              # Opus's per-candidate verdicts (accept/supersede/merge/reject)
├── verifier-output.json        # Full Pass V structured output (read by Pass F)
├── briefing.md                 # Morning briefing (lands in ~/.hive/briefings/)
├── gaps.md                     # Things Sonnet missed
├── gaps.applied.log            # Pass F's disposition for each gap (JSONL, always "briefing")
├── verify-shadow.{json,md}     # Shadow nights only: full V vs neighbour-scoped V, per candidate (TK-166)
├── retirements.skipped.log     # Retires Pass F skipped because a same-night decision touched the target
├── taste.md                    # Principles reinforced / corrected
├── resume.json                 # Which passes finished for this date; a retry skips them
└── usage.json                  # Per-pass tokens + cost; input split into uncached / cache write / cache read
```

## BM25 Search

Search uses BM25 (Best Matching 25), the same algorithm behind
Elasticsearch and Lucene. It replaces the previous substring matching
with ranked relevance scoring.

### How It Works

Given a query like "watch evidence", BM25 scores each memory
entry by three factors:

1. **Term Frequency (TF)** — How often the query term appears in the
   entry. Saturated via a parameter `k1 = 1.2` so repeating a word
   doesn't linearly increase the score.

2. **Inverse Document Frequency (IDF)** — Terms that appear in fewer
   entries are more discriminating. "evidence" scores higher than
   "the" because it's rarer across the corpus.

3. **Document Length Normalization** — Short, focused entries aren't
   penalized relative to long ones. Controlled by `b = 0.75`.

Multi-term queries score each term independently and sum. An entry
matching both "watch" and "evidence" ranks higher than one
matching only "watch".

### Parameters

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `k1` | 1.2 | Term frequency saturation |
| `b` | 0.75 | Document length normalization |

These are the standard defaults used across search engines. They work
well for short documents like memory entries.

### Tokenization

Text is lowercased and split on whitespace and punctuation. Each token
then goes through `stem()` (`src/lib/memory.ts`). There is no stop-word
removal.

`stem()` is light suffix stripping, not Porter. It tries these suffixes
in order and takes the first that fits: `ies`, `ied`, `ier`, `ing`,
`age`, `ment`, `ness`, `es`, `ed`, `s`, `y`, `e`. Two guards keep it
conservative:

- A token of four characters or fewer is never stemmed. `runs` does
  not become `run`, so a search for `run` misses `runs`. This is a
  known limit.
- A suffix is skipped if the stem left would be shorter than four
  characters. `notes` skips `es` (it would leave `not`) and takes `s`
  (`note`). A final `s` after another `s` is never stripped (`class`).

The goal is convergence, not correct English. The query and the entry
go through the same function, so the stem only has to be the same on
both sides. `model`/`models` meet, and `verifier`/`verifies`/`verified`
all become `verif`. Before stemming, the query "what model does the
verifier use" scored zero against the entry that answered it.

### Result limits

Search ranks every match, then cuts twice (`searchMemory`):

1. **Relevance floor.** It drops every result that scores under
   `SEARCH_FLOOR` (0.25) × the top score. This cut does most of the
   work: a precise query has one strong hit and returns two or three
   results.
2. **Cap.** It keeps at most `SEARCH_TOP_K` (10) results. The cap
   binds only on vague queries. Callers raise it with `top_k` (MCP)
   or `--top-k N` (CLI).

When the cap cuts, the output says so:
`Showing top 10 of N matches for "…" (… narrow the query or pass top_k for more)`.
N counts the results that passed the floor, not every entry that
scored above zero.

**Session logs are out by default**, from the results and from the
BM25 corpus. Logs were most of the document count, and that skewed
IDF against compiled knowledge. Set `include_logs` (MCP) or `--logs`
(CLI) for forensics such as "when did we change X".

`taste-store.ts` `searchTasteStore` uses the same 0.25 floor.

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
is updated. Only returned entries are bumped, not every entry that scored
above zero. Internal probes that no person reads (dedupe checks) pass
`noBump` and bump nothing:

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

**Log entries** (only with `include_logs`):
```
recencyWeight = linear from 1.0 (today) to 0.1 (14 days ago)
finalScore = bm25Score * recencyWeight
```

Results are sorted by `finalScore` descending across all layers, then
cut by the floor and the cap (see "Result limits"). With logs included,
knowledge and log entries compete on the same scale — a highly relevant
log entry from today can outrank a weak knowledge entry.

## Metadata Lifecycle

| Operation | Metadata effect |
|-----------|----------------|
| `appendProjectMemory()` | Creates entry: `createdAt = now`, `halfLife = 30`, `recallCount = 0` |
| `searchMemory()` | For returned entries only: bumps `lastRecalled`, `recallCount += 1`, `halfLife += 7` (cap 90). No effect with `noBump`. |
| `rebuildIndex()` | Damped bump for indexed entries: `recallCount += 0.25`, `halfLife += 1` (cap 90). Also reads strength to rank entries. |
| `supersedeEntry()` / `supersedeEntryByHash()` | Removes old entry metadata, creates fresh for new entry |
| `mergeTagsIntoEntry()` | Adds tags to an existing entry; metadata untouched |
| `retireEntryByHash()` | Removes the entry's metadata; the line moves to archive.md. Archive hits rank at a fixed strength of 0.5 and are never bumped |
| `restoreArchivedEntry()` | Creates fresh metadata for the restored entry |
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

### Directives

`write_hive_memory` (and `reflect_session`, per-learning) accept a
`directive: true` flag. An agent sets it **only when the user explicitly
directed the save** ("save this", "remember that") — never for its own
judgment-based writes.

A directive is the user's instruction, not an extractor's guess, so the
verifier may not veto it. It still flows through the nightly pipeline so
Pass V can refine its wording or place it well (accept / supersede /
merge), but **a `reject` decision on a directive is overridden** — Pass F
force-admits it to canon regardless. The accept-bar, `cite_unverifiable`,
`trivial`, and `low_signal` simply don't apply to a human instruction.
The verifier prompt is told this; Pass F enforces it as a hard backstop
(`directivesForceAdmitted` in the apply tally records any override). A
directive still reaches canon at the next nightly run, not same-session.

**comb precedents.** comb writes each answer Greg gives on its queue (Go,
Not now, Redirect) through `write_hive_memory` as a `decision` with
`directive: true` and tags `precedent` and `queue` (comb `src/queue.ts`
`syncPrecedent`, comb TK-001). It goes to the queue item's project when
HIVE knows that project, and to `comb` otherwise. Search with
`tag: precedent` to find earlier answers before you ask again.

## V1 Nightly Pipeline

The nightly pipeline at 2am is the only path into `knowledge.md`:

```
Pass A — Conditioning (mechanical, no LLM)
  ↓ read Claude Code transcripts from ~/.claude/projects and Codex transcripts from ~/.codex/sessions
  ↓ resolve each transcript to a registered HIVE project by project path / cwd
  ↓ live runs scan the rolling 24 hours ending at the run clock; explicit --date runs scan that exact UTC day
  ↓ filter each exchange by its record timestamp, so touched long-lived transcripts cannot replay old work
  ↓ rank full exchanges by tokenCount × novelty + always-include markers
  ↓ select within a 16k-token project budget, excerpt long exchanges as 60% head + 40% tail, then restore chronology
  ↓ preserve timestamp, source, and session ID so Pass B can follow corrections and final decisions
  ↓ skip-if-trivial early exit emits a stub briefing

Pass B — Sonnet, per project with signal (parallel)
  ↓ prompt carries a budgeted canon digest (renderCanonDigest: strongest
  ↓   entries first, 220-char lines, 12k tokens, [gap] excluded) — not the
  ↓   full knowledge.md; the verifier owns dedupe against full canon
  ↓ extract decisions, conventions, durable facts, open questions from the selected exchanges and project artifacts
  ↓ each candidate carries a free-text provenance string

Pass C — Sonnet, cross-project (single call)
  ↓ extract reflections about Greg, Maya, the system

Pass V — Opus, one call per project with candidates, then one to brief (serial)
  ↓ per project: that project's canon + its B and candidates.md entries
  ↓   → decisions (accept | supersede(hash) | merge(hash) | reject) + gaps
  ↓ brief: condition report + inboxes + C candidates + a digest of the above
  ↓   → C decisions + cross-project gaps + briefing.md
  ↓ any per-project failure aborts the pass (see "Why V shards")

Pass F — Apply (mechanical)
  ↓ walk decisions: appendProjectMemory / supersedeEntryByHash /
  ↓                 mergeTagsIntoEntry / drop rejected
  ↓                 (directives marked reject are force-admitted, not dropped)
  ↓ drain candidates.md → runs/{DATE}/candidates.consumed.{name}.md
  ↓ rebuild _index.md per project touched
  ↓ land accepted reflections
  ↓ log the verifier's gaps to gaps.applied.log (disposition "briefing") —
  ↓   they stay in the briefing and gaps.md, never canon, reflections, or
  ↓   identity proposals; durable lessons are Pass B/C's to extract next run
  ↓ copy briefing.md → ~/.hive/briefings/{DATE}.md
  ↓ clear each captured project inbox when its body still matches Pass V;
  ↓   identity candidates in it move to ~/.hive/identity-candidates.json first
  ↓ list every pending identity candidate in the briefing

Pass P — Promote reflections
  ↓ "About the System" lines → project knowledge.md
  ↓ "About Maya" / "About Greg" lines → pending identity candidates
  ↓   (identity-candidates.json, target IDENTITY.md / SELF.md); the landed
  ↓   briefing's pending list is rewritten to include them
```

**Identity candidates wait for an answer (TK-157).** The inbox is for
findings the briefing consumes, and the nightly clears it every night. An
identity candidate is a question for Greg, so it lives in
`~/.hive/identity-candidates.json` until he answers it. `hive identity approve
<id>` appends it to IDENTITY.md or SELF.md; `hive identity decline <id>` drops
it. Both answers log to `~/.hive/identity-candidates.log`, and nothing else
removes a candidate. Each night's briefing lists all pending candidates.

**Provenance discipline.** Every candidate carries a provenance string the
verifier checks against the day's signal. If the cited source can't be
found, Opus can reject with reason `cite_unverifiable`. This is the gate
that keeps the system honest — facts in canon trace back to actual
exchanges or commits, not to plausible hallucinations. The one exception
is a directive (see above): the user's explicit instruction is its own
authority, so `cite_unverifiable` and the other reject reasons don't apply.

**Run state is durable.** Each pass writes its artifact to
`~/.hive/memory/runs/{DATE}/` before the next pass consumes. Failures
localize: a Pass B failure on one project doesn't block others; a Pass V
failure cleanly skips F with the upstream artifacts intact for inspection.

**Why V shards.** V used to be one Opus call carrying every project's full
canon. That prompt grew with the canon rather than with the day's work, and on
2026-07-23 it crossed the 200k window — `Prompt is too long · ~222086 tokens`,
a client-side reject that arrives as a zero-token error envelope and looks
exactly like an auth failure. Three nights of canon writes were lost before
anyone replayed the prompt by hand (TK-137). Sharded, each call is bounded by
one project's canon, projects with nothing to decide cost nothing, and
`assertPromptFits` names the overage before the spawn. A shard failure aborts
the whole pass on purpose: Pass F drains a project's `candidates.md` whenever
that project has candidates, decisions or not, so a partial V would drain a
queue nothing decided on.

**V's budget.** The guard's window is Opus 5.5's 1M tokens (TK-164), less 16k
for output. Set `HIVE_VERIFY_WINDOW_TOKENS` when V runs on a model with a
smaller window. The token estimate is chars / 2.6. That is rounded down from the
densest call measured, 2.68 chars/token on 2026-11-23, so it errs high. Pass F
records each project's Verify prompt against this budget, and the briefing warns
at 60% and 80% (TK-158).

**Forgetting (TK-166, all off by default).** Four switches in
`src/lib/forgetting.ts`, from docs/design/2026-11-23-forgetting.md:

| variable | effect |
|---|---|
| `HIVE_VERIFY_SCOPE=neighbors` | Each V shard reads the union of its candidates' BM25 top-20 canon entries (text only), not the whole canon. |
| `HIVE_VERIFY_SHADOW=on` | Full-canon V applies as usual. Then a neighbour-scoped V decides the same candidates and applies nothing. `runs/{DATE}/verify-shadow.{json,md}` compares the two; `hive memory shadow-report --days 7` totals the nights. Its spend is the `VS` row in usage.json. A shadow failure never fails V. The shadow runs before Pass F, so its calls share one wall-clock budget, `HIVE_VERIFY_SHADOW_BUDGET_MS` (default 15 min); a project left when it runs out is recorded as skipped. |
| `HIVE_VERIFY_RETIRE=on` | V may return `retirements[]`: an entry it was shown, a reason (stale, contradicted, trivia), and the candidate or signal id that shows it. Never for disuse. Pass F moves the line to archive.md unless a same-night supersede or merge names it. |
| `HIVE_MEMORY_ARCHIVE_SUPERSEDED=on` | A supersede moves the old line to archive.md instead of striking it through. `hive memory archive-superseded` moves the existing ones. |

`hive memory restore <hash>` moves an archived entry back. `scripts/forgetting-replay.ts`
replays saved nights through the neighbour selector with no model calls.

**Models.** `src/lib/nightly-config.ts` sets each pass's model and effort in
one map: Sonnet 5.5 for B, C, TB, TC and TR, Opus 5.5 for V's shards and the
Brief, Haiku 4.5 for TA. `HIVE_NIGHTLY_MODEL_<PASS>` (e.g. `_VBRIEF`) overrides
one pass; the older `HIVE_EXTRACT_MODEL`, `HIVE_VERIFY_MODEL` and
`HIVE_TASTE_*_MODEL` variables still work. `HIVE_NIGHTLY_EFFORT_<PASS>`
overrides effort.

**Cost.** Per-pass token + USD recorded in `runs/{DATE}/usage.json`, one V row
per model across its calls. `hive memory cost --days 2` prints the last two
runs side by side. `inputTokens` is the full prompt,
`uncachedInputTokens + cacheCreationTokens + cacheReadTokens`, and each part
is kept as its own field. Cost prices each part at the model's own rate in
`src/lib/pricing.ts`.

Prompt caching is off for every nightly call (`DISABLE_PROMPT_CACHING=1` on
the `claude --print` child). Left on, the CLI writes each call's whole prompt
to the 1-hour cache at 2× base input. The nightly's own transcripts for
2026-11-17..20 show a 1.4% read rate: only the ~1k-token system prompt was
read back. No nightly prompt repeats within an hour, and nights are 24 hours
apart, so every write was paid for and never used. `HIVE_NIGHTLY_PROMPT_CACHE=on`
restores the CLI default.

**Taste cadence.** The taste track (TA → TB → TC/TR) runs every
`HIVE_TASTE_EVERY_NIGHTS` nights (default 2), measured from the last run that
finished, not from date parity, so a failed run makes the next night due. A
run covers each project's sessions back to the last run that analyzed it
(at most 7 days), and targets every project with signal on any night in that
span. A skipped night logs `taste skipped (next run …)` and adds a Taste note
to the briefing. `--taste-now` runs it regardless.

**Restartability.** Each `run*` function deletes its target artifact at
the start of an attempt. Failure leaves absence (correct); success writes
fresh.

**Resume.** `runs/{DATE}/resume.json` records each pass as it finishes. A
retry of the same date (the morning firings after a failed 2am run) skips a
pass only when the manifest records it AND its artifact exists. A file on
disk alone is never trusted. Once F has applied, the whole fact track is done
for the date: a retry never applies canon twice, and a B project that failed
in that run is named in the log rather than retried. V re-runs whenever B or
C produced new output in the retry. Taste resumes per project. `--force`
re-runs everything; dry-runs neither read nor write the manifest.

## Taste Lifecycle

Taste units live in category stores: `~/.hive/memory/taste/` for general
taste and `~/.hive/memory/projects/<name>/taste/` per project. The nightly
taste track runs per project: TA flags moments in the day's transcripts,
TB analyzes them into candidate units, and TC (`taste-consolidate.ts`)
gates the candidates and writes the store. `hive memory nightly --no-taste` skips
the track.

```
candidate ──► holding ──(gate passes)──► active      retrieved by search_taste
                 │
                 └──(gate passes, contradicts a principle)──► pending ──► human
```

- **holding.** Below the gate. Never retrieved. Recurrence accumulates
  across nights here; decay sinks units that never recur.
- **The gate.** A unit passes when its recurrence (distinct sessions,
  counted across nights) reaches 2, or when the coherence call judges
  that Greg endorsed the rule outright. A FUZZY-tier unit must also pass
  replay against the last 90 days of transcripts. If replay cannot
  decide, the unit holds.
- **active.** Passing units admit themselves. There is no human gate on
  instances: the old gate admitted nothing in 22 nights. A wrong unit
  costs one retrieval slot it must still win on BM25. An active unit is
  never demoted by a later run.
- **pending.** Means one thing: the unit passed the gate but its
  coherence came back `contradicts`, so it disagrees with a principle
  already injected into every session. A person decides which side is
  wrong.

**Ladders.** The coherence call links each unit to a principle with
`ladders_up_to`. The value must be a heading copied exactly from
`principles.md` — a closed enum the validator enforces. A heading the
model invents is not kept as a link; it moves to `wanted_principle` and
the unit becomes `uncovered`. Repeated `wanted_principle` values are the
evidence for a new principle.

**Operator commands** (`hive taste --help`):

| Command | Does |
| --- | --- |
| `hive taste status [--since D] [--json]` | Counts active, pending, holding; `--since` lists units admitted since D |
| `hive taste review` | Walks the pending (contradiction) queue, one keypress per unit |
| `hive taste reject <ref>` | Removes the unit and blacklists its key so it is not proposed again |
| `hive taste admit <ref>` | Sets one unit to active by hand |
| `hive taste admit --all-pending [--apply]` | Migration for units the old human gate stranded in pending; dry run without `--apply` |
| `hive taste relink [--apply]` | Clears ladder links that name no current heading; run after editing `principles.md`; dry run without `--apply` |

`<ref>` is a unit's hash or `dedupe_key`.

**Weekly reminder.** `hive init` installs
`com.hive.taste-review.plist`, which runs
`~/.hive/scripts/taste-review.sh` on Sundays at 19:00. The script calls
`hive taste status --json --since <7 days ago>` and sends a notification
only when units wait in pending. Otherwise it writes a log line and
exits.

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

- **Linguistic stemming / NLP**: `stem()` is a dozen suffix rules
  aimed at convergence. Porter or lemmatization would add complexity
  for little gain at this corpus size.
