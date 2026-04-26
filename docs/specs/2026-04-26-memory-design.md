# Memory System — Design

**Status:** Draft (architecture locked; V1 task list defined)
**Date:** 2026-04-26
**Author:** Maya (with Greg)
**Ticket:** TK-067

## Summary

A redesign of HIVE's memory production pipeline, organised around the
four pillars Greg named: **storage, availability, decay, production.**
Three are solid; production is one generic LLM pass doing all the heavy
lifting and earns the work.

The thesis:

- **Storage** works. Leave it alone.
- **Availability** has one real bug — auto-loaded entries never get
  retrieval-strengthened — and one ergonomic gap (weak prompting toward
  the memory tools). Both fixable cheaply.
- **Decay** math is fine. An archival tier closes the back-end gap
  in V2.
- **Production** is the work. Replace the single-agent nightly with a
  3-LLM-call pipeline: two Sonnet extractors (project facts,
  self-reflections), one Opus verifier-and-briefer that absorbs the
  critic, gap-finder, taste reading, and morning briefing.

Mid-session memory writes get redirected from `knowledge.md` to a
per-project `candidates.md` queue. The Opus pass admits or rejects
candidates the same way it handles fresh extraction — nothing reaches
canon without nightly verification.

The taste system collapses to one artifact: `~/.hive/taste/principles.md`
in the prefix. No applications, no evidence dir, no pending file, no
domain hint. Opus reads principles as a lens during verify and writes
taste observations into the briefing directly.

The success metric: **a morning briefing that reads like someone
actually understood yesterday and tells me what matters today.**
Generic, restated, or duplicate entries are a failure even if true.

## Motivation

The four pillars are related but not equal. Knowing this changes where
investment goes.

### Pillar 1 — Storage (solved)

Three layers (`log/` raw → `knowledge.md` compiled → `_index.md`
summary), metadata sidecar (`_meta.json`), hash-stable entry identity
(`src/lib/memory.ts:187`), serialised write queue per file. Supersede
semantics work (`src/lib/memory.ts:543-602`). BM25 ranking with standard
parameters. No structural changes in V1.

### Pillar 2 — Availability (one real bug, one ergonomic gap)

Auto-load via `buildCanonicalIdentity` (`src/lib/identity.ts:67-77`).
MCP path: four memory tools (`read_hive_memory`, `write_hive_memory`,
`search_memory`, `reflect_session`).

**The bug:** `searchMemory()` is the *only* call path that bumps
`recallCount` (`src/lib/memory.ts:960-971`). Entries auto-loaded into
every session via `_index.md` are read but never searched, so they
strengthen at zero. The retrieval-strengthening loop only fires for
entries the agent reaches for *after* not finding them in the index —
exactly backwards. Entries earning their place in the index should
strengthen *fastest*.

**The ergonomic gap:** `REFLECTION_PROTOCOL` (`src/lib/identity.ts:12-22`)
is short, soft, and lives mid-stack. Tool descriptions say "use
proactively" but give no trigger conditions. The model often forgets to
reach for memory tools under Opus 4.7's terseness pressure.

### Pillar 3 — Decay (good math, V2 back-end)

Strength formula `0.5^(age/halfLife) * (1 + log2(recallCount + 1))`
is correct. Half-life starts at 30 days, +7 per recall, capped at 90.
Decay affects ranking only — entries are never deleted.

Archival tier (V2) closes the back-end gap. V1 doesn't touch the math
or the file shape.

### Pillar 4 — Production (the actual work)

The current nightly pipeline (`templates/scripts/nightly.sh`,
`templates/agents/maya-nightly.md`):

1. `hive memory promote` — promotes prior-day reflections.
2. `hive memory extract-sessions` — condenses 24h of JSONL
   (50KB hard cap, by recency).
3. `hive --agent maya-nightly` — single agent, ≤40 turns, generic
   "be conservative" prompt. Calls `reflect_session`, writes
   reflections file, daily notes, commits.

The agent prompt is one page. Quality bar: "be conservative." That's
the entire verifier. There is no taste-awareness, no citation
requirement, no critic pass, no structured de-dup, no coverage signal,
and a 50KB cap that hard-truncates by recency rather than signal.

This pillar is the work.

## Non-Goals

- **Not switching off file-native storage.** Markdown + git remains the
  substrate. No SQLite, no embeddings, no vector store at this scale.
- **Not introducing in-session auto-extraction.** Nightly batch is the
  canonical path. Mid-session `write_hive_memory` calls remain
  available but route to a candidates queue, not directly to canon.
- **Not building automated `knowledge.md` pruning.** Archival (V2) is
  automated. Deletion stays human-curated.
- **Not adding embeddings to the strength model.** Negative
  reinforcement is speculative; defer.
- **Not redesigning the identity stack emission order.** Memory
  injection stays at position 2. Taste's ordering decision stands.
- **Not running a parallel maya-nightly during V1 production.** V1
  ships via dry-run for 3-5 days; once flipped, V0 dies.

## Design

### Pillar 1 — Storage: no V1 changes

The schema, hashing, supersede semantics, write queue, and BM25
ranking are all correct. No work in V1.

(The `examples` entry type from earlier drafts is dropped. If concrete
demonstrations earn a slot later, fact bodies can carry excerpts.)

### Pillar 2 — Availability: two changes

**Change 2A: auto-load strengthens (damped).**

When `_index.md` is rebuilt, bump recall metadata for every entry
appearing in it. Damped to keep the bump from drowning out genuine
retrieval:

- Auto-load bump: `recallCount += 0.25`, `halfLife += 1` (cap 90)
- Search bump (unchanged): `recallCount += 1`, `halfLife += 7` (cap 90)

`recallCount` becomes a fractional float; the strength formula handles
it cleanly.

Implementation: in `rebuildIndex()` (`src/lib/memory.ts:725`), after
`budgetSlice` selects which entries land in the index, write a damped
recall bump for each one before serialising the file.

This change closes a gap in the Hippo-inspired retrieval-strengthening
loop. The current implementation strengthens entries on `searchMemory`
but not on auto-load — exactly the entries earning their place in the
prefix go un-reinforced. Change 2A is the Hippo principle applied where
it was missing.

**Change 2B: stronger memory-use directive.**

The `REFLECTION_PROTOCOL` block moves out of `identity.ts` into
`OVERRIDES.md` (last-position weight) and rewrites with concrete
trigger conditions:

```
## Memory tools — reach for these
HIVE memory is a first-class tool, not a backstop. Trigger conditions:

- BEFORE making a recommendation in a domain you've worked in →
  search_memory for prior decisions and conventions.
- BEFORE proposing a pattern → search_memory for existing convention.
- WHEN you learn something durable in this session → write_hive_memory
  immediately. Don't batch to end-of-session.
- AT END of any substantive session → reflect_session for the
  durable items.

Mid-session write_hive_memory and reflect_session calls queue to a
candidates file. Nothing lands in canon until the nightly verifier
admits it. Reach for the tools freely; the night is the gatekeeper.

If you find yourself reasoning from training-data plausibility rather
than checking, search first.
```

Tool description rewrite (`src/mcp-server.ts`): each description
leads with *when to call*, not *what it does*. Includes the
candidates-queue note so the model understands writes don't immediately
ratify.

### Pillar 3 — Decay: no V1 changes (V2: archival tier)

V1 doesn't touch decay math or file structure. V2 adds `_archive.md`
alongside `knowledge.md`; entries move when strength stays <0.1 for
30 consecutive days. Mechanical, no LLM.

### Pillar 4 — Production: the new pipeline

Three LLM calls + four mechanical steps. Each mechanical step is a few
lines of shell or TypeScript; the LLM passes carry the judgment.

#### Pipeline shape

```
2am
 ↓
A) Condition (mechanical)
   - rank exchanges by signal across all projects
   - skip-if-trivial early exit
   ↓
B) Project extract (Sonnet, parallel per project) → candidates.json
   - extracts decisions, conventions, durable facts, open questions
   - each candidate carries a free-text provenance field
C) Self-reflection extract (Sonnet, single call)  → reflections.json
   - extracts observations about Greg, Maya, the system
   - each observation carries provenance
   ↓
V) Verify (Opus, one call) — reads:
   - day's session digest
   - B + C candidates with provenance
   - per-project candidates.md (mid-session writes)
   - existing memory per project (knowledge.md)
   - principles.md (taste lens)
   - heartbeat inbox.md per project
   produces:
   - per candidate: accept | supersede(hash) | merge(hash) | reject(reason)
   - gap report ("you missed X from session Y")
   - taste readout (reinforcement, notable corrections)
   - morning briefing (single user-facing markdown)
   ↓
F) Apply (mechanical)
   - write accepted entries via appendProjectMemory
   - apply supersedes via supersedeEntry
   - rebuild index per project touched
   - truncate per-project inbox.md (heartbeat findings now folded)
   ↓
D) Dashboard rebuild (mechanical, Tier 2)
   - render today's briefing
   - regenerate cross-cutting widgets (open questions, open tickets,
     recent memory)
   - sidebar archive prepends today
   ↓
H) Commit + push
```

Run state lives in `~/.hive/memory/runs/{DATE}/` for restartability and
post-mortems. Pass-level wall-clock budgets; the run as a whole stays
capped by `nightly.sh`'s timeout.

#### Pass A — Conditioning (mechanical)

Build a structured signal report:
- Sessions touched per project, with token counts and exchange counts
- Git activity per project (commits + diffstats)
- Tickets that moved
- Heartbeat findings since last briefing

**Light-day handling.** When the day is trivially empty (no commits, no
sessions over 5 minutes, no ticket activity), Pass A still emits a
minimal briefing stub — single section, one line ("Today was quiet —
N commits, no tickets moved, no substantive sessions") — and skips
Passes B/C/V. The dashboard contract stays clean (always a fresh
briefing daily); no LLM cost on light days.

The 50KB-by-recency session cap dies here. New `rankExchanges()`
function in `src/lib/sessions.ts` ranks exchanges by:
1. Token count (longer = more substance, generally)
2. Novelty against existing memory (BM25 distance from `knowledge.md`)
3. User-explicit markers ("save this", "remember", "write this down")
   always included regardless of length

V1 ranking is deliberately simple — token count × novelty score, plus
always-include markers. Tune from V1 telemetry.

#### Pass B — Project learning extraction (Sonnet)

Per project with activity, run a focused extraction:

- **Input:** the conditioning report's session extract for this project,
  the project's current `knowledge.md` (for dedup awareness), the day's
  git activity.
- **Prompt:** explicit list of what to extract (decisions with rationale,
  conventions established, durable facts, open questions) and what to
  skip (task status, in-progress work, anything already in
  `knowledge.md`).
- **Output:** structured JSON, one entry per fact.

Each entry has a `provenance` field: free-text reference to the source
(e.g. `"session:abc12345 — Greg said 'we should X because Y'"`). Sonnet
fills it; Opus judges plausibility during verify.

#### Pass C — Self-reflection extraction (Sonnet)

Same shape as Pass B, single call across all projects:

- **Input:** full-day session digest.
- **Prompt:** extract observations about (1) Greg's communication and
  work patterns, (2) Maya's tool habits, verbosity, friction points,
  (3) HIVE system patterns working or not.
- **Output:** structured JSON; each observation carries provenance.

**Canon channel:** reflections are *not* per-project. They live at
`~/.hive/reflections/YYYY-MM-DD.md` (cross-project, identity-level —
about Greg, Maya, the system). Pass V treats this file as a separate
canon channel from per-project `knowledge.md`. The existing
`promoteReflections` flow (which feeds SELF.md/IDENTITY.md proposals
to inboxes) keeps working — it just runs *after* Pass C / V instead
of *before* the day's extraction. Mixing self-reflections into project
facts dilutes both corpora.

#### Pass V — Verify, gap-find, taste-read, brief (Opus)

This is the synthesis pass. One Opus call, multi-section structured
output. Inputs:

- Conditioning report (Pass A)
- Sonnet candidates from B + C
- Per-project `candidates.md` (mid-session writes from the day)
- Per-project `knowledge.md` (current canon)
- Per-project `inbox.md` (heartbeat findings)
- `~/.hive/taste/principles.md`

**Output schema.** Single structured JSON object with these top-level
fields:

```
{
  "decisions": [ { candidate_id, action, target_hash?, reason? }, ... ],
  "gaps":      [ { project, description, suggested_entry } , ... ],
  "taste":     { reinforced: [...], corrections: [...] },
  "reflections": [ { decision: accept|reject, text, provenance } , ... ],
  "briefing_markdown": "# HIVE — YYYY-MM-DD\n\n..."
}
```

What each field carries:

1. **`decisions`** — one per Sonnet/in-session candidate:
   `accept` | `supersede(hash)` | `merge(hash)` | `reject(reason)`.
   Citation plausibility judged here — if Sonnet's quoted excerpt
   doesn't appear in any source, reject with
   `reason: "citation_unverifiable"`.
2. **`gaps`** — things Opus thinks should have been extracted but
   weren't. Surfaced to the briefing's verifier-flags section AND
   landed in canon as `question`-type entries in the relevant
   project. Tracking, not one-shot — if a gap stays unresolved, the
   open-questions widget surfaces it tomorrow.
3. **`taste`** — which principles the day reinforced (with quoted
   exchange) and any notable corrections. Lands in the briefing.
4. **`reflections`** — admit/reject decisions for Pass C candidates,
   with the text + provenance to write to
   `~/.hive/reflections/YYYY-MM-DD.md` for accepted ones.
5. **`briefing_markdown`** — the prose briefing as a single string
   field on the JSON. *Not* assembled mechanically from the other
   fields. Opus writes it directly, cross-referencing across decisions,
   gaps, taste, reflections inside the prose. This preserves the
   one-call rationale: synthesis lives in the prose, not in a
   post-call assembly step.

Why one Opus call instead of three:
- Inputs are the same for all four jobs. Three calls re-read the same
  context. One call lets Opus cross-reference (a candidate from B and a
  taste violation can refer to the same exchange).
- Opus is strong enough to handle multi-section structured output.
- Cost: one Opus call vs three is meaningful at scale.

#### Briefing format

Single user-facing markdown file, written to
`~/.hive/briefings/YYYY-MM-DD.md`:

```
# HIVE — YYYY-MM-DD

## Headline
<1-2 sentences. What mattered most overnight.>

## Per project
### project-name
- What shipped / decisions / open threads (~5 bullets)
- Heartbeat findings since last briefing (folded from inbox.md)
- Tickets that moved

## What needs your attention
- Highest-priority unresolved across projects, ranked

## Memory + verifier
- Added: N entries (sampled). Superseded: N. Reflections: N.
- Taste readout: reinforced <principle> · notable correction <pattern>
- Verifier flags: gaps Opus saw, citations that didn't anchor
```

Three real sections (Headline / Per project / Attention) plus a thin
Memory + verifier footer. ~1 page. The dashboard renders this and
adds cross-cutting widgets (Tier 2).

#### Pass F — Apply (mechanical)

Walks Opus's per-candidate decisions:
- `accept` → `appendProjectMemory()` (or write to
  `~/.hive/reflections/YYYY-MM-DD.md` for reflection-channel entries)
- `supersede(hash)` → `supersedeEntry()`
- `merge(hash)` → append tags to existing entry, drop the candidate
- `reject(reason)` → log to run dir, drop
- `gaps` → write each as a `question`-type entry to the relevant
  project's canon

Then drain the working files:
- **`candidates.md` per project** → drain to
  `runs/{DATE}/candidates.consumed.md` (audit trail) and truncate the
  live file. Same atomicity as inbox truncation: only after all
  decisions for that project have been applied.
- **`inbox.md` per project** → truncate (heartbeat findings now in the
  briefing).

Rebuilds `_index.md` per project touched. Atomic per project; partial
failures don't corrupt other projects.

#### Pass D — Dashboard rebuild (mechanical, Tier 2)

After Opus produces the briefing:
- Render today's briefing as HTML (top of page)
- Regenerate four cross-cutting widgets:
  - **Open questions** — aggregated across all projects
  - **Open tickets** — by priority, across all projects
  - **Recent memory** — last 7 days, all projects, ranked by strength
  - **Since briefing (Nh ago)** — fresh content from per-project
    `inbox.md` files since the last briefing wrote. Closes the
    2am→read-time freshness gap maya-morning used to fill at 7am.
    Recomputed at every dashboard view, not just at nightly rebuild.
- Prepend today's briefing to the archive sidebar

Lives in `src/lib/dashboard/` (already exists for V0). Render logic
adapts to the new briefing format. Per-project status cards and the
inbox panel come out — that content is in the briefing.

#### Pass H — Commit + push

`~/.hive` git commit + push, as today.

#### Why multi-pass beats single-agent

- **Each pass has one prompt, one output schema.** Generic agent prompt
  asked one model to filter, extract, reflect, dedup, and write.
- **Citations become enforceable.** A schema-bound JSON output with a
  required provenance field beats prose where evidence is optional.
- **Opus is the real verifier.** First-draft-is-final was the bug.
- **Failures localise.** Each pass writes to the run dir; a failed
  pass doesn't kill the others.

#### Cost budget

Back-of-envelope per nightly run with 4-5 active projects:

| Pass | Model | Input tokens | Output tokens | Cost |
|---|---|---|---|---|
| B (per project × ~4) | Sonnet | ~30K each | ~3K each | ~$0.40 |
| C (single call) | Sonnet | ~50K | ~5K | ~$0.20 |
| V (single call) | Opus 4.7 | ~65K | ~10K | ~$1.75 |
| **Total** | | | | **~$2.35/night** |

Opus inputs include conditioning report (~5K), B+C candidates (~17K),
per-project candidates.md (~4K), per-project knowledge.md (~20K),
per-project inbox.md (~8K), principles.md (~1.5K), soul stack +
overrides (~10K).

**Monthly target: ~$70.** Up to ~$100 acceptable as projects mature
and `knowledge.md` files grow. **Hard guardrail: stop and re-evaluate
if monthly cost exceeds $150.** Same precedent as the heartbeat
incident ($130/48h was the symptom that made cost-monitoring a
heartbeat check; same discipline applies here).

Light days (Pass A skip-if-trivial) cost only the conditioning step
(no LLM). Roughly 30% of days expected to be light, lowering the real
average.

### Mid-session memory writes

Today, `write_hive_memory` and `reflect_session` write directly to
`knowledge.md`. V1 redirects them:

- `write_hive_memory` → appends to
  `~/.hive/memory/projects/<name>/candidates.md`
- `reflect_session` → batch-appends to the same file
- `knowledge.md` is only ever written by Pass F

Candidates carry the same `provenance` field as Sonnet-extracted
entries. **Provenance is auto-attached at the candidates layer**, not
required as a tool parameter. Agents don't see the provenance contract;
they call `write_hive_memory(content, type, tags)` as before, and the
candidates writer auto-attaches:

```
provenance: "session:<id> — agent-write at HH:MM"
```

The MCP tool gains an optional `provenance_note` parameter for the
"Greg said save this" case where the agent wants to enrich the
auto-attachment. Tool descriptions document this — calls queue, don't
ratify, and provenance lands automatically.

Opus reads `candidates.md` during verify and treats each entry the
same as a Sonnet candidate. The auto-attached `session:<id>` gives
Opus enough to grep the day's session digest for plausibility, same
as Sonnet citations.

### What dies

Explicit kill list. All deletions land in V1 unless noted.

**Files / templates:**
- `templates/agents/maya-nightly.md`
- `templates/agents/maya-morning.md`
- `templates/launchd/com.hive.morning.plist`
- `templates/scripts/morning.sh`
- `~/.hive/taste/applications/` (entire directory)
- `~/.hive/taste/exemplars/` (entire directory)
- `~/.hive/taste/source-material.md`
- `~/.hive/taste/pending.md`
- `~/.hive/taste/evidence/` (proposed in earlier drafts; never built)

**Code:**
- `--taste <domain>` flag and parsing in `src/cli.ts`
- `buildTasteLayer`'s domain-hint logic — collapses to load-or-skip
- The OVERRIDES "Taste — domain applications" section
- `src/lib/dashboard/` per-project status cards, inbox panel
- The 50KB-by-recency session cap in `extractDailySessions`

**Behaviour:**
- 7am morning cron job
- Direct write from MCP tools to `knowledge.md`
- Single-agent extraction loop

## V1 task list — dependency-ordered

The right things to do first. Numbered items can be tested standalone.
Items in the same numbered group are independent and can ship in any
order.

### Group 1 — Foundations (independent, ship anytime)

1.1 **Auto-load strengthening fix.** Modify `rebuildIndex()` in
   `src/lib/memory.ts:725` to bump damped recall metadata for entries
   selected into `_index.md`. ~15 LOC. New unit tests in
   `bm25.test.ts` for fractional `recallCount`.

1.2 **OVERRIDES.md memory-use directive.** Edit
   `~/.hive/OVERRIDES.md`: add the trigger-conditions block.
   Pure markdown. Note the candidates-queue behavior even though
   the queue itself ships in Group 3.

1.3 **MCP tool description rewrites.** `src/mcp-server.ts`. Six
   description strings rewrite to lead with *when to call*. No logic
   change. Update tests if any assert string content.

### Group 2 — Pass A (mechanical)

2.1 **`rankExchanges()` in `src/lib/sessions.ts`.** Token count ×
   novelty (BM25 distance from `knowledge.md`) + always-include for
   user-explicit markers. Drop the 50KB-by-recency cap. Unit tests
   on a synthetic session corpus.

2.2 **`hive memory condition` CLI.** Builds the structured signal
   report — sessions, git, tickets, heartbeat. Outputs JSON to
   `runs/{DATE}/condition.json`. Skip-if-trivial early exit.

### Group 3 — Mid-session redirect (independent of Pass B/C)

3.1 **Candidates file infrastructure.** New
   `~/.hive/memory/projects/<name>/candidates.md` shape. Append
   functions in `src/lib/memory.ts`. Schema for provenance.
   Auto-attach provenance string at write time:
   `"session:<id> — agent-write at HH:MM"`.

3.2 **Redirect `write_hive_memory` to candidates.** `src/mcp-server.ts`.
   Tool keeps its existing signature; gains an optional
   `provenance_note` parameter for enrichment (the "Greg said save
   this" case). Existing tests update to assert candidates-file writes
   and auto-attached provenance.

3.3 **Redirect `reflect_session` to candidates.** Same change. Same
   tests. Reflection candidates flow through Pass C / V the same way.

### Group 4 — Sonnet extractors (depend on Group 2)

4.1 **`hive memory extract-project <name>` CLI (Pass B).** One Sonnet
   call per project. Reads conditioning output for the project,
   current knowledge.md, git activity. Outputs structured JSON
   candidates with provenance to `runs/{DATE}/candidates.B.{name}.json`.
   Prompt iteration is the bulk of the work.

4.2 **`hive memory extract-reflections` CLI (Pass C).** One Sonnet
   call across all projects. Outputs to
   `runs/{DATE}/candidates.C.json`.

### Group 5 — Opus verify (depends on Groups 3 + 4)

5.1 **`hive memory verify` CLI (Pass V).** The big one. Loads
   conditioning report, B+C candidates, per-project candidates.md
   files, per-project knowledge.md files, per-project inbox.md files,
   principles.md. Single Opus call returning a single JSON object
   with the schema from Pass V's design section: `decisions`, `gaps`,
   `taste`, `reflections`, `briefing_markdown`.

   Outputs (extracted from the JSON, written to run dir):
   - `runs/{DATE}/verify.json` — the raw structured response
   - `runs/{DATE}/decisions.json` — extracted decisions array
   - `runs/{DATE}/gaps.json` — extracted gaps array (each gets a
     `question`-type entry written by Pass F)
   - `runs/{DATE}/briefing.md` — the `briefing_markdown` field

   The Opus prompt is the second-biggest piece of work after Group 4.1.
   Iterate against dry-run output. Critical to enforce JSON schema —
   schema violations should fail loudly rather than silently degrade.

### Group 6 — Apply + briefing (depends on Group 5)

6.1 **`hive memory apply` CLI (Pass F).** Walks `decisions.json` +
   `gaps.json`, applies via existing `appendProjectMemory` /
   `supersedeEntry`. Gaps land as `question`-type entries in the
   relevant project. Reflection-channel accepts go to
   `~/.hive/reflections/YYYY-MM-DD.md`. Then drains
   `candidates.md` per project (move to
   `runs/{DATE}/candidates.consumed.md`, truncate live), truncates
   `inbox.md` per project, rebuilds `_index.md`. Tag pre-V1 entries
   with `provenance: pre-v1` on first read (lazy backfill).

6.2 **Briefing landing.** Copy `runs/{DATE}/briefing.md` to
   `~/.hive/briefings/YYYY-MM-DD.md`. One line of code. (Light-day
   stub also lands here — Pass A writes a minimal briefing when
   passes B/C/V are skipped.)

### Group 7 — Dashboard Tier 2 (depends on Group 6)

7.1 **Briefing render** in `src/lib/dashboard/`. Update render logic
   to consume the new briefing markdown. Per-project status cards and
   inbox panel come out.

7.2 **Cross-cutting widgets**: open questions, open tickets, recent
   memory, *plus* "Since briefing (Nh ago)" pulling fresh inbox.md
   content. Four widgets total. New collectors in
   `src/lib/dashboard/collect.ts`. The freshness widget reads
   per-project inbox.md at view time, not nightly rebuild time, so it
   stays current as heartbeat writes throughout the day.

7.3 **Archive sidebar** prepend.

### Group 8 — Orchestration + dry-run mode

8.1 **`hive memory nightly` orchestrator.** Wraps Groups 2-7 in
   sequence with proper failure handling. Each pass independently
   restartable from `runs/{DATE}/` artifacts.

8.2 **Dry-run mode.** `--dry-run` flag on the orchestrator. Runs
   Passes A-V, writes everything to `runs/{DATE}/`, but skips Pass F
   apply and Pass H commit. The dashboard rebuild also skipped — V0
   keeps owning the live artifacts.

8.3 **`nightly.sh` rewrite.** Replace the three-step script with a
   call to `hive memory nightly`. Pass `--dry-run` for the 3-5 day
   shakedown. Remove `morning.sh` and the `com.hive.morning.plist`
   launchd entry.

### Group 9 — Cleanup (after dry-run flip)

9.1 Delete `templates/agents/maya-nightly.md`.
9.2 Delete `templates/agents/maya-morning.md`.
9.3 Delete `templates/scripts/morning.sh`.
9.4 Delete `templates/launchd/com.hive.morning.plist`.
9.5 Delete taste reductions: `applications/`, `exemplars/`,
    `source-material.md`, `pending.md`. Update
    `docs/specs/2026-04-26-taste-design.md` to reflect collapsed scope.
9.6 Strip `--taste <domain>` flag and OVERRIDES domain-applications
    section.

### Estimated time

| Group | Work | Est. |
|---|---|---|
| 1 | Auto-load fix + OVERRIDES + tool descs | ~half day |
| 2 | Pass A: ranking + condition CLI | ~1 day |
| 3 | Mid-session redirect | ~half day |
| 4 | Sonnet B + C with prompt iteration | ~2 days |
| 5 | Opus verify with prompt iteration | ~2 days |
| 6 | Apply + briefing landing | ~half day |
| 7 | Dashboard Tier 2 update | ~1 day |
| 8 | Orchestrator + dry-run | ~1 day |
| 9 | Cleanup (after flip) | ~half day |

**Total: ~9 working days** for V1 implementation, plus 3-5 days of
dry-run before flip.

Groups 1, 2, 3, and 9 are independent of the LLM passes and can land
ahead of the prompt-iteration work. Groups 4 and 5 are the real
investment — prompt quality determines V1 quality.

## Phasing

### V1 (target: ~9 working days + 3-5 day dry-run)

The full task list above. Ships via dry-run; flips to canonical when
output reads clearly better than V0 on a subjective read.

### V2 (target: ~1 week after V1 settles)

- **Archival tier.** `_archive.md` alongside `knowledge.md`; entries
  move when strength <0.1 for 30 consecutive days. Mechanical sweep
  in the nightly orchestrator. `searchMemory` gains
  `--include-archive`.
- **Briefing tone iteration.** A week of V1 briefings will reveal
  what the format wants — sections to drop, things to surface.

### V3 (speculative)

- **Cross-project memory promotion.** Facts learned in one project
  that apply to another. Out of scope for now.
- **Negative reinforcement.** Weakening entries the agent retrieves
  but doesn't use. Defer until "over-retrieval" is an observed
  problem.

## Decisions log

The major calls made across the design pass (this doc, 2026-04-26):

### Pipeline shape
**Three LLM calls plus mechanical glue.** Compressed from an earlier
8-pass shape after Greg pushed back ("feels like a lot"). The earlier
critic pass (Haiku) collapses into Opus's verify call. Archival moves
to V2.

### Models
**Sonnet for extraction (B, C), Opus for verify (V). No Haiku.**
Greg: "Haiku is too low-brow for this." Verifier work is judgment,
which is where Opus earns its rate. Sonnet handles focused extraction
cheaply.

### Citation enforcement
**Free-text `provenance` field, Opus judges plausibility.** Earlier
draft proposed structured `source` + `excerpt` for mechanical grep
validation. Greg: "big fan of lighter weight." Trade mechanical-check
for trust in Opus, which is consistent with the rest of the pipeline.

### Pre-V1 entry handling
**Tag-and-accept.** Existing `knowledge.md` entries get
`provenance: pre-v1` lazily on first read. No backfill, no expensive
hallucination risk.

### Mid-session memory writes
**Queue to `candidates.md`, Opus admits at nightly.** MCP tool stays
available; just changes destination. Honors "in-session is for jamming,
nightly is for ratifying."

### Taste system reduction
**`principles.md` only.** Drop `applications/`, `evidence/`,
`exemplars/`, `pending.md`, `source-material.md`, the V1 mining flow,
the `--taste <domain>` flag, the OVERRIDES domain-applications
directive. Opus reads principles in its prefix and folds taste
observations into the briefing directly.

**Accepted capability loss:** the per-domain prose-time hook
(OVERRIDES "before drafting prose, read applications/prose.md")
disappears with the directory. Greg's framing: "I'm a bit skeptical
of the rest" of taste, "simpler feels better." Per-domain depth is
intentional reduction, not accidental. If a specific domain (prose,
code review, architecture) turns out to need depth that principles.md
alone can't carry, the right move is to grow `principles.md` an
inline section ("When drafting prose: ...") rather than restoring the
applications directory. Decided once here so it's not relitigated.

### Briefing
**One user-facing file, daily, at 2am.** Folds heartbeat inbox content
and truncates the inbox after. "The briefing is a user-facing idea —
it's all about me." Three sections (Headline / Per project /
Attention) + a memory+verifier footer.

### Morning agent
**Deleted.** `maya-morning.md`, `morning.sh`, and the 7am cron go.
Opus's 2am pass produces the briefing. Heartbeat (every 30min) catches
anything that arrives after 2am.

### Dashboard
**Tier 2: briefing renderer + archive + 3 cross-cutting widgets.**
Per-project status cards and inbox panel come out (now in the
briefing). Cross-cutting widgets (open questions, open tickets, recent
memory) earn their slot — they show what the briefing can't (across-
portfolio aggregation).

### Rollout
**Dry-run for 3-5 days, then flip on subjective read.** Dry-run writes
to `runs/{DATE}/` only; V0 keeps owning canon during the shakedown.
Flip when V1 outputs read clearly better.

### What was killed
- The 8-pass structure (compressed to 3 LLM calls + mechanical).
- Haiku critic (folded into Opus).
- Archival in V1 (moved to V2).
- Examples entry type (dropped; if needed, fact bodies carry excerpts).
- Per-project briefing files (briefing is one user-facing file).
- Embeddings / vector retrieval (unchanged from prior decision).
- Negative reinforcement (V3 if ever).

## Open questions

- **Damping coefficient.** Auto-load bump of `+0.25 / +1` is a guess.
  After a month of V1 telemetry we'll know whether index-loaded
  entries outpace search-loaded ones at the right rate.
- **Opus citation false-rejection rate.** Opus rejecting valid
  citations as `unverifiable` would silently lose signal during
  dry-run. Sample-and-review during the dry week.
- **Pass A ranking heuristic.** V1 uses token count × novelty + always-
  include markers. Honest: it's a guess. Dry-run will surface whether
  high-value exchanges get truncated.
- **Briefing length drift.** "~1 page" is a target; in practice
  briefings will lengthen as projects multiply. Decide a soft cap
  after a week of real output.
- **Cross-project memory.** Out of scope for V1; flag as V3 if any
  fact-bleed across projects happens during dry-run.

## References

- TK-063 (HIVE) — taste design ticket; this doc supersedes the V1
  mining flow there.
- `docs/specs/2026-04-26-taste-design.md` — taste system design;
  becomes substantially smaller after the principles-only reduction.
- `docs/memory-architecture.md` — current-state authoritative
  reference for storage / decay / search.
- `src/lib/memory.ts:187` — `entryHash`.
- `src/lib/memory.ts:725` — `rebuildIndex` (Change 2A site).
- `src/lib/memory.ts:861` — `searchMemory` (current sole retrieval-
  strengthening path).
- `src/lib/identity.ts:53-108` — `buildCanonicalIdentity`.
- `src/lib/sessions.ts` — session extraction; Pass A rewrites
  `rankExchanges` here.
- `src/lib/reflections.ts:177-252` — `promoteReflections`.
- `templates/scripts/nightly.sh` — current pipeline; rewritten.
- Hippo memory model — biological decay reference; V1's Change 2A
  closes the auto-load gap in the retrieval-strengthening loop.
