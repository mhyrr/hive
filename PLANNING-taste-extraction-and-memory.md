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

A **taste-extraction pass** that runs on the nightly pipeline, mines session transcripts for divergence events using a cheap-flag / expensive-analyze cascade, and emits *typed* candidate rules — each carrying its reasoning, its originating evidence, a tier, a scope, and a **category** (which aspect of the work the judgment governs: design / implementation / test-eval / ideas / communication). Those candidates flow through a **validation-by-replay** gate (does this rule predict the corrections I actually made?) into a **judgment/policy memory layer that sits next to the fact canon, not inside it** — a tiered, scoped, lifecycle-managed "constitution" of deterministic checks + soft reasoning units. A separate **rigor agent** supplies recall (catches junior-isms the human missed), and the human's only new job is curating candidate rules (approve/edit/kill), not labeling everything.

## 4. Decided design directions (don't re-litigate these)

### 4a. The extraction pass — cost-tiered cascade
- **Pass A — Flag (Haiku/Sonnet, high-recall, cheap):** locate divergence events; do not analyze. Event taxonomy: `CORRECTION`, `REWRITE`, `DISSATISFACTION`, `REDO`, `PREFERENCE`, `SELF_CORRECTION`, `ABANDONED_PATH`, `PRAISE`. Output: `{anchor, type_guess, trigger_quote, crude_confidence}`.
- **Pass B — Analyze (Opus, over flagged ~10% only):** for each event answer: **delta** (before→after), **reason** (`stated` vs `inferred`), **rule** (the generalizing heuristic, framed senior-vs-junior where it fits), **tier** (`DETERMINISTIC` / `FUZZY` / `CONTEXTUAL`), **scope** (`project` / `general-taste` / `session-noise`), **category** (`DESIGN` / `IMPLEMENTATION` / `TEST_EVAL` / `IDEAS` / `COMMUNICATION` — see §4c), **check_sketch** (if deterministic), **evidence** (quote + confidence + dedupe_key).
- **Pass C — Consolidate & gate:** dedupe (within session + against canon), **recurrence gate** (canonize only on recurrence or explicit confirmation), conflict detection, route by tier.
- **Pass A′ — Recall (separate, lower-confidence):** the rigor agent scans for matches to *known* junior-isms even where the human didn't react; surfaced as "you may have missed this," never auto-adopted. Kept separate so it doesn't pollute the high-precision human signal.

### 4b. Storage — a three-store split (neurosymbolic)
- **Episodic** → session logs (exists).
- **Semantic / facts** → flat retrieval canon (exists); add graph edges *only* for the relational/temporal slice, GBrain-style (plain-text + mention-wired edges), and only if/when the relational blind spot bites. Graph is **not** the default.
- **Procedural / normative (taste)** → **NEW judgment layer**, structured as:
  - A **taste unit** = `{reasoning, tier (hard|deterministic|soft-fuzzy), scope (always|glob|agent-requested), category (design|implementation|test-eval|ideas|communication — see §4c), evidence[] (immutable), canonical_example {bad,good}, recurrence, confidence, status, last_fired, decay}`.
  - **Deterministic tier** compiles to a Credo/Semgrep/lint-style check + rationale (the `ex_slop` end).
  - **Soft-fuzzy tier** is a reasoning criterion the rigor agent applies (the constitution end).
  - **Scoped activation** (Cursor-style) so we never blow the ~150-instruction follow-budget; deterministic checks always-on, fuzzy rules loaded by scope.

### 4c. The category dimension — what the judgment is *about*
Tier and scope describe *how* a rule is enforced and *where by breadth* it activates. They don't capture the thing a reader most needs to route a rule correctly: **which aspect of the work it governs.** Taste isn't general-across-the-board — a judgment is almost always *about* a specific facet of building, and it should only be in play when that facet is live. So every taste unit carries a **category**, a small fixed set (deliberately not extensible on spec — taxonomy sprawl is the failure mode):

- **`IDEAS`** — the *content and construction of ideas*: problem framing, the abstractions chosen, problem selection, and whether an idea (or a particular manifestation of it) is **interesting, novel, or contrarian**. The *should-we* and *what*, before the *how* — and it reaches beyond code into writing/research content. Distinct from `DESIGN`, which assumes you've committed to building the thing. The least deterministic, most fuzzy/contextual category.
- **`DESIGN`** — architecture, interfaces, structure, and the planning/scheduling that precedes code. "Principles of design" live here: how the thing is shaped, sequenced, and decomposed once the approach is being chosen.
- **`IMPLEMENTATION`** — code-level craft and convention, including the language/tech/stack-specific rules (DB foreign-key style, naming, error handling). This is where most *deterministic-tier* checks land and where rules are most often glob-scoped to a tech.
- **`TEST_EVAL`** — testing strategy and eval design: what counts as adequate coverage, what "good verification" looks like, how to judge whether a result is actually good (directly serves the §2 "verification is the bottleneck" thesis).
- **`COMMUNICATION`** — how things are *expressed*, and how *well*: prose quality, accessibility, a distinctive voice, the aptness of a **metaphor or analogy**, plus naming-as-communication, commit messages, PR descriptions, comments, docs. Recurs constantly and is *artifact-scoped*, which makes it an ideal on-demand retrieval target — pull it when writing the commit / PR / doc / prose. Doesn't fit `DESIGN`/`IMPLEMENTATION`, so it earns its own category rather than an awkward home.

  *Why split `IDEAS` from `COMMUNICATION` (they're tempting to lump, especially on a writing project):* `IDEAS` asks *is the thing worth saying — is it true, novel, well-framed?* `COMMUNICATION` asks *is it said well?* They travel together but pull apart under analysis — a brilliant idea expressed flatly and a banal idea expressed beautifully are different failures with different fixes, and you want to retrieve/curate the two kinds of taste independently.

(Deliberately *not* a category: **process/workflow** taste — when-to-ask-vs-proceed, git hygiene, security posture, tool discipline. By the promotion principle below, anything operational that matters enough gets curated *upward* into the always-on identity / taste-principle files, so it already has a home and doesn't need a retrieved category that would double-house it.)

**Category is orthogonal to tier and scope** — it's a third independent facet, not a re-slicing of either. The same judgment varies freely across all three: your "foreign keys should look like X" example is `category: IMPLEMENTATION`, `tier: DETERMINISTIC`, `scope: glob **/*.sql`. A design judgment can be project-scoped or general; an implementation judgment can be deterministic or fuzzy. Crucially, **language/tech-specificity is a scope property, not a category** — the *specificity* rides on scope (glob/always), while category names the *kind* of judgment. Keep the two from collapsing into each other.

**Why it earns its place:** category is the primary signal for **when a rule is used** (the retrieval key in §4f). It feeds scoped activation and the rigor agent (open Q7): load `DESIGN` units when planning, `IMPLEMENTATION` when editing code, `TEST_EVAL` when writing tests/evals, `COMMUNICATION` when writing prose/commits, `IDEAS` in framing/exploration. Without it, every fuzzy rule is a candidate for every context, which re-introduces the instruction-budget cliff we're trying to avoid. (Open boundary call: planning/scheduling is folded into `DESIGN` — flagged in §6 for the design session to confirm or break out.)

### 4d. The fickleness fix — validation by replay
A candidate rule is promoted only if it **predicts past corrections**: replay it over prior sessions — does it flag what you actually corrected without flagging what you accepted? Your correction history *is* the held-out eval set. No external ground truth needed. (Pattern: MAC's accept/edit/reject + held-out validation + pruning.)

### 4e. Operating principles (from the skeptic camp — these are constraints, not options)
- **Plain-text, on the existing nightly pipeline.** The structure is conceptual (tiered/scoped/validated/evidence-linked); the implementation stays markdown + current pipeline. No new database on spec.
- **Only encode judgments a capable model wouldn't already make.** Don't write rules for taste the model has. (Recurrence gate enforces this.)
- **Forgetting is a feature.** Active expiry/pruning of rules to prevent "procedural drift" (entrenching bad habits).
- **Write-gating stays.** Never auto-admit to canon — it's also the defense against memory poisoning.
- **Transparency over cleverness.** Human-curated, inspectable rules beat an opaque learned reward model here.
- **Keep immutable evidence** behind every rule; consolidation reorganizes, never destroys source episodes.

### 4f. Output, storage & retrieval — how a rule is stored and looked up
The whole point is that taste rules **don't cost context budget by existing** — the failure mode we reject is the skill model, where every rule's front-matter is resident at all times (N rules = N descriptions always loaded). HIVE's fact memory already avoids this (`docs/memory-architecture.md`: disk-resident `knowledge.md`, a *capped* `_index.md`, everything else via BM25 search on demand). The taste layer rides the same split, sharpened by tier:

- **Storage format ≠ activation mechanism.** Skills conflate them; we keep them separate. Markdown is the storage of record; activation is a separate, lazy path.
- **Deterministic tier → executed, not read.** The output is a compiled Credo/Semgrep/lint-style check, not a rule in context. The model never loads it; it runs the check and sees only *violations*. Zero context cost until it fires. The markdown unit (rationale + canonical bad/good) is the human-readable record sitting *beside* the compiled check — like lint docs the linter itself never loads.
- **Fuzzy / contextual tier → retrieved on demand, never wholesale.** Stored as markdown taste units, pulled top-K for the current task via the existing BM25 × strength search, filtered by **category** (the cheap pre-filter) + **scope** (project / glob). Decay sinks stale units automatically (the "forgetting is a feature" lever, already in the strength model). You pull the handful relevant to *this* task, never the catalog.
- **No always-on taste index — by design.** Not even a one-line-per-rule manifest in the prefix; that re-creates the skill tax. Instead the disk *is* the index, queried not loaded. **Importance is promoted upward, not pinned down:** anything that matters enough gets curated (user-driven) into the always-on identity / taste-principle files — and *that* promotion is the only thing that earns a permanent place in context. The long tail stays on disk, retrieved when relevant.
- **Concrete shape:** a parallel taste store next to the fact canon (not inside it), sharded one file per category, with the deterministic tier compiled out to a checks dir:
  ```
  ~/.hive/memory/projects/<name>/taste/
  ├── ideas.md  design.md  implementation.md  test-eval.md  communication.md   # fuzzy units
  └── checks/                                                                   # deterministic, run not read
  ```
  (`runs/{DATE}/taste.md` already exists as the nightly readout — this is its canonized home.)
- **What triggers the pull:** `IMPLEMENTATION` is hook-driven and automatic — a file-edit hook maps the edited path's glob → category → query, so editing `**/*.sql` pulls the SQL units without the agent deciding to look. `COMMUNICATION` triggers similarly off the artifact being written (commit/PR/doc). `DESIGN`/`IDEAS` have no file signal, so they're phase- or agent-requested (the `agent-requested` scope value) — one retrieval call, not N resident descriptions.

## 5. Explicitly out of scope (for the design session to NOT do)
- No learned/parametric reward model for taste (decided against — fickle ground truth + auditability).
- No graph database adoption for the fact store on spec.
- No always-on monolithic rules file (hits the instruction-budget cliff).
- No in-flow interruption by the rigor agent beyond cheap deterministic checks (async by default).

## 6. Open questions for the design session
1. **Transcript access & granularity:** what exactly does Pass A read (raw session JSONL?), and how are events anchored/segmented?
2. **Check artifact format:** do deterministic rules become real linter configs (language-specific), a HIVE-native check DSL, or Semgrep rules? How language-agnostic must this be?
3. **The replay-validation harness:** how many past sessions, how is "would have flagged" operationalized cheaply, what precision/recall thresholds gate promotion?
4. **Scope/activation mechanics (core resolved in §4f):** the retrieval model is settled — deterministic = executed (zero context), fuzzy = BM25 × strength retrieved on demand filtered by category + scope, no always-on index, importance promoted upward into identity files. What's left for the design session: the exact glob→category→query hook wiring, top-K and a relevance floor, and how `DESIGN`/`IDEAS` (no file signal) get triggered reliably.
5. **Curation UX:** how does the human review candidate rules (batch? inline? where?) and how is edit/kill captured back into the lifecycle?
6. **Relationship to existing canon + candidates pipeline:** does the judgment layer reuse the candidates→canon machinery, or run parallel? What changes in the nightly orchestrator passes?
7. **Rigor agent design:** model, cadence, where its "known junior-isms" come from (the canon it applies), and its precision threshold.
8. **Decay/expiry policy:** what makes a rule go stale, and how is "active forgetting" triggered without losing genuinely rare-but-important rules?
9. **Category boundaries (§4c):** the set is fixed at five (`IDEAS`/`DESIGN`/`IMPLEMENTATION`/`TEST_EVAL`/`COMMUNICATION`), process/workflow deliberately excluded (promoted to identity instead). Remaining: does planning/scheduling stay folded into `DESIGN` or break out? How does Pass B assign category reliably, and what happens when a judgment spans two — primary + secondary, or forbid multi-category? (Activation mechanics now live in §4f / Q4.)

## 7. Suggested first design step (smallest test of the whole thesis)
Before building anything: point a single Pass-A+B extraction over a handful of *real* past transcripts and look at the candidate rules it emits, tiered. Ask: *do ≥~30% of these match taste I'd genuinely canonize, or is it noise?* If yes, the mine-corrections-from-sessions premise holds and the rest is engineering. If it's mush, the signal isn't where we think and we rethink before building the stores.

## 8. Lineage / why we trust these directions
- Convergent evolution toward temporal facts + nightly consolidation (Letta sleep-time, OpenAI "Dreaming," Zep, GBrain) validates the nightly-pipeline architecture.
- `ex_slop`/Credo + Semgrep confirm deterministic taste-as-checks works in production.
- Anthropic's constitution (list→reason, hard/soft tiers, deployer layer) is the working template for tiered reasoned policy.
- MAC + Memp + All-Mem supply the lifecycle (validate/dedup/expire) and immutable-evidence patterns flat memory lacks.
- The minimalist/skeptic camp (EMem, Anthropic files+grep, "every clever architecture lost to markdown+bash") sets the build budget: stay plain-text, stay small, prove value first.
