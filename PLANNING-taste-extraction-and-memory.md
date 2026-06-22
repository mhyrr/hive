# PLANNING — Taste Extraction & the Judgment Memory Layer

**Status:** Aiming document. Design happens in a separate session. This captures *what we're trying to build and why*, what's already decided, and what's still open — enough for a fresh session to start designing without re-deriving the thinking.

**Companion research artifacts (read these first):**
- `frontier-agentic-research-2026-06.md` — the broad frontier scan (where the field is going).
- `taste-memory-structures-research-2026-06.md` — the deep dive on memory/knowledge structures for taste.

---

## 1. The motivation, in one breath

HIVE already has a reflection step that distills session learnings into a flat, decaying, lookup-retrieved memory canon. That's correct for *facts*. It is the wrong home for **taste** — the "a senior engineer wouldn't do that" judgments. We want to grow the reflection system one tier so it captures taste from real sessions and stores it in a structure built for judgment, not facts.

## 2. The thesis we're betting on

1. **Verification is the new bottleneck.** As generation gets cheap and long-horizon autonomy grows, the scarce resource is judging whether output is *good* — and the hardest, least-automated part of "good" is taste.
2. **Taste signal lives in-flow, not in terminal verdicts.** It shows up as mid-session corrections, rewrites, redo loops, and stated preferences — not as a thumbs-up on a finished PR. The session transcript is the source of truth.
3. **Human taste is high-precision, low-recall, and fickle.** The corrections you make are reliable; your *silence* is missing data, never approval. So: mine only actual divergences, and add a tireless machine for recall — never treat absence of correction as positive.
4. **Inspectable rules beat a learned reward model — *for taste specifically* — precisely because the ground truth is fickle and sparse.** Inspectability is what lets a human stay in the loop as a *curator of rules* instead of a *labeler of everything*. (`ex_slop` on Credo is the existence proof.)
5. **Store reasoning, not rule-lists.** (Anthropic's constitution moved list → rationale.) Rationale generalizes to novel cases; enumerated don'ts ossify. This is the answer to "taste is too nuanced to codify."

## 3. What we're aiming at (target system, one paragraph)

A **taste-extraction pass** that runs on the nightly pipeline, mines session transcripts for divergence events using a cheap-flag / expensive-analyze cascade, and emits *typed* candidate rules — each carrying its reasoning, its originating evidence, a tier, and a scope. Those candidates flow through a **validation-by-replay** gate (does this rule predict the corrections I actually made?) into a **judgment/policy memory layer that sits next to the fact canon, not inside it** — a tiered, scoped, lifecycle-managed "constitution" of deterministic checks + soft reasoning units. A separate **rigor agent** supplies recall (catches junior-isms the human missed), and the human's only new job is curating candidate rules (approve/edit/kill), not labeling everything.

## 4. Decided design directions (don't re-litigate these)

### 4a. The extraction pass — cost-tiered cascade
- **Pass A — Flag (Haiku/Sonnet, high-recall, cheap):** locate divergence events; do not analyze. Event taxonomy: `CORRECTION`, `REWRITE`, `DISSATISFACTION`, `REDO`, `PREFERENCE`, `SELF_CORRECTION`, `ABANDONED_PATH`, `PRAISE`. Output: `{anchor, type_guess, trigger_quote, crude_confidence}`.
- **Pass B — Analyze (Opus, over flagged ~10% only):** for each event answer: **delta** (before→after), **reason** (`stated` vs `inferred`), **rule** (the generalizing heuristic, framed senior-vs-junior where it fits), **tier** (`DETERMINISTIC` / `FUZZY` / `CONTEXTUAL`), **scope** (`project` / `general-taste` / `session-noise`), **check_sketch** (if deterministic), **evidence** (quote + confidence + dedupe_key).
- **Pass C — Consolidate & gate:** dedupe (within session + against canon), **recurrence gate** (canonize only on recurrence or explicit confirmation), conflict detection, route by tier.
- **Pass A′ — Recall (separate, lower-confidence):** the rigor agent scans for matches to *known* junior-isms even where the human didn't react; surfaced as "you may have missed this," never auto-adopted. Kept separate so it doesn't pollute the high-precision human signal.

### 4b. Storage — a three-store split (neurosymbolic)
- **Episodic** → session logs (exists).
- **Semantic / facts** → flat retrieval canon (exists); add graph edges *only* for the relational/temporal slice, GBrain-style (plain-text + mention-wired edges), and only if/when the relational blind spot bites. Graph is **not** the default.
- **Procedural / normative (taste)** → **NEW judgment layer**, structured as:
  - A **taste unit** = `{reasoning, tier (hard|deterministic|soft-fuzzy), scope (always|glob|agent-requested), evidence[] (immutable), canonical_example {bad,good}, recurrence, confidence, status, last_fired, decay}`.
  - **Deterministic tier** compiles to a Credo/Semgrep/lint-style check + rationale (the `ex_slop` end).
  - **Soft-fuzzy tier** is a reasoning criterion the rigor agent applies (the constitution end).
  - **Scoped activation** (Cursor-style) so we never blow the ~150-instruction follow-budget; deterministic checks always-on, fuzzy rules loaded by scope.

### 4c. The fickleness fix — validation by replay
A candidate rule is promoted only if it **predicts past corrections**: replay it over prior sessions — does it flag what you actually corrected without flagging what you accepted? Your correction history *is* the held-out eval set. No external ground truth needed. (Pattern: MAC's accept/edit/reject + held-out validation + pruning.)

### 4d. Operating principles (from the skeptic camp — these are constraints, not options)
- **Plain-text, on the existing nightly pipeline.** The structure is conceptual (tiered/scoped/validated/evidence-linked); the implementation stays markdown + current pipeline. No new database on spec.
- **Only encode judgments a capable model wouldn't already make.** Don't write rules for taste the model has. (Recurrence gate enforces this.)
- **Forgetting is a feature.** Active expiry/pruning of rules to prevent "procedural drift" (entrenching bad habits).
- **Write-gating stays.** Never auto-admit to canon — it's also the defense against memory poisoning.
- **Transparency over cleverness.** Human-curated, inspectable rules beat an opaque learned reward model here.
- **Keep immutable evidence** behind every rule; consolidation reorganizes, never destroys source episodes.

## 5. Explicitly out of scope (for the design session to NOT do)
- No learned/parametric reward model for taste (decided against — fickle ground truth + auditability).
- No graph database adoption for the fact store on spec.
- No always-on monolithic rules file (hits the instruction-budget cliff).
- No in-flow interruption by the rigor agent beyond cheap deterministic checks (async by default).

## 6. Open questions for the design session
1. **Transcript access & granularity:** what exactly does Pass A read (raw session JSONL?), and how are events anchored/segmented?
2. **Check artifact format:** do deterministic rules become real linter configs (language-specific), a HIVE-native check DSL, or Semgrep rules? How language-agnostic must this be?
3. **The replay-validation harness:** how many past sessions, how is "would have flagged" operationalized cheaply, what precision/recall thresholds gate promotion?
4. **Scope/activation mechanics:** how are fuzzy rules retrieved/loaded per context without re-introducing the lookup-memory problem we're moving away from?
5. **Curation UX:** how does the human review candidate rules (batch? inline? where?) and how is edit/kill captured back into the lifecycle?
6. **Relationship to existing canon + candidates pipeline:** does the judgment layer reuse the candidates→canon machinery, or run parallel? What changes in the nightly orchestrator passes?
7. **Rigor agent design:** model, cadence, where its "known junior-isms" come from (the canon it applies), and its precision threshold.
8. **Decay/expiry policy:** what makes a rule go stale, and how is "active forgetting" triggered without losing genuinely rare-but-important rules?

## 7. Suggested first design step (smallest test of the whole thesis)
Before building anything: point a single Pass-A+B extraction over a handful of *real* past transcripts and look at the candidate rules it emits, tiered. Ask: *do ≥~30% of these match taste I'd genuinely canonize, or is it noise?* If yes, the mine-corrections-from-sessions premise holds and the rest is engineering. If it's mush, the signal isn't where we think and we rethink before building the stores.

## 8. Lineage / why we trust these directions
- Convergent evolution toward temporal facts + nightly consolidation (Letta sleep-time, OpenAI "Dreaming," Zep, GBrain) validates the nightly-pipeline architecture.
- `ex_slop`/Credo + Semgrep confirm deterministic taste-as-checks works in production.
- Anthropic's constitution (list→reason, hard/soft tiers, deployer layer) is the working template for tiered reasoned policy.
- MAC + Memp + All-Mem supply the lifecycle (validate/dedup/expire) and immutable-evidence patterns flat memory lacks.
- The minimalist/skeptic camp (EMem, Anthropic files+grep, "every clever architecture lost to markdown+bash") sets the build budget: stay plain-text, stay small, prove value first.
