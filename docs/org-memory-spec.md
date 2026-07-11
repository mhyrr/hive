# LOAM — An Institutional Memory System

**Status:** Design spec / v0.1 draft
**Scope:** Beyond HIVE. This describes a multi-user, organization-scale system.
HIVE is the single-user proof of the core dynamics (decay, reinforcement,
verified admission); LOAM generalizes those dynamics to organizations.
"LOAM" is a working codename — soil built from decay, in which things grow.

---

## 1. Thesis

Organizations produce enormous data exhaust — Slack, email, documents, git,
meetings — and almost all tooling treats it as a **lake**: store everything,
rank at query time. That is storage, not memory. Memory is a set of
*dynamics*: things strengthen with use, decay without it, consolidate from
events into principles, and replicate as stories. A system that implements
those dynamics is not a search product; it is a **scientific instrument for
organizations** — it lets you discover questions (Do decisions decay like
human memory? What is this org's decision half-life? Which knowledge dies
when this person leaves?) rather than just answer known ones.

Two claims drive the design:

1. **Memory is tiered, and each tier has different physics.** Episodic
   memory decays and is reinforced by reference. Narrative memory (lore)
   persists by retelling and mutates in transmission. Semantic memory
   (principles) is pinned and dies only by zombie-ism (asserted but not
   enacted). Procedural memory (templates, runbooks) persists by reuse and
   changes by deliberate version bumps. Collapsing these into one store with
   one ranking function loses the structure that makes memory useful.

2. **The end product is context.** Humans browse memory occasionally; agents
   consume it constantly. Every new agent session in an organization today
   starts from zero. LOAM's primary output surface is an MCP server that
   assembles the relevant slice of institutional memory — decisions,
   principles, procedures, cautionary stories — into the context of any
   agent or human starting a piece of work.

---

## 2. Vocabulary (rigorous definitions)

These terms are used consistently throughout the spec and should be used
consistently in the implementation.

### 2.1 Substrate terms

- **Source** — an integrated external system: Slack, Gmail/Google Groups,
  Google Drive, GitHub/GitLab, meeting-transcript providers, ticketing
  systems. Sources are read-mostly; LOAM never mutates a source.

- **Exhaust Event** — an immutable, normalized record ingested from a
  source: one message, one commit, one document revision, one transcript
  segment, one ticket transition. Exhaust events carry `(source, native_id,
  timestamp, actors, content, thread/parent refs)`. The exhaust log is
  append-only and is the system's ground truth; everything above it is
  interpretation and can be recomputed.

- **Actor** — a resolved person (or agent) identity across sources. One
  human may map to a Slack ID, two email addresses, and a GitHub handle;
  actor resolution unifies them. Agents are actors too, flagged as
  non-human (this matters for reinforcement weighting, §5.4).

### 2.2 Memory terms

- **Artifact** — a curated, versioned, editable unit of institutional
  memory, extracted from exhaust or authored by a human. Artifacts are what
  the repository stores, the UI shows, and the MCP serves. Every artifact
  carries **provenance links** to the exhaust events it was derived from.
  Five types, one per memory tier (plus the raw event type):

  | Type | Tier | Example |
  |---|---|---|
  | **Episode** | episodic | "March 2025 outage of the billing service" |
  | **Decision** | episodic | "We chose Postgres over Dynamo for the ledger (2024-11)" |
  | **Story** | narrative | "The time we almost lost Customer X" |
  | **Principle** | semantic | "Never let a customer hear about a problem from someone other than us" |
  | **Procedure** | procedural | The enterprise-renewal email template; the deploy runbook |

  A Decision is an Episode with a resolution: alternatives were live, one
  was selected. Decisions are first-class because they are the unit the
  half-life instrument measures.

- **Reference Event** — a detected occurrence of an artifact being *used*
  inside later exhaust. Reference events are the rehearsal unit — the
  fundamental observable of the whole system. Four subtypes, and the
  subtype distinctions carry the promotion signals:

  - **Citation** — a reference that retains provenance ("we don't deploy
    Fridays *because of the October incident*", a PR linking an ADR).
  - **Assertion** — a reference stripped of provenance ("we don't deploy
    on Fridays", stated as bare fact). The citation→assertion shift is the
    consolidation signature (§5.5).
  - **Retelling** — a narrative recurrence of a Story by an actor who was
    not a participant in the underlying episode. The retelling-by-
    non-participants rate is the lore signature.
  - **Instantiation** — a use of a Procedure (template filled in, runbook
    executed), with a computed **divergence** from the canonical version.

- **Activation** — the computed strength of an artifact, per §5. Determines
  retrieval ranking, context-pack inclusion, and archival eligibility.

- **Dispersion** — the second dimension of strength: how many *distinct
  actors* (and distinct teams) generate an artifact's reference events.
  High-frequency/low-dispersion is a bus factor; moderate-frequency/
  high-dispersion is institutional knowledge.

### 2.3 Dynamics terms

- **Consolidation** — the promotion of an episodic artifact toward the
  semantic tier, detected via provenance loss (citation→assertion ratio).
- **Ratification** — the explicit human ceremony that pins a Principle.
  Consolidation is detected; ratification is decided.
- **Amendment** — the deliberate, expensive modification of a pinned
  Principle (constitutional change, not ordinary edit).
- **Enactment Gap** — divergence between what Principles assert and what
  exhaust shows the org doing. The zombie-principle detector.
- **Divergence Pressure** — accumulated variance across Instantiations of a
  Procedure; the signal that the canonical version needs a revision.
- **Resurrection** — a reference-event hazard spike on a dormant artifact.
  Tracked explicitly: resurrected artifacts mark knowledge the org needed
  but let decay.
- **Context Pack** — an assembled, budgeted bundle of artifacts served to
  an agent or human at the start of a piece of work (§8).

---

## 3. System architecture

Seven layers. Data flows up; governance and reinforcement flow down.

```
┌─────────────────────────────────────────────────────────────────┐
│  7. INSTRUMENTS      survival curves · drift reports · fragility │
│                      tier-flux dashboard · lore census           │
├─────────────────────────────────────────────────────────────────┤
│  6. ACCESS           MCP server (agents) · Web UI (humans)       │
│                      Search API · Context Pack assembler         │
├─────────────────────────────────────────────────────────────────┤
│  5. GOVERNANCE       candidate queue · verifier · ratification   │
│                      lifecycle verbs · trust & visibility        │
├─────────────────────────────────────────────────────────────────┤
│  4. DYNAMICS ENGINE  activation (decay × reinforcement ×         │
│                      dispersion) · promotion detectors           │
│                      (provenance loss, teller diversity,         │
│                      copy divergence, enactment gap)             │
├─────────────────────────────────────────────────────────────────┤
│  3. REPOSITORY       versioned artifact store · provenance graph │
│                      reference-event log · embeddings/BM25 index │
├─────────────────────────────────────────────────────────────────┤
│  2. EXTRACTION       artifact extraction (LLM passes) · entity   │
│                      resolution · reference-event detection      │
├─────────────────────────────────────────────────────────────────┤
│  1. INGESTION        connectors: Slack · email · Drive · git ·   │
│                      meetings · tickets → normalized exhaust log │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 Layer 1 — Ingestion

Connectors per source, each producing normalized Exhaust Events into an
append-only log. Requirements:

- **Backfill + streaming.** Every connector must support both a historical
  backfill (for initialization, §7) and incremental sync (webhooks/polling).
- **Timestamps are sacred.** All dynamics are time-functions; backfilled
  events keep their original timestamps so history can be *replayed*
  through the dynamics engine, not just indexed.
- **Actor resolution at the edge.** Connectors emit native actor IDs; a
  resolution service maps them to unified Actors, with a human-reviewable
  merge queue for ambiguous cases.
- **Consent and scope per source.** Each connector declares what it reads
  (channels, labels, folders, repos) and that declaration is visible to the
  whole org (§9). No silent expansion of scope.

Initial connector set, in priority order: **git/GitHub** (highest
signal-to-noise: commits, PRs, ADRs, issues), **Slack** (highest volume,
richest lore), **Google Drive/Docs** (procedures live here), **meeting
transcripts**, **email/Groups** (last — worst consent story, most noise).

### 3.2 Layer 2 — Extraction

LLM pipelines that turn exhaust into candidate artifacts and detect
reference events. Three distinct jobs:

1. **Artifact extraction.** Batch passes over exhaust windows proposing
   candidate Episodes, Decisions, Stories, Procedures. Decision extraction
   looks for commitment markers ("we're going with", "decided:", merged
   ADRs, closed RFC threads). Story extraction looks for narrative
   recurrence clusters (§5.6). Procedure extraction looks for high-frequency
   near-duplicate reuse (templates, checklists).

2. **Entity resolution (the hard 80%).** The same decision is phrased
   twenty ways across three systems. Candidate artifacts are embedded and
   clustered against existing artifacts; merges above a confidence
   threshold are automatic, below it they queue for the verifier. Every
   merge is recorded (reversible) and merged artifacts pool their
   reference-event histories.

3. **Reference-event detection.** A continuous pass over new exhaust that
   matches mentions against the artifact index and classifies each hit as
   Citation / Assertion / Retelling / Instantiation. This detector is the
   instrument's sensor; its precision matters more than its recall
   (a noisy rehearsal signal corrupts every downstream dynamic). It runs
   with the artifact's known aliases + embedding similarity + an LLM
   adjudication step for borderline hits.

Extraction never writes canon directly. Everything it produces enters the
governance layer as a **candidate** (§6) — this is the HIVE Pass-V pattern
scaled up, and it is the design's most important trust property: *chatter
and canon are structurally distinguishable because canon has exactly one
admission path.*

### 3.3 Layer 3 — Repository

The artifact store. Properties:

- **Versioned.** Every artifact is an append-only sequence of revisions
  (git-like). Human edits, extraction updates, merges, and lifecycle
  transitions are all revisions with authorship and rationale. Nothing is
  destructively edited.
- **Provenanced.** Every artifact revision links to the exhaust events
  that justify it. Every claim in the system can be traced to primary
  sources. This is what makes the instrument scientific rather than
  vibes-with-a-database.
- **Trackable.** The reference-event log is stored alongside artifacts,
  per-artifact, time-ordered — this *is* the dataset for survival analysis.
- **Editable.** Humans can correct, annotate, split, and merge artifacts
  through the UI. Human edits are high-trust revisions but still flow
  through the same versioned model.
- **Searchable.** Dual index: BM25 for lexical, embeddings for semantic,
  fused at query time. Retrieval results are activation-weighted (§5), not
  just relevance-weighted — this is the core departure from a search
  product.

Storage sketch: exhaust log in cheap append-only storage (object store +
columnar index); artifacts + reference events + provenance graph in
Postgres; vector index alongside. Nothing exotic required — the novelty is
in the dynamics, not the storage.

### 3.4 Layer 4 — Dynamics engine

Computes activation and runs the promotion detectors. Specified fully in §5.
Runs as scheduled passes (nightly, like HIVE's pipeline) plus incremental
updates on reference-event arrival.

### 3.5 Layer 5 — Governance

The lifecycle verbs (§6), the candidate→verified→canon admission pipeline,
ratification ceremonies, and the trust/visibility model (§9).

### 3.6 Layer 6 — Access

Three surfaces over one retrieval core:

- **MCP server** — the primary surface (§8). Agents get context packs and
  search; agent recalls feed reinforcement (damped).
- **Web UI** — browse/search artifacts; per-artifact page showing content,
  version history, provenance, reference-event timeline (a sparkline of
  its activation over time — every artifact wears its own survival curve);
  governance queues (candidates awaiting review, principles awaiting
  ratification, procedures flagged for divergence); the instrument
  dashboards.
- **Search API** — programmatic access for anything that isn't an agent
  or a browser.

### 3.7 Layer 7 — Instruments

Standing reports computed from the reference-event log. These are the
"graphs and markdown" — the scientific-instrument output (§10).

---

## 4. Data model

### 4.1 Artifact (common envelope)

```
Artifact {
  id: uuid
  type: Episode | Decision | Story | Principle | Procedure
  status: candidate | active | pinned | deprecated | archived
  title: string
  body: markdown                    // current revision content
  revisions: [Revision]             // full history
  provenance: [ExhaustEventRef]     // primary sources
  aliases: [string]                 // for reference-event detection
  actors: [ActorRef]                // participants/owners
  scope: OrgScope                   // org / team / project visibility
  created_at, occurred_at: timestamp  // extraction vs. real-world time

  // dynamics state (recomputed, not authored)
  activation: float
  half_life: duration
  recall_count: float               // reinforcement-weighted (§5.4)
  dispersion: { actors: int, teams: int }
  last_referenced_at: timestamp
}
```

### 4.2 Per-type extensions

```
Decision  += { question, alternatives[], resolution, decided_at,
               supersedes?: DecisionRef,
               consolidation: { citation_rate, assertion_rate } }

Story     += { participants[], moral?: string,
               retellings: { count, distinct_tellers, non_participant_tellers },
               linked_principle?: PrincipleRef }

Principle += { ratified_by[], ratified_at, source_story?: StoryRef,
               source_decisions[]: DecisionRef,
               enactment: { asserted_rate, violation_rate, gap_trend } }

Procedure += { canonical_version: rev, owner: ActorRef,
               instantiations: { count, divergence_mean, divergence_trend },
               review_due?: timestamp }
```

### 4.3 Reference Event

```
ReferenceEvent {
  id, artifact_id, exhaust_event_id
  at: timestamp
  actor: ActorRef                   // + is_agent flag
  kind: citation | assertion | retelling | instantiation
  confidence: float                 // detector confidence
  divergence?: float                // instantiations only
  context_span: text                // the matched excerpt, for audit
}
```

The `(artifact_id, at, actor, kind)` stream is the instrument's raw data.
Everything in §10 is a query over this table.

---

## 5. Dynamics (the physics per tier)

### 5.1 Activation (episodic tier)

Extends HIVE's model (ACT-R base-level activation, approximately):

```
activation = 0.5^(age / half_life) × (1 + log2(recall_count + 1))
                                   × dispersion_factor
```

- `age` = time since `last_referenced_at`.
- Each reference event extends `half_life` (spaced rehearsal flattens the
  curve), capped at a max.
- `dispersion_factor = 1 + β·log2(distinct_actors)` — knowledge rehearsed
  across many people is institutionally stronger than the same count from
  one person. β tunable; start small (0.3).

Counters are periodically halved TinyLFU-style as a backstop against
unbounded accumulation, which keeps the store *usage-shaped*: the
retention policy is demonstrated usefulness, and forgetting is a feature
(episodic artifacts below an activation floor move to `archived` — still
stored, excluded from default retrieval and context packs, always
resurrectable).

### 5.2 Narrative tier

Stories do not decay on the episodic clock; their vital sign is
**retelling by non-participants**. A Story's health =
`f(distinct_tellers, non_participant_teller_share, recency of last
retelling)`. A story whose only teller left the company is flagged
**endangered lore** — surfaced to humans as "this story is about to die;
write it down or let it go."

### 5.3 Semantic tier

Principles have no decay term. Their health is the **enactment gap**:
`asserted_rate` vs. `violation_rate` (violations detected by the reference
detector finding exhaust that contradicts the principle — the hardest
detector, shipped last, human-flagging first). A widening gap flags a
**zombie principle** and opens a Challenge (§6.3).

### 5.4 Reinforcement weighting

Not all recalls are equal:

| Recall source | Weight | Rationale |
|---|---|---|
| Organic exhaust reference (human) | 1.0 | the true signal |
| Explicit human lookup in UI | 0.5 | interest, weaker than use |
| Agent retrieval via MCP | 0.1–0.25 | damped hard — agents retrieve promiscuously; undamped agent recall would let retrieval frequency manufacture institutional importance (observer effect) |
| Context-pack auto-inclusion | 0.05 | presence ≠ use |

If an agent's retrieval demonstrably flows into an outcome (cited in a
merged PR, quoted in a sent doc), the downstream *organic* reference event
carries the weight — the loop closes through reality, not through the
retriever.

### 5.5 Promotion detector: provenance loss (episodic → semantic)

For each Decision, track the citation:assertion ratio over a sliding
window. Consolidation signature: assertion share rises past a threshold
(e.g. >70%) while dispersion is high (≥N actors, ≥M teams) and the
artifact has survived ≥T months. Firing the detector does **not** create a
Principle — it **nominates** one into the ratification queue with the
evidence attached. Detection is automatic; pinning is human (§6.3).

### 5.6 Promotion detector: teller diversity (episodic → narrative)

Cluster narrative recurrences (semantic near-duplicates of an episode's
telling) and score teller diversity. Signature: the same story told by
actors who were not participants, across time. Fires a nomination to
canonize a Story artifact with the retelling cluster as provenance.

### 5.7 Pressure detector: copy divergence (procedural)

For each Procedure, embed instantiations and measure divergence from the
canonical version. Rising `divergence_trend` fires a **revision flag** to
the Procedure's owner: "reality has forked from the canonical version;
here are the three variant clusters." Genotype/phenotype: mutations
accumulating in the copies are selection pressure on the template.

### 5.8 Resurrection detection

A reference-event hazard spike on an artifact dormant > K half-lives is
logged as a Resurrection. Resurrections get an activation bonus (the org
demonstrably needed this) and feed the decay-calibration instrument —
frequent resurrections in a category mean decay is tuned too aggressively
there.

---

## 6. Lifecycle verbs (governance)

Every artifact type has a small, closed set of verbs. Verbs are the only
way state changes; every verb application is a revision with an actor and
rationale. **One admission path into canon** (the HIVE Pass-V property):
extraction and agents can only *propose*; the verifier and humans *admit*.

### 6.1 Common verbs

| Verb | Actor | Effect |
|---|---|---|
| `propose` | extractor, agent, human | create candidate |
| `verify` | verifier (LLM, high-effort) + spot-checked by humans | candidate → active; checks provenance actually supports the claim, dedups against existing canon |
| `edit` | human | new revision |
| `merge` / `split` | verifier or human | entity-resolution corrections |
| `archive` | dynamics engine (episodic only) or human | below activation floor; excluded from default retrieval; reversible |
| `resurrect` | dynamics engine | dormant artifact re-referenced |

### 6.2 Decision verbs

`decide` (record resolution) · `supersede` (new decision replaces old —
the old one stays, linked; superseded decisions still matter for the
instrument) · `reopen` (a settled decision back under debate — reopen
frequency is itself a health metric).

### 6.3 Principle verbs (the constitutional tier)

- `nominate` — fired by the consolidation detector or a human; enters the
  ratification queue with evidence (source decisions, assertion trend,
  dispersion).
- `ratify` — explicit human ceremony; requires named ratifiers with
  authority (configurable: leadership sign-off, or team quorum for
  team-scoped principles). Pins the artifact. **Deliberately expensive.**
- `challenge` — opened by the enactment-gap detector or any human:
  "asserted but not enacted." A challenge forces re-episodization — the
  principle must be re-justified from current evidence.
- `amend` / `retire` — resolution of a challenge or a deliberate change;
  same ceremony weight as ratify. Two-tier commitment cost is what keeps
  the pinned set small: if everything is pinned, nothing is.

### 6.4 Story verbs

`canonize` (retelling cluster → curated Story, human writes/blesses the
canonical telling) · `link` (attach Story to the Principle it teaches) ·
`flag_endangered` (dynamics: tellers gone or retellings stopped).

### 6.5 Procedure verbs

`register` (with owner) · `instantiate` (detected, not invoked) ·
`flag_divergence` (dynamics → owner) · `revise` (owner bumps canonical
version, with diff + rationale) · `deprecate`.

---

## 7. Initialization (the cold-start inference pass)

Standing LOAM up against an existing org is not indexing — it is
**replaying history through the dynamics engine**. Because backfilled
exhaust keeps original timestamps, on day one the instrument already has
years of longitudinal data. Sequence:

1. **Backfill** — connectors ingest full available history (git first:
   cleanest, most consented, best-timestamped).
2. **Extract** — batch artifact extraction over the whole timeline,
   producing candidates in historical order.
3. **Resolve** — entity resolution across the full candidate set (done in
   bulk, this is cheaper and more accurate than incremental — the whole
   timeline is visible at once).
4. **Replay** — run the reference-event detector across history in time
   order, then compute activation trajectories *as they would have evolved*.
   Artifacts that decayed and resurrected show it; decisions dead in weeks
   are already archived; long-lived decisions arrive pre-strengthened.
5. **The Reveal** — before anyone curates anything, generate the inaugural
   report: *here is what your organization remembers.* Top-activation
   decisions; the five stories with highest non-participant retelling
   (the lore census); nominated principles with their consolidation
   evidence; procedures with highest divergence pressure; endangered
   knowledge (high activation, dispersion = 1, that actor is gone or
   leaving). This is the demo, the validation of the extraction pipeline,
   and the seed of the ratification queue all at once.
6. **Ratification bootstrap** — leadership works the nominated-principles
   queue; teams claim procedure ownership. The org's constitution is
   ratified from evidence rather than aspiration — which makes the initial
   enactment gaps visible immediately, and that is the honest starting
   point.

---

## 8. MCP surface (agents are the point)

Every agent session in the org should start warm. The MCP server is the
delivery mechanism for "all the memory and decisions that came before as
a starting point."

### 8.1 Context packs

`get_context_pack(task_description, scope?, budget_tokens?)` — the flagship
tool. Assembly:

1. Embed + BM25 the task description against the artifact index.
2. Rank by `relevance × activation` (the departure from plain RAG:
   institutionally-alive knowledge outranks equally-relevant dead
   knowledge).
3. Fill a budgeted pack in fixed tier order:
   - **Principles** in scope — always included, cheap (small pinned set —
     this is why the pinned set must stay small);
   - **Decisions** touching the task's entities — with resolutions and
     supersede chains, so the agent doesn't relitigate settled questions
     or, worse, resurrect a superseded choice;
   - **Procedures** matching the work type — canonical versions;
   - **Stories** linked to the in-scope principles — one or two,
     compressed; a cautionary tale is often the highest-density guidance
     an agent can get;
   - **Episodes** — remaining budget, by ranked activation.
4. Every item carries its provenance refs so the agent can cite, and its
   artifact id so downstream references are detectable.

Pack inclusion logs a 0.05-weight reference event per artifact (§5.4).

### 8.2 Other tools

```
search_memory(query, types?, scope?, include_archived?)
get_artifact(id)                      // full body + provenance + history
list_principles(scope)                // the constitution, always cheap
get_procedure(name_or_task)           // canonical version, always current
propose_artifact(type, body, provenance_refs)   // agents PROPOSE only —
                                      // candidates, never canon (§6)
record_outcome(artifact_ids[], exhaust_ref)     // close the loop: agent
                                      // work that shipped cites what it used
```

Symmetry with HIVE is deliberate: `get_context_pack` generalizes HIVE's
session-start identity/memory injection; `propose_artifact` generalizes
`write_hive_memory`'s candidates queue; `search_memory` keeps its
retrieval-strengthening side effect, damped per §5.4.

### 8.3 Session-start integration

For harnesses that support hooks (Claude Code SessionStart, etc.), a thin
client injects `list_principles + get_context_pack(repo/task inferred)`
at session start — the HIVE `load-identity.sh` pattern, pointed at org
memory instead of personal identity.

---

## 9. Trust, consent, and the observer effect

Three failure modes will kill this system faster than any technical flaw:

1. **Surveillance perception.** An instrument leadership points at
   employees reads as monitoring; the same instrument offered as a mirror
   the whole org can query reads as memory. Design stance: **symmetric
   visibility** — anyone whose exhaust is ingested can query the system,
   see exactly which sources/channels are in scope, and see their own
   contribution surface. No leadership-only analytics over individuals.
   Instruments report on artifacts and aggregates, not on people
   (dispersion counts actors; fragility reports name knowledge at risk,
   and naming the person is opt-in policy, off by default).
2. **Scope creep.** Connector scopes are declared, org-visible, and
   changes are announced. DMs and private channels are out by default,
   forever, unless a channel's members opt in.
3. **Goodharting.** Once reference counts matter, people can perform
   references. Mitigations: dispersion-weighting (self-citation doesn't
   compound), organic-vs-lookup weighting, and — mostly — not attaching
   individual incentives to memory metrics. The instrument measures the
   organization, not employees.

Agents are actors with the lowest reinforcement weight (§5.4) precisely so
that heavy agent adoption doesn't distort the org's memory of itself.

---

## 10. Instruments (the science)

Standing queries over the reference-event log, output as graphs + markdown
(reports first; dashboards later):

- **Decision survival.** Kaplan-Meier curves over decision reference
  lifetimes; clusters = died-in-weeks / lived-for-years / resurrected.
  Headline stat: **the org's decision half-life** — plausibly a stable
  org-level trait and a proxy for institutional coherence. The founding
  hypothesis test: do the curves fit the power-law-with-rehearsal shape of
  human memory (Anderson & Schooler), or do they deviate — and how?
- **Lore census.** Ranked stories by non-participant retelling; endangered
  lore list.
- **Fragility report.** High-activation artifacts with dispersion = 1
  (single rehearser): the pre-attrition bus-factor map. Computable *before*
  the departure happens.
- **Drift report.** Month-over-month movement of vocabulary, priorities,
  and entity attention in exhaust — measured *relative to the org's own
  pinned principles and stated priorities*, so it reports the enactment
  gap's derivative, not just embedding noise.
- **Tier flux dashboard.** Size and flow rates of each tier. Pathologies
  are legible as imbalances: everything pinned (sclerosis) · no lore layer
  (endless relitigation — visible directly as `reopen` frequency) · high
  procedural divergence (process theater) · episodic hoarding with no
  archival (the naive data lake this design exists to reject).
- **Latent-variable workbench** (aspirational, honest). Candidate
  compressed features (decision half-life, lore density, reopen rate,
  divergence pressure, drift velocity) regressed against *pre-declared*
  outcome variables (retention, cycle time, incident rate, renewals) —
  predictions registered forward in time, required to beat dumb baselines
  (headcount growth, tenure mix). Factor analysis always finds factors;
  the bar is out-of-sample prediction and convergence across measurement
  methods. "Institutional Momentum" is only real if it clears that bar.

---

## 11. What LOAM is not

- **Not a data lake.** Retention is usage-shaped; forgetting is a feature.
- **Not a search product.** Retrieval is activation-weighted; the ranking
  function encodes institutional aliveness, not just relevance.
- **Not an analytics-on-people tool.** Instruments measure artifacts and
  aggregates; symmetric visibility is a design invariant.
- **Not autonomous canon.** LLMs extract, detect, and nominate; only the
  verifier admits and only humans ratify. One admission path.

## 12. Open questions

1. **Reference-event detector precision** is the load-bearing sensor. What
   precision is achievable on Assertions (provenance-stripped references)
   at acceptable cost? This should be the first thing prototyped —
   plausibly against this repo + its session logs, a single-org corpus
   with full consent.
2. **Entity resolution of decisions** across phrasings/systems is the hard
   80%. Bulk (init) is tractable; incremental at what accuracy?
3. **Violation detection** for the enactment gap — hardest detector; ship
   human-flagging first and treat automated detection as research.
4. **Scoping model** — org vs. team vs. project memory: is scope a single
   field, or do teams get federated stores with a promotion path to org
   canon (a tier *within* a tier)?
5. **Does the decay math transfer?** Human-memory constants (half-lives,
   boost sizes) are the starting point, but the initialization replay (§7)
   yields the data to fit org-specific constants empirically. The
   instrument calibrates itself — if the org's actual reference curves
   don't fit, that misfit is finding #1.
