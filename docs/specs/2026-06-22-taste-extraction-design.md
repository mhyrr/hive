# Taste Extraction & the Judgment Memory Layer — Design

**Status:** Design. Not yet built. Supersedes the "V1 — unbuilt" mining sketch in `2026-04-26-taste-design.md` §Phasing.
**Date:** 2026-06-22
**Author:** Maya (with Greg)
**Aiming doc:** `PLANNING-taste-extraction-and-memory.md` (read it first; this design resolves its §6 open questions).
**Research:** `taste-memory-structures-research-2026-06.md`, `frontier-agentic-research-2026-06.md`.

---

## 0. What this design is, and what it is not

The planning doc settled the *thesis* and the *decided directions* (don't
re-litigate §4). This document turns those into something an implementer can
build, with the depth front-loaded where the planning doc told us to start:
**Pass A (Flag) and Pass B (Analyze), run over real transcripts**, so we can
look at the candidate rules they emit and judge whether the
mine-corrections-from-sessions premise actually holds (planning §7) before we
build a single store.

Everything downstream of A+B — the taste store, the consolidate/gate pass,
replay validation, retrieval, curation UX — is designed here too, but marked
by phase. A+B are at implementable depth (schemas, segmentation, prompts,
cost, CLI). The rest is at architecture depth: enough to confirm A+B's output
has a clean home, not enough to start typing yet.

The governing constraint, stated once: **this rides the existing nightly
pipeline and the existing storage engine.** No new database, no parallel
infrastructure. Where the planning doc says "next to the fact canon, not
inside it," the operative word is *next to* — same machinery, separate store.

---

## 1. Integration map — what we reuse before we build

The strongest version of this system is the one that adds the least. Before
any new code, here is what already exists and what each new piece leans on.

| Need | Already exists | This design's move |
|---|---|---|
| Read Claude Code **and** Codex JSONL | `sessions.ts` — `findRecentSessions`, per-harness parsers, project resolution, secret redaction | **Extend, don't fork.** Promote the lossy `ExtractedExchange` projection to a richer `TranscriptEvent` model (§2). The fact pipeline keeps its current view as a thin projection over it. |
| Scan a 24h window, resolve to projects, write run artifacts, restartability, usage accounting | `condition.ts` (Pass A), `orchestrator.ts`, `pricing.ts` | Taste passes slot into the same orchestrator, write to the same `runs/{DATE}/` dir, use the same `ModelCaller` seam and usage records (§9). |
| Cheap model call → parse tolerant JSON → validate → candidate JSON on disk | `extract.ts` (Pass B/C: `ModelCaller`, `parseExtractionJson`, per-candidate validators) | Taste extractors are new callers using the same plumbing and the same JSON-array discipline (§4, §5). |
| BM25 × strength × decay retrieval over markdown entries with `_meta.json` | `memory.ts` | The fuzzy taste store **is** a memory store — category-sharded files, same engine, same decay-is-forgetting lever (§7). Zero new search code. |
| Candidates → human-gated canon, never auto-admit; directives force-admitted | `candidates.md`, Pass V (`verify.ts`), Pass F (`apply.ts`) | Taste candidates flow through the same gate discipline; the taste-specific consolidate/gate pass (§8) is a sibling of Pass V, not a replacement. |
| Always-on apex principles, loaded in the identity prefix | `taste.ts` → `~/.hive/taste/principles.md` (V0, ~24 entries) | **Unchanged and load-bearing.** This is the apex of §4g. The new long-tail units ladder *up to* these; principles.md stays the promotion target, never auto-written (§8). |
| Reflection promotion / inbox-as-proposal curation | `reflections.ts` (Pass P), `inbox.md` | Curation UX (§10) reuses this pattern rather than inventing a review surface. |

The shape of the whole thing: **one new substrate (the normalized
transcript), two new extraction passes (A, B), one new gate pass (C), one new
store (a category-sharded memory store + a checks dir), and a curation
command.** Everything else is existing machinery wearing a taste hat.

---

## 2. The transcript layer — the format-agnostic foundation (resolves Q1)

This is the part to get right first, because every pass reads it and because
Greg's explicit steer is: *start from the true Claude Code / Codex JSONL
artifact, stay format-agnostic, don't get locked in.*

### 2.1 Why the existing reader isn't enough

`sessions.ts` already does the hard, harness-specific part: it finds recent
JSONL across `~/.claude/projects/<encoded>/*.jsonl` and
`~/.codex/sessions/YYYY/MM/DD/*.jsonl`, resolves each to a HIVE project, and
redacts secrets. That seam is exactly right and we keep it.

But its output — `extractExchanges(): {role, text}[]` — throws away the four
things taste extraction depends on:

1. **Adjacency & order.** Taste lives in `assistant-output → human-reaction →
   resolution` sequences. A flat role/text list loses which turn answered which.
2. **Timestamps.** Redo loops, time-on-task, and "they corrected this within
   seconds" are signal. Confirmed present on every Claude line
   (`timestamp`) and on Codex `session_meta`/response items.
3. **Stable anchors.** Immutable evidence (planning §4e) and Pass A's
   `{anchor}` output need a durable pointer back into the transcript.
   Confirmed: Claude lines carry `uuid` + `parentUuid`; Codex lines are
   addressable as `<file>#L<lineno>`.
4. **Tool & thinking events.** `REWRITE`, `REDO`, `SELF_CORRECTION`,
   `ABANDONED_PATH` are visible *only* in tool sequences (Edit→re-Edit→revert,
   `git checkout`, a Write that undoes a prior Write) and in `thinking`
   blocks. `extractExchanges` drops all of these by design — correct for
   facts, fatal for taste.

### 2.2 The normalized model

Introduce one shared type. Both harness parsers emit it; everything
downstream reads it and nothing downstream knows what a `.jsonl` looks like.

```ts
type EventKind =
  | "message"      // user/assistant prose
  | "thinking"     // assistant reasoning block
  | "tool_use"     // an edit/write/bash/etc. the assistant invoked
  | "tool_result"  // its result (incl. errors, diffs)
  | "meta";        // session_meta, summaries, command scaffolding

interface TranscriptEvent {
  anchor: {
    sessionFile: string;   // provenance + the immutable-evidence key
    id: string;            // Claude uuid | Codex "<file>#L<line>"
    line: number;          // ordinal within the file (always available)
    ts: string | null;     // ISO8601 if present
  };
  parentId: string | null; // Claude parentUuid; Codex = prior event id
  source: "claude" | "codex";
  project: string;         // resolved HIVE project (reuses sessions.ts)
  role: "user" | "assistant" | "tool" | "system";
  kind: EventKind;
  tool?: {                 // present when kind = tool_use / tool_result
    name: string;          // "Edit" | "Write" | "Bash" | ...
    target?: string;       // file path or command, for redo/rewrite detection
    summary: string;       // short, redacted; not the full payload
    isError?: boolean;
  };
  text: string;            // redacted, normalized; "" for pure tool events
}
```

`anchor` is the load-bearing addition. It is simultaneously: Pass A's flag
location, Pass B's window seed, the immutable evidence pointer a taste unit
keeps forever, and the replay harness's index into history. One identifier,
four jobs.

### 2.3 Parser registry — the not-locked-in guarantee

```ts
type TranscriptParser = (file: string, project: string) => TranscriptEvent[];
const PARSERS: Record<SessionSource, TranscriptParser> = {
  claude: parseClaudeTranscript,
  codex:  parseCodexTranscript,
};
```

Adding a new harness (Gemini CLI, Amp, whatever ships next) is **one new
parser function** that maps its on-disk shape into `TranscriptEvent[]`. No
pass, no schema, no store changes. That is the entirety of the
format-agnostic contract, and it is small on purpose. The harness-specific
knowledge already living in `sessions.ts` (`extractTextFromContent` already
handles both Claude's `{type:"text"}` and Codex's `input_text`/`output_text`
blocks; `shouldSkipUserText` already strips command scaffolding) moves behind
these parsers largely intact.

### 2.4 Backward compatibility

`extractExchanges()` becomes a one-line projection:
`events.filter(e => e.kind === "message").map(e => ({role, text}))`. The fact
pipeline (`condition.ts`, `extract.ts`) is untouched in behavior. We are
*widening* the substrate, not migrating the consumers.

### 2.5 Working over *old* transcripts (the test-the-thesis path)

The nightly pipeline is 24h-windowed. The first thing we want to do is run
A+B over *historical* transcripts on Greg's laptop. So the transcript reader
exposes a window-free entry point:

```ts
loadTranscriptEvents(opts: {
  files?: string[];            // explicit JSONL paths, OR
  since?: string; until?: string; // a date range, OR
  hoursWindow?: number;        // the nightly default
}): TranscriptEvent[]
```

This decouples extraction from the nightly clock and is what powers
`hive taste extract` (§11) for the §13 first-slice experiment.

---

## 3. Pipeline shape — where the taste track lives

The fact track is unchanged: `A(condition) → B(fact extract) → C(reflect) →
V(verify) → F(apply) → P(promote)`. The taste track is a parallel set of
passes sharing the orchestrator's scaffolding and run-dir. To avoid letter
collisions with the fact passes, taste passes are **TA / TB / TC**:

```
condition (A, mechanical)  ──┬─►  fact track:  B → C → V → F → P
   transcript events        │
   resolved per project     └─►  taste track: TA(flag) → TB(analyze) → TC(consolidate/gate)
                                                                              │
                                                              ┌───────────────┴───────────────┐
                                                        deterministic                     fuzzy
                                                        → checks/ dir                → category .md stores
                                                                                     (then human curation, §10)
```

TA and TB depend only on the transcript events + project resolution that
condition already produces, so they can run in parallel with the fact track.
TC (the Opus gate) runs after TB. This is detailed in §9.

---

## 4. Pass TA — Flag (cheap, high-recall) — IMPLEMENTABLE

**Goal:** locate divergence events. Do not analyze. Err toward recall;
precision is bought later (TB + recurrence + replay). This is thesis 3 made
mechanical: the machine supplies tireless recall over a high-precision but
sparse human signal.

### 4.1 Two-stage cascade (mechanical pre-filter → Haiku classify)

The planning doc specs TA as "Haiku/Sonnet, high-recall, cheap." We sharpen
it with a **mechanical pre-filter** so even the cheap model only sees
plausible windows — mirroring how `condition.ts` mechanically ranks before
any model runs.

**Stage TA-0 (mechanical, no model): segment into candidate windows.**
A *divergence window* is a contiguous slice of `TranscriptEvent`s centered on
a likely divergence locus. Two locus types:

- **Human-reaction locus** — a `user` message that follows an `assistant`
  output (message or tool_use). This is where `CORRECTION`, `DISSATISFACTION`,
  `PREFERENCE`, `PRAISE`, `REDO` requests live.
- **Self-correction locus** — an `assistant` tool sequence that touches the
  same `tool.target` twice, or a revert pattern (`git checkout`/`git revert`,
  a Write that restores a prior state, an Edit immediately undone). This is
  where `REWRITE`, `SELF_CORRECTION`, `ABANDONED_PATH` live with *no human
  turn at all* — the signal the flat reader can't see.

Cheap structural + lexical cues promote a locus to a candidate window:

- Reaction lexicon on the human turn: `no,` / `not` / `instead` / `actually` /
  `don't` / `why did you` / `revert` / `undo` / `too` (verbose/clever/much) /
  `just` / `simpler` / `again`, plus praise cues (`nice` / `exactly` /
  `perfect` / `that's it`). High-recall, deliberately noisy.
- Structural: repeated `tool.target` within N events; error→retry;
  short human turn tightly following a large assistant edit (fast rejection);
  the existing `ALWAYS_INCLUDE_PATTERNS` ("remember this") as a free signal.

A window = `[locus − k_before, locus + k_after]` events (start k≈2 / 4; tune
on real data). Windows that overlap merge. Output of TA-0 is a list of
`{windowId, anchor (locus event), events[]}`. **No model has run yet.**

**Stage TA-1 (Haiku, one call per project): classify the windows.**
Feed the windows (compact — locus ± neighbors, tool summaries not full
payloads) to Haiku with the taxonomy and ask only: *is this a divergence,
and which kind?* Output per flagged window:

```json
{
  "anchor": { "sessionFile": "...", "id": "<uuid|file#Lnn>", "ts": "..." },
  "window": { "startId": "...", "endId": "..." },
  "type_guess": "CORRECTION|REWRITE|DISSATISFACTION|REDO|PREFERENCE|SELF_CORRECTION|ABANDONED_PATH|PRAISE",
  "trigger_quote": "short verbatim snippet that triggered the flag",
  "crude_confidence": 0.0
}
```

`PRAISE` is included deliberately — positive signal is rare and precious, and
it's the one place "silence is not approval" (thesis 3) gets a counterweight.

### 4.2 Why a pre-filter at all

Two reasons. (1) Cost: a long session is mostly undivergent; sending only
windows keeps even the Haiku pass to a fraction of the transcript. (2)
Determinism + auditability: the mechanical stage is inspectable and testable
without a model, so we can unit-test segmentation on fixtures and reason about
recall independently of prompt quality.

### 4.3 Anchoring & segmentation, stated plainly (Q1)

- **Anchor** = `{sessionFile, id, line, ts}` from §2.2. Stable across re-runs.
- **Segment** = the divergence window, a contiguous event slice, identified by
  `{startId, endId}`. TB re-expands it from the event stream; it is never
  serialized as prose at this stage (cheap, lossless, re-readable).

### 4.4 Output & cost

`runs/{DATE}/taste-flags.<project>.json`. One Haiku call per project with
signal. High-recall by construction; expect TB to discard a large fraction —
that's the design, not a failure. Target: TA sees ~100% of the transcript
mechanically, TB sees the ~10% TA flags (planning §4a).

---

## 5. Pass TB — Analyze (Opus, over flags only) — IMPLEMENTABLE

**Goal:** for each flagged window, decide whether there's a *generalizable
judgment* here and, if so, emit a typed taste **candidate** carrying its
reasoning and immutable evidence. Most flags will not survive — TB is the
first precision gate.

### 5.1 Input

For each flag, TB re-reads the **full window** from the event stream
(expanded, not the preview Haiku saw) — including tool payloads and thinking,
because the *delta* (what changed before→after) often lives in the diff, not
the prose. Plus: the project's existing taste units for that project (for
dedupe) and the apex `principles.md` (for the ladders-up link, §8 — though
the link itself is reasoned in TC; TB may *propose* it).

### 5.2 The taste candidate schema

This is the §4b "taste unit" in pre-canon, candidate form. The two fields
that earn the whole system are `reasoning` (store the *why*, not a rule
string — planning thesis 5) and `evidence` (immutable anchors).

```json
{
  "category": "IDEAS|DESIGN|IMPLEMENTATION|TEST_EVAL|COMMUNICATION|PROCESS",
  "tier": "DETERMINISTIC|FUZZY|CONTEXTUAL",
  "scope": { "kind": "project|general-taste|session-noise",
             "glob": "**/*.sql"   /* optional, tech-specificity rides here */ },
  "reasoning": "WHY, in prose. The load-bearing field. Senior-vs-junior framing where it fits.",
  "delta": { "before": "what the assistant did", "after": "what was preferred" },
  "reason_source": "stated|inferred",
  "rule_statement": "one-line generalizing heuristic (for human scanning, not the source of truth)",
  "canonical_example": { "bad": "...", "good": "..." },
  "check_sketch": "if DETERMINISTIC: pseudo-rule a linter/semgrep/credo could run; else null",
  "evidence": [ { "anchor": {...}, "quote": "...", "confidence": 0.0 } ],
  "dedupe_key": "stable slug for within-session + cross-canon dedup",
  "ladders_up_hint": "optional: apex principle this seems to instantiate (TC confirms)",
  "provenance": "free-text, verifier-checkable, citing the anchor — matches existing candidate discipline"
}
```

### 5.3 The three routing facets, and how TB assigns them

These are **orthogonal** (planning §4c). TB assigns all three independently.

- **`tier`** — *how it's enforced.* `DETERMINISTIC` ⇒ also fill `check_sketch`;
  routes to `checks/`. `FUZZY` ⇒ a reasoning criterion; routes to a category
  `.md`. `CONTEXTUAL` ⇒ a project *fact*, not taste — route it back to the
  fact pipeline's candidates (this is the planning §4b "CONTEXTUAL → semantic
  store" path) rather than the taste store. TB explicitly hands these off so
  taste stays taste.
- **`scope`** — *breadth of activation.* `session-noise` is dropped (a
  one-off, not taste). `project` vs `general-taste` decides which store it
  lands in. **Tech/language specificity is a `glob`, not a category** — the
  SQL-foreign-key rule is `category:IMPLEMENTATION, scope.glob:**/*.sql`.
- **`category`** — *what facet of the work it governs.* The retrieval key
  (§7). Assignment guidance for the prompt, with the boundaries the planning
  doc flagged (Q9):
  - `IDEAS` — should-we / what, framing, novelty. Reaches into writing/research.
  - `DESIGN` — architecture, interfaces, decomposition, **and** planning/
    scheduling (folded here per §6 resolution below).
  - `IMPLEMENTATION` — code craft & convention; where most deterministic,
    glob-scoped rules land.
  - `TEST_EVAL` — verification through operations: testing, eval design,
    deploy/runbook soundness. The "does it actually work, end to end" axis.
  - `COMMUNICATION` — how well it's *expressed*: prose, naming-as-comms,
    commits, PRs, docs, metaphor. Artifact-scoped.
  - `PROCESS` — how the *work is conducted*: workflow, git hygiene,
    when-to-ask, tool discipline, doc *practice* (not doc prose).

  **Multi-category:** TB assigns one **primary** category (the retrieval key)
  and may add at most one **secondary**. We do not forbid spillover, but the
  primary is what scoped activation keys off, so it must be the facet a reader
  would reach for first. (Resolves the Q9 "primary+secondary vs forbid" fork
  in favor of primary-required, secondary-optional.)

### 5.4 Prompt posture

Opus, single call per project over its flags. The system prompt mirrors the
existing `PROJECT_SYSTEM_PROMPT` discipline (one JSON array, no prose, skip
ruthlessly) with taste-specific instruction:

- *Only encode a judgment a capable model wouldn't already make* (planning
  §4e; the recurrence gate enforces it downstream, but TB should pre-filter
  obvious-Claude-already-knows-this).
- *Store the reasoning, not the rule.* `reasoning` is required and must
  generalize; `rule_statement` is a scannable summary, explicitly not the
  source of truth.
- *Quote the evidence verbatim with its anchor.* No anchor ⇒ no candidate.
- *Prefer "inferred" honestly over a fabricated "stated."* `reason_source`
  feeds confidence later.

Reuse `parseExtractionJson` + a `validateTasteCandidate` (sibling of
`validateProjectCandidate`). Reuse `ModelCaller`, `estimateCost`,
`appendUsageRecord`. Output: `runs/{DATE}/candidates.TB.<project>.json`.

### 5.5 What success looks like for the first slice

Per planning §7: run TA+TB over a handful of real past transcripts and ask —
*do ≥~30% of these candidates match taste Greg would genuinely canonize?* If
yes, the premise holds and the stores are engineering. If it's mush, stop and
rethink before building anything in §7–§11. **This is the gate on the rest of
the project.**

---

## 6. Resolving the category boundary questions (Q9)

The planning doc left three seams for this session to confirm or break.
Decisions:

- **Planning/scheduling stays in `DESIGN`.** It is "how the thing is shaped
  and sequenced." A separate `PLANNING` category would split a single act of
  judgment (how to decompose vs. in what order) across two stores for no
  retrieval benefit — both fire in the same phase. Revisit only if real data
  shows planning-taste that never co-retrieves with design-taste.
- **`TEST_EVAL` ↔ `PROCESS` seam:** operational *correctness* (did staging go
  green, did the runbook execute) is `TEST_EVAL`; operational *method* (how we
  run releases as a practice) is `PROCESS`. The discriminator: a `TEST_EVAL`
  judgment is falsifiable against an outcome; a `PROCESS` judgment is about
  conduct.
- **`PROCESS` ↔ `COMMUNICATION` seam:** substance of a doc is `PROCESS` (or
  `IDEAS`); how *well* it reads is `COMMUNICATION`. Same split as
  `IDEAS`/`COMMUNICATION` (true vs. said-well).

The set is **fixed at six** and deliberately non-extensible on spec —
taxonomy sprawl is the failure mode. If a recurring cluster of candidates
fits none cleanly, that's a §8 "orphan cluster" signal, handled by promotion,
not by minting a seventh category.

---

## 7. The taste store & retrieval (resolves Q4) — PHASE 2

The retrieval model is settled in planning §4f; this fixes the mechanics.

### 7.1 Layout — a memory store wearing a taste hat

```
~/.hive/memory/projects/<name>/taste/
├── ideas.md          design.md       implementation.md
├── test-eval.md      communication.md process.md      # FUZZY units, one file per category
├── _meta.json        # strength/decay — the SAME engine as memory.ts
└── checks/           # DETERMINISTIC tier, compiled out — run, never read
    └── <slug>.<ext>  # credo/semgrep/lint/native, + a sibling .md rationale
```

A fuzzy unit is a markdown block: `reasoning` + `canonical_example {bad,good}`
+ scope/glob + immutable `evidence` anchors + `ladders_up_to` link. It is a
memory entry — identity = SHA-256 prefix of cleaned text, tracked in
`_meta.json`, decayed and strengthened by the **existing** `memory.ts` engine.
This is the single biggest reuse: the taste store needs *zero new search
code*. Decay is the "forgetting is a feature" lever (planning §4e), already
built.

`general-taste` (cross-project) units live in a parallel
`~/.hive/memory/taste/<category>.md`. Apex `principles.md` is unchanged.

### 7.2 Activation — never wholesale

- **Deterministic → executed, not read.** Zero context cost until it fires;
  the model sees only violations. The `.md` rationale sits beside the check
  like lint docs the linter never loads.
- **Fuzzy → retrieved top-K on demand**, via `searchMemory` over the taste
  store, **pre-filtered by `category`** (cheap) then `scope`/`glob`. A
  relevance floor drops weak hits so we return "the handful relevant to *this*
  task," never the catalog. K and the floor are tuned on real corpora;
  start K≈5, floor at a fraction of the top hit's score.
- **No always-on taste index.** The disk is the index, queried not loaded.
  Importance is promoted *upward* into `principles.md` (§8), never pinned into
  the prefix.

### 7.3 Triggers (the remaining Q4 work)

- **`IMPLEMENTATION` / `COMMUNICATION` — hook-driven.** A file-edit /
  artifact-write hook maps the path's glob → category → query and pulls
  units automatically (editing `**/*.sql` pulls SQL units; writing a commit
  pulls `COMMUNICATION`). No agent decision required. (Wiring this to the
  Claude Code hook surface is a phase-3 detail; the retrieval call underneath
  is the same `searchMemory`.)
- **`DESIGN` / `IDEAS` — phase- or agent-requested.** No file signal, so
  these use the `agent-requested` scope: one explicit retrieval call at the
  start of a planning/framing phase, not N resident descriptions. Reliability
  of "remembering to ask" is the open risk; the fallback is a phase marker in
  OVERRIDES (same mechanism the V0 taste applications already use).

---

## 8. Pass TC — Consolidate, gate & principle-coherence (resolves Q6, Q10) — PHASE 2

TC is the taste-track sibling of the fact track's Opus verifier (Pass V). It
reads TB's candidates + the existing taste store + `principles.md`, and
produces routed, gated decisions. It is **one Opus call**, reasoning over
*rationale* (which is exactly why principle-coherence is tractable — planning
§4g, thesis 5).

TC's jobs, in order:

1. **Dedupe** — within the run and against the existing store, by
   `dedupe_key` + reasoned similarity. Reorganize, never destroy evidence
   (planning §4e): a duplicate *merges its evidence anchors* into the existing
   unit and bumps recurrence.
2. **Recurrence gate** — canonize only on recurrence **or** an explicit
   human confirmation in the evidence (the planning §4e "only encode what the
   model wouldn't already do" enforced as a count). First-sighting candidates
   wait in a pending state; they don't hit a store on one observation. This is
   also the answer to fickleness at the cheap end — one mood doesn't make a
   rule.
3. **Conflict detection** — flag candidates that contradict an existing unit;
   surface, don't auto-resolve.
4. **Principle-coherence linking (Q10)** — resolve each surviving candidate
   against the ~24 apex principles and record the relationship, *reasoned and
   stored as evidence so a human can audit the why*:
   - **Instantiates** → record `ladders_up_to`; the unit inherits the
     principle's rationale (so granular rules don't restate the why) and files
     real evidence under that principle. Raises confidence.
   - **Orthogonal** → stands alone. A *recurring cross-category cluster* of
     orphans is the bottom-up signal that a new apex principle may be
     emerging — TC emits that as a proposal to the curation inbox, never a
     write.
   - **Tension** → surfaced to the human, never failed. Exactly one of three
     is true (candidate wrong / principle too broad / legitimate scoped
     exception) and only Greg, reading the reasoning, decides. Coherence
     informs curation; it never adjudicates.
5. **Route by tier** — `DETERMINISTIC` → `checks/` (compile sketch → real
   check, phase 3); `FUZZY` → category store; `CONTEXTUAL` → hand back to the
   fact candidates queue.

**How "ladders up to" is computed cheaply (Q10):** Opus over `candidates ×
24 principles` is ~24 rationale comparisons per candidate — trivial at our
volume; no embeddings pre-filter needed at this scale (revisit if the
principle set or candidate volume grows an order of magnitude, mirroring the
memory-architecture "BM25 until thousands" stance). The link is *reasoned*,
not string-matched — the whole point of storing rationale.

**Output & write discipline:** `runs/{DATE}/taste-decisions.json`. Like
Pass V, TC **proposes**; nothing auto-admits to a store. The write-gate is
the memory-poisoning defense (planning §4e) and stays absolute. The one
inherited exception: a **directive** ("save this taste rule") is force-admitted
just as the fact pipeline force-admits directive facts.

**Relationship to the candidates pipeline (Q6):** taste reuses the
candidates→gate→apply *machinery and discipline* but runs on its own
artifacts and its own Opus call, because replay-validation and
principle-coherence are taste-specific work the fact verifier shouldn't carry.
Same philosophy, separate pass — "next to, not inside."

---

## 9. Replay validation (resolves Q3) — PHASE 2

The fickleness fix (planning §4d): a candidate is promoted only if it
**predicts past corrections** — your correction history is the held-out eval
set, no external ground truth.

- **The eval set** is the corpus of past TA windows: loci that *were*
  corrections (positives) and assistant outputs that were *accepted*
  (negatives — the human moved on without reacting). The anchored
  `TranscriptEvent` history is exactly this corpus, already on disk.
- **Operationalization, cheaply:** for a `FUZZY` candidate, give a judge model
  the rule's `reasoning` and ask, over a sample of held-out windows, "would
  this rule have flagged here?" Compare against ground truth (was there an
  actual correction at that window?). For a `DETERMINISTIC` candidate, *run
  the check* over the historical file states — no model needed, fully
  deterministic, and the strongest evidence we can get.
- **Thresholds gate promotion:** a candidate must clear a **precision** floor
  (its flags land on real corrections, not accepted output — the expensive
  error is a false alarm on good work) with at least a minimal **recall** of
  the corrections it claims to cover. Exact numbers are tuned once we have the
  first-slice corpus; precision is weighted over recall because a taste rule
  that nags about accepted work is worse than one that's silent (thesis 3:
  high-precision human signal). "Silence is never approval," so an accepted
  window is a true negative *for the rule*, not training signal that the work
  was good.
- **How many sessions:** as many as are cheaply available; the deterministic
  path scales freely, the judge path is sampled. Start with all transcripts in
  a rolling window (e.g. 90 days) and widen if signal is thin.

Replay slots between TC's recurrence gate and the store write: recurrence says
"this happened more than once," replay says "and a rule for it actually
predicts the corrections." Both must pass.

---

## 10. Curation UX (resolves Q5) — PHASE 2

The human's only new job is curating candidate rules — approve / edit / kill —
not labeling everything (planning §3). Reuse the reflection-promotion pattern
(`reflections.ts` + `inbox.md`), don't invent a surface.

- **`hive taste review`** — a batch walk of pending taste candidates (those
  past recurrence + replay, awaiting human sign-off). For each: show
  `reasoning`, `canonical_example`, the `ladders_up_to` link or the surfaced
  **tension**, and the evidence anchors (clickable into the transcript).
  Actions: **approve** (writes the unit to its category store / compiles the
  check), **edit** (Greg rewrites the reasoning — the C-level authorship
  discipline from the V0 taste design: Maya extracts, Greg composes, to keep
  Maya's voice out of canon), **kill** (records a negative so TC stops
  re-proposing it), **promote** (lift a unit up into `principles.md` — the
  only path into the always-on apex).
- **Tensions and orphan-cluster proposals** land in the same review as
  first-class items: a tension asks Greg to pick which of the three things is
  true; an orphan cluster asks whether a new apex principle should be drafted.
- **Edit/kill feeds the lifecycle:** kills become negatives in the replay eval
  set (a rule that keeps getting killed is mis-shaped); edits reset the unit's
  strength metadata (edited text = new identity, per the existing engine).
- **Cadence:** weekly, matching the V0 taste plan. Low-friction or it rots —
  the same lesson the reflection-promotion triage already taught us.

---

## 11. Decay / expiry (resolves Q8) — PHASE 2

"Forgetting is a feature" (planning §4e) is already implemented — the taste
store inherits `memory.ts` decay verbatim. What's taste-specific:

- **Stale = low strength + never fired.** A fuzzy unit decays on the standard
  half-life; firing (a retrieval hit, or a deterministic check catching a real
  violation) strengthens it. A unit that never retrieves and never fires sinks.
- **Active expiry vs. rare-but-important:** decay only *ranks down*, never
  deletes (the engine's existing contract). A genuinely rare-but-important
  rule is protected two ways: promotion to `principles.md` (apex never
  decays), and the deterministic tier (a check costs nothing to keep, so rare
  deterministic rules just stay). Soft-fuzzy units that sink and are never
  promoted are the correct thing to forget — that's procedural-drift defense.
- **Procedural drift** (entrenching a bad habit) is caught by replay
  re-validation: periodically re-run replay over recent history; a unit whose
  precision has degraded (the world moved, the rule is now wrong) gets flagged
  for the curation inbox, not silently kept.

---

## 12. Rigor agent — Pass A′ recall (resolves Q7) — PHASE 3, deferred

Kept explicitly separate so it never pollutes the high-precision human signal
(planning §4a, §3). Design intent recorded; build deferred until the human
track (TA→TC) is proven:

- **Source of "known junior-isms":** the *deterministic checks store itself*
  plus the soft-fuzzy units already canonized — i.e. the rigor agent applies
  the taste we've *already* earned, looking for matches the human didn't react
  to. It does not invent new taste.
- **Cadence & model:** async, off the hot path (planning §5 — no in-flow
  interruption beyond cheap deterministic checks). A nightly or
  heartbeat-driven scan, Haiku/Sonnet for the fuzzy matches.
- **Output posture:** "you may have missed this," surfaced to the inbox, never
  auto-adopted, never blocking. Its precision threshold can be lower than the
  human track precisely because its output is suggestion, not canon.

---

## 13. Phasing — the smallest test first

**Phase 1 — the thesis test (this is the whole gate).** Build §2 (transcript
events + parser registry, extending `sessions.ts`), §4 (Pass TA), §5 (Pass
TB), and the `hive taste extract` CLI over arbitrary/old transcripts. Run it
over a handful of Greg's real past sessions. Eyeball the candidates against
planning §7's ≥30% bar. **No stores, no gate, no retrieval yet.** If the
signal isn't there, stop and rethink.

**Phase 2 — make it land.** §7 store (reusing `memory.ts`), §8 Pass TC
(consolidate/gate/coherence), §9 replay validation, §10 `hive taste review`,
§11 decay policy. Wire TA/TB/TC into the orchestrator (§14).

**Phase 3 — make it activate & expand.** §7.3 hook-driven retrieval wiring,
deterministic `check_sketch` → real linter/semgrep/credo compilation, §12
rigor agent.

The discipline is the same one the research's skeptic camp insists on: prove
value at the cheapest possible scale before building the clever parts.

---

## 14. Orchestrator integration (Q6, concretely)

The taste passes are added to `orchestrator.ts` as a parallel track sharing
all scaffolding:

- **Run after condition** (which already produces transcript scan + project
  resolution). TA/TB can run *concurrently* with the fact track's B/C since
  they share only the read-only condition output.
- **Artifacts** land in the same `runs/{DATE}/`:
  `taste-flags.<project>.json` (TA), `candidates.TB.<project>.json` (TB),
  `taste-decisions.json` (TC). The existing `runs/{DATE}/taste.md` (today the
  nightly principles readout) becomes TC's human-readable summary.
- **Restartability & failure isolation** follow the existing contract: each
  pass deletes its target artifact at the start of an attempt; a TB failure on
  one project doesn't block others; a TC failure cleanly skips the store
  write with upstream artifacts intact for inspection (mirrors Pass V→F).
- **Usage accounting** reuses `appendUsageRecord` / `estimateCost`. Added
  cost: one Haiku call/project (TA) + one Opus call/project (TB) + one Opus
  call (TC). Roughly doubles the nightly LLM spend; still in the $1–few range.
- **`NightlyResult`** gains `passes.TA[] / TB[] / TC` reports alongside the
  existing A/B/C/V/F/P, so the dashboard and briefing surface the taste track.

---

## 15. CLI surface

- **`hive taste extract`** — the phase-1 workhorse, decoupled from the nightly
  clock. `--transcript <path...>` | `--since <date> --until <date>` |
  `--project <name>`; `--flags-only` (stop after TA); `--out <dir>`. Prints a
  summary table of candidates by category/tier and writes the JSON. This is
  what runs over old transcripts on the laptop.
- **`hive taste review`** — §10 curation walk.
- **`hive taste status`** — counts per category/tier, last-fired, pending
  curation queue depth; folded into `hive doctor`.
- **`hive memory nightly`** — unchanged invocation; now also runs the taste
  track (skippable with `--no-taste` while phase 1 stabilizes).

---

## 16. Open questions carried forward

Resolved here: Q1 (transcript model §2), Q3 (replay §9), Q4 (retrieval §7),
Q5 (curation §10), Q6 (pipeline reuse §8/§14), Q7 (rigor agent §12, deferred),
Q8 (decay §11), Q9 (categories §6), Q10 (coherence §8). Q2 is intentionally
deferred to phase 3.

Genuinely still open, for after the phase-1 data exists:

- **Q2 — check artifact format.** Native HIVE check DSL vs. per-language
  linter/semgrep/credo configs. Deferred until phase 3, because the *first*
  deterministic candidates will tell us how language-spread they actually are.
  Leaning: emit a language-agnostic `check_sketch` now (already in the schema),
  compile to whatever the target stack uses later.
- **TA recall vs. cost balance.** The mechanical pre-filter's k-window and
  lexicon are guesses until tuned on Greg's transcripts.
- **Replay thresholds.** Precision/recall floors (§9) are placeholders until
  the first-slice corpus exists.
- **Top-K & relevance floor** for fuzzy retrieval (§7.2) — same: tune on real
  stores.
- **Hook reliability for `DESIGN`/`IDEAS`** (§7.3) — the no-file-signal
  categories are the weakest link in activation; needs a real-use trial.

---

## 17. Decisions log

- **Reuse over rebuild.** Every new piece leans on existing machinery
  (`sessions.ts`, `condition.ts`, `extract.ts`, `memory.ts`, `verify.ts`,
  `reflections.ts`). The only genuinely new substrate is the normalized
  transcript model. ("Next to, not inside" — planning §4b.)
- **The normalized `TranscriptEvent` is the format-agnostic core.** One
  parser per harness; everything else is harness-blind. This is Greg's
  explicit steer made structural.
- **Tool & thinking events are in scope for taste** (out of scope for facts) —
  because `REWRITE`/`REDO`/`SELF_CORRECTION`/`ABANDONED_PATH` live there.
- **TA gets a mechanical pre-filter** before the cheap model, mirroring
  `condition.ts`'s ranking-before-model philosophy.
- **Store reasoning, not rules** — `reasoning` required, `rule_statement`
  explicitly demoted to a scannable summary.
- **Primary category required, secondary optional** (Q9).
- **Planning folds into `DESIGN`; six categories, non-extensible** (Q6).
- **Replay precision is weighted over recall** — a nagging rule is worse than
  a silent one (thesis 3).
- **Phase 1 is a hard gate.** Build only TA+TB+the offline CLI first; the
  ≥30%-canonizable bar decides whether the rest gets built at all.
- **Write-gate stays absolute** (memory-poisoning defense); directives the
  one inherited exception.

## 18. References

- `PLANNING-taste-extraction-and-memory.md` — the aiming doc (§4 decided
  directions, §6 open questions, §7 first step).
- `taste-memory-structures-research-2026-06.md` — three-store split, store
  reasoning not rules, MAC lifecycle, replay-against-corrections, skeptic
  build budget.
- `docs/memory-architecture.md` — the nightly pipeline, BM25×strength×decay
  engine, candidates→canon gate this design reuses.
- `docs/specs/2026-04-26-taste-design.md` — V0 taste layer (principles.md);
  this design supersedes its "V1 mining" sketch and makes principles.md the
  apex of §4g.
- Source modules: `src/lib/sessions.ts`, `condition.ts`, `extract.ts`,
  `verify.ts`, `apply.ts`, `orchestrator.ts`, `memory.ts`, `taste.ts`,
  `reflections.ts`.
</content>
</invoke>
