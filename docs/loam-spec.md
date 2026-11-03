# LOAM Specification

**Version:** 0.2.0-draft
**Status:** Pre-implementation specification
**Repository:** This document is the founding specification for a standalone
system and is written to be lifted verbatim into its own repository as
`SPEC.md`. It has no dependencies on any other project.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

---

## 1. Scope

LOAM is an institutional memory system for organizations. It ingests an
organization's communication and work exhaust (chat, email, documents,
version control, meeting transcripts), extracts durable memory artifacts
from it, and maintains those artifacts under memory dynamics — decay,
reinforcement, consolidation, and versioned change — rather than static
storage. Its primary consumers are AI agents (via MCP) and humans (via UI
and reports).

LOAM is simultaneously:

1. **A memory system** — retrieval ranked by institutional aliveness, not
   just relevance.
2. **A context provider** — every agent session in the organization starts
   with the relevant decisions, principles, procedures, and cautionary
   stories already in context.
3. **A scientific instrument** — the reference-event log it accumulates
   supports longitudinal measurement of the organization itself (decision
   half-life, knowledge fragility, cultural drift).

The economics rest on a separation: **intelligence is rented; memory is
owned.** Intelligence is a commodity input with collapsing prices and
short generations. Memory-with-provenance is the durable complementary
asset — each improvement in rented intelligence raises the value of owned
memory, because the trace is what makes memory forward-compatible with
intelligence. A conclusion stored without provenance caps every future
reader at trusting it; a conclusion stored with its evidence path can be
re-derived, corrected, and connected by readers smarter than its writer.
Hence a standing rule: compression MAY be lossy in content but MUST be
lossless in pointers — an artifact's body may shrink, its path back to
the exhaust may not. A black box is frozen at the intelligence of
whatever wrote it; an explainable one is re-readable at the intelligence
of whatever reads it next.

### 1.1 Model agnosticism

LOAM is a harness for the organization, not an application of any particular
model. This is a conformance requirement:

- Every LLM-backed role (extractor, adjudicator, verifier, entity resolver)
  MUST be a pluggable interface with a per-role model binding in
  configuration. Roles are independently swappable — a cheap model for
  triage, a strong model for verification — and replaceable as model
  generations turn over.
- Artifacts, Reference Events, and all dynamics state are plain data. No
  schema, activation computation, or promotion detector may depend on any
  model's internals, embeddings format, or provider. Embedding vectors are
  treated as a rebuildable index, never as canonical state — the system
  MUST be able to re-embed the corpus under a new model without loss.
- The memory MUST outlive any model. Everything above the Exhaust Log is
  recomputable (§4.3); a full model swap is a reprocessing job, not a
  migration of meaning.
- The MCP surface serves any consumer. Context packs are model-neutral
  text + provenance; nothing in them assumes a particular agent harness.

Corollary (informative): the organization's memory compounds in value as
models improve — better extractors reprocess the same exhaust log and find
more; longer contexts consume bigger packs. A model-coupled design would
instead depreciate with each model generation. The empirical record backs
this: domain-pretrained models (e.g. BloombergGPT) have repeatedly been
eclipsed within months by next-generation general models plus retrieval —
the half-life of a custom-trained model is shorter than the model
generation cycle.

Framing (informative): LOAM is training in **data-space** rather than
weight-space. Consolidation compresses many episodes into stable priors
(gradient descent's job); decay and counter-halving are regularization
and forgetting; ratification is human feedback on what gets learned;
supersede is a weight update with a changelog. The artifact store is the
organization's model of itself — but every "parameter" is a readable,
versioned artifact with provenance, and the base LLM is a rented,
upgradeable reasoning engine it plugs into. This is why traceability is
structural rather than aspirational: in weight-space, credit assignment
("why does the model believe this?") is an open interpretability problem;
in data-space, it is a provenance link.

### 1.2 Non-goals

- LOAM is **not a data lake**. Retention is usage-shaped; forgetting is a
  specified behavior, not a failure.
- LOAM is **not a search product**. Relevance is one factor in ranking;
  activation (§6) is the other.
- LOAM is **not a people-analytics tool**. Instruments report on artifacts
  and aggregates. Per-individual reporting is prohibited by invariant
  (§11).
- LOAM does **not write to source systems**. All connectors are read-only.
- LOAM does **not autonomously create canon**. Machine output is always a
  candidate; admission requires the verifier, and pinning requires humans
  (§8).

---

## 2. Terminology

The following terms are normative. Implementations MUST use them with
these meanings in code, schemas, and documentation.

| Term | Definition |
|---|---|
| **Source** | An integrated external system (Slack, Gmail, Google Drive, GitHub, meeting transcripts, ticketing). |
| **Exhaust Event** | An immutable normalized record ingested from a Source: one message, commit, document revision, transcript segment, or ticket transition. |
| **Exhaust Log** | The append-only store of all Exhaust Events. Ground truth; everything above it is derived and recomputable. |
| **Actor** | A resolved identity (human or agent) unified across Sources. |
| **Artifact** | A curated, versioned unit of institutional memory. One of six types: Episode, Decision, Story, Principle, Procedure, Fact. |
| **Tier** | The memory class an Artifact type belongs to: episodic (Episode, Decision), narrative (Story), semantic (Principle, Fact), procedural (Procedure). Each tier has distinct dynamics (§6). |
| **Provenance** | Links from an Artifact revision to the Exhaust Events that justify it. |
| **Reference Event** | A detected use of an Artifact within later exhaust. Kinds: Citation, Assertion, Retelling, Instantiation (§5.3). The system's fundamental observable. |
| **Activation** | Computed strength of an Artifact (§6.1). Determines ranking, context-pack inclusion, and archival. |
| **Dispersion** | Count of distinct Actors (and distinct teams) producing an Artifact's Reference Events. |
| **Consolidation** | Detected promotion pressure from episodic toward semantic tier, signaled by provenance loss (§6.5). |
| **Ratification** | The explicit human act that pins a Principle. |
| **Enactment Gap** | Divergence between what a Principle asserts and what exhaust shows the organization doing. |
| **Divergence Pressure** | Accumulated variance between a Procedure's canonical version and its observed Instantiations. |
| **Resurrection** | Reference activity on an Artifact dormant longer than a threshold (§6.8). |
| **Context Pack** | A token-budgeted bundle of Artifacts assembled for an agent or human at the start of a piece of work (§9.2). |
| **Candidate** | An Artifact proposed by extraction, an agent, or a human, not yet admitted to canon. |
| **Canon** | The set of Artifacts with status `active` or `pinned`. |

---

## 3. Architecture

Seven components. Data flows upward; governance and reinforcement flow
downward. Components MUST communicate only through the interfaces
specified here, so that any component can be reimplemented independently.

```
┌────────────────────────────────────────────────────────────────┐
│ 7 INSTRUMENTS   survival · fragility · drift · lore · tier flux │
├────────────────────────────────────────────────────────────────┤
│ 6 ACCESS        MCP server · Web UI · Search API                │
├────────────────────────────────────────────────────────────────┤
│ 5 GOVERNANCE    candidate queue · verifier · lifecycle verbs    │
├────────────────────────────────────────────────────────────────┤
│ 4 DYNAMICS      activation · detectors (consolidation, teller   │
│                 diversity, divergence, enactment gap)           │
├────────────────────────────────────────────────────────────────┤
│ 3 REPOSITORY    versioned artifacts · provenance graph ·        │
│                 reference-event log · lexical + vector index    │
├────────────────────────────────────────────────────────────────┤
│ 2 EXTRACTION    artifact extraction · entity resolution ·       │
│                 reference-event detection                       │
├────────────────────────────────────────────────────────────────┤
│ 1 INGESTION     connectors → normalized exhaust log             │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. Component requirements

### 4.1 Ingestion

- Each connector MUST support **backfill** (full available history) and
  **incremental sync** (webhook or polling).
- Exhaust Events MUST preserve original source timestamps. Backfilled
  history MUST be replayable through the Dynamics component in time order
  (§12).
- The Exhaust Log MUST be append-only. Corrections are new events, never
  edits. Source-side deletions (e.g. GDPR erasure) MUST be honored by
  tombstoning the event content while retaining the event ID.
- Connectors MUST declare their read scope (channels, labels, folders,
  repos) in a machine-readable manifest visible to all Actors (§11).
  Scope changes MUST be recorded and announced.
- Actor resolution: connectors emit native identities; a resolution
  service MUST map them to unified Actors, with a human-reviewable merge
  queue for ambiguous mappings. Actor records MUST carry an `is_agent`
  flag.
- Connector priority for initial implementation: (1) GitHub/git,
  (2) Slack, (3) Google Drive/Docs, (4) meeting transcripts,
  (5) email/Groups.

### 4.2 Extraction

Three pipelines, all LLM-backed, all producing **candidates only**:

1. **Artifact extraction** — batch passes over exhaust windows proposing
   Episodes, Decisions, Stories, Procedures, and Facts. Decision
   extraction keys on commitment markers (resolution language, merged
   ADRs, closed RFCs). Story extraction keys on narrative-recurrence
   clusters. Procedure extraction keys on high-frequency near-duplicate
   reuse. Fact extraction keys on recurring descriptive claims asserted
   across actors without a decision event behind them.
2. **Entity resolution** — candidate artifacts MUST be clustered against
   existing artifacts (embedding + lexical). Merges above a confidence
   threshold are automatic; below it they queue for the verifier. All
   merges MUST be recorded and reversible. Merged artifacts pool their
   Reference Event histories.
3. **Reference-event detection** — a continuous pass over new exhaust
   matching against the artifact index (aliases + embedding similarity,
   with LLM adjudication for borderline matches) and classifying each hit
   per §5.3. The detector MUST record its confidence and the matched text
   span on every Reference Event. Detection quality targets are **per
   kind, for both precision AND recall**, measured against the Phase 0
   labeled benchmark (§13): the four kinds have very different lexical
   signatures (citations are explicit; assertions are bare restatements),
   so a single precision floor hides asymmetric recall. Targets are
   tunable parameters with defaults: precision ≥ 0.85 per kind; recall
   MUST be measured and published per kind even where no floor is set,
   because measured recall is a correction input to §6.5. Recall
   correction factors MUST be recalibrated whenever the detector or its
   model binding changes, and on the §10.6 calibration cadence.

Extraction pipelines MUST NOT write to canon. Their sole output channel is
the candidate queue (§8).

### 4.3 Repository

- Artifacts MUST be stored as append-only revision sequences. Human edits,
  extraction updates, merges, and lifecycle transitions are all revisions
  carrying `(actor, timestamp, rationale)`.
- Every artifact revision MUST carry provenance links to Exhaust Events.
  An artifact with empty provenance MUST NOT pass verification unless
  human-authored with an explicit rationale.
- The Reference Event log MUST be queryable per-artifact in time order.
- Retrieval MUST fuse lexical (BM25) and vector search, then rank by
  `relevance × activation` (§6.1). A `include_archived` flag exposes
  archived artifacts; they MUST be excluded by default.
- Reference storage baseline: exhaust log in object storage with a
  columnar index; artifacts, reference events, and the provenance graph in
  a relational store; vector index alongside. Implementations MAY vary;
  the interfaces above are what is normative.

### 4.4 Dynamics

Specified fully in §6. MUST run as (a) scheduled full passes (default
nightly) recomputing activation and running detectors, and (b) incremental
updates on Reference Event arrival.

### 4.5 Governance

Specified fully in §8.

### 4.6 Access

Three surfaces over one retrieval core:

- **MCP server** (§9) — primary surface.
- **Web UI** — MUST provide: artifact browse/search; a per-artifact page
  showing current body, revision history, provenance, and the
  reference-event timeline rendered as an activation sparkline; the
  governance queues (candidates, ratification, challenges, divergence
  flags); the instrument reports (§10).
- **Search API** — programmatic equivalent of UI search.

### 4.7 Instruments

Standing queries over the Reference Event log (§10). Output format:
generated reports (markdown + charts) first; interactive dashboards MAY
follow. Every instrument MUST be reproducible from the exhaust log alone.

---

## 5. Data model

Schemas are given in pseudo-JSON. Field names are normative; wire/storage
encodings are implementation-defined.

### 5.1 ExhaustEvent

```
ExhaustEvent {
  id: uuid
  source: string            // connector id
  native_id: string         // id within the source
  at: timestamp             // original source timestamp (REQUIRED)
  actors: [ActorRef]
  kind: string              // message | commit | doc_revision | transcript_segment | ticket_event
  content: text | tombstone
  thread_ref?: ExhaustEventRef
}
```

### 5.2 Artifact (common envelope)

```
Artifact {
  id: uuid
  type: episode | decision | story | principle | procedure | fact
  status: candidate | active | pinned | deprecated | archived
  title: string
  body: markdown                    // current revision
  revisions: [Revision]             // append-only
  provenance: [ExhaustEventRef]
  aliases: [string]                 // feeds reference detection
  actors: [ActorRef]
  scope: ScopeRef                   // org | team:<id> | project:<id>
  occurred_at: timestamp            // real-world time
  created_at: timestamp             // extraction/authoring time

  // dynamics state — recomputed, never authored:
  activation: float
  half_life: duration
  recall_weight: float              // reinforcement-weighted recall sum (§6.4)
  dispersion: { actors: int, teams: int }
  last_referenced_at: timestamp
}

Revision {
  rev: int
  actor: ActorRef
  at: timestamp
  verb: string                      // the lifecycle verb that produced it (§8)
  rationale: string
  body: markdown
  provenance_delta: [ExhaustEventRef]
}
```

### 5.3 ReferenceEvent

```
ReferenceEvent {
  id: uuid
  artifact_id: uuid
  exhaust_event_id: uuid
  at: timestamp
  actor: ActorRef                   // carries is_agent
  kind: citation | assertion | retelling | instantiation
  confidence: float                 // detector confidence, [0,1]
  divergence?: float                // instantiation only, [0,1]
  context_span: text                // matched excerpt, for audit
}
```

Kind semantics (normative):

- **citation** — the reference retains provenance: the originating episode
  or document is named or linked.
- **assertion** — the reference is stated as bare fact, provenance
  stripped.
- **retelling** — a Story's narrative recurs, told by an Actor who was not
  a participant in the underlying episode. Only valid for `story`
  artifacts (or episodic artifacts under narrative-promotion evaluation).
- **instantiation** — a Procedure is used (template filled, runbook
  executed). MUST carry `divergence`: a normalized distance between the
  instantiation and the Procedure's canonical version.

One Exhaust Event MAY yield multiple Reference Events — a message citing
two Decisions produces two, each with its own matched span.

### 5.4 Type extensions

```
Decision += {
  question: string
  alternatives: [string]
  resolution: string
  decided_at: timestamp
  supersedes?: ArtifactRef          // prior decision this replaces
  consolidation: {                  // maintained by Dynamics
    citation_rate: float            // sliding-window rates
    assertion_rate: float
  }
}

Story += {
  participants: [ActorRef]
  moral?: string
  retellings: { count: int, distinct_tellers: int, non_participant_tellers: int }
  teaches?: ArtifactRef             // linked Principle
}

Principle += {
  ratified_by: [ActorRef]
  ratified_at: timestamp
  sources: [ArtifactRef]            // decisions/stories it consolidates
  enactment: { asserted_rate: float, violation_rate: float, gap_trend: float }
}

Procedure += {
  canonical_rev: int
  owner: ActorRef
  instantiations: { count: int, divergence_mean: float, divergence_trend: float }
  review_due?: timestamp
}

Fact += {
  confidence: float                 // verifier-assessed, [0,1]
  staleness: {
    last_verified_at: timestamp     // last time provenance or reality re-checked
    stale_after: duration           // per-fact clock, set at admission
    stale: bool                     // maintained by Dynamics
  }
  contradicted_by?: [ExhaustEventRef]  // exhaust that appears to contradict
}
```

**Fact** is the semantic tier's descriptive counterpart to the normative
Principle: "churn concentrates in SMB," "service X falls over above 10k
QPS," "Acme's real decision-maker is the CFO." It is
**verifier-admitted without ratification** — descriptive claims need
evidence, not sign-off. Facts do not decay by disuse (§6.1 does not
apply): a true fact rarely restated is still true. They go stale
instead: the world changes under them. Staleness dynamics are specified
in §6.3.

---

## 6. Dynamics

### 6.1 Activation (episodic tier)

For Episodes and Decisions:

```
activation = 0.5^(age / half_life)
           × (1 + log2(recall_weight + 1))
           × (1 + β · log2(dispersion.actors + 1))
```

where `age = now − last_referenced_at`. For an artifact with zero
Reference Events, `last_referenced_at` is initialized to `created_at`,
so age runs from creation.

- Each Reference Event extends `half_life` by `retrieval_boost`, capped at
  `max_half_life`.
- `recall_weight` accumulates per §6.4.
- All counters MUST be periodically halved (aging pass, default every 90
  days) so retention tracks recent demonstrated usefulness rather than
  lifetime accumulation.
- Artifacts whose activation falls below `archive_floor` for
  `archive_grace` consecutive passes MUST transition to `archived`
  (episodic tier only). Archived artifacts remain stored, searchable via
  flag, and resurrectable.

### 6.2 Narrative tier

Stories are exempt from §6.1 decay. Story health:

```
story_health = f(distinct_tellers,
                 non_participant_tellers / max(distinct_tellers, 1),
                 recency(last retelling))
```

A Story MUST be flagged **endangered** when its retellings stop (no
retelling within `lore_dormancy`, default 12 months) or all its known
tellers have departed. Endangered flags surface in the governance queue.

### 6.3 Semantic tier

Principles are exempt from decay. Principle health is the **enactment
gap**: `violation_rate` relative to `asserted_rate`. Violation events are
Reference Events flagged (initially by humans; automated contradiction
detection is a later phase, §14) as exhaust contradicting the principle. A
`gap_trend` exceeding `zombie_threshold` MUST open a Challenge (§8.4).

Facts are likewise exempt from §6.1 disuse decay. Fact health is
**staleness**, not activation: Dynamics MUST set `staleness.stale` when
`now − last_verified_at > stale_after`, and MUST fire a
`flag_stale` (§8.4) re-verification flag into the governance queue. A
Reference Event contradicting a Fact (human-flagged initially, per the
same path as Principle violations) MUST populate `contradicted_by` and
fire `flag_stale` immediately regardless of the clock. Re-verification
(verifier re-reads provenance and fresh exhaust) either resets
`last_verified_at`, revises the Fact, or deprecates it. Stale Facts
remain in canon but MUST carry their stale flag wherever surfaced,
including context packs.

### 6.4 Reinforcement weighting

`recall_weight` increments per Reference Event by source class, scaled by
venue reach:

| Recall source | Base weight (default) |
|---|---|
| Organic exhaust reference by a human Actor | 1.0 |
| Explicit human lookup in UI / Search API | 0.5 |
| Agent retrieval via MCP `search_memory` / `get_artifact` | 0.15 |
| Context-pack auto-inclusion | 0.05 |

**Reach scaling.** Organic reference events are multiplied by a reach
factor derived from the audience of the exhaust event's venue (channel
membership, document share set, meeting attendance):

```
reach_multiplier = 1 + γ · log10(audience_size)
```

Reach is a property of the *venue*, never of the Actor. A statement made
to five hundred people is a stronger rehearsal event than the same
statement made to four — regardless of who makes it.

**Self-reference exclusion.** Organic weight and the reach multiplier
apply only to Reference Events whose Actor is not among the artifact's
`actors` (authors/participants). Rehearsal is evidence that the memory
lives in *other* minds; pasting your own decision into a 500-person
channel manufactures a reach-scaled rehearsal event out of nothing.
Self-references MUST still be logged (they are audit signal and input
to gaming detection) but contribute `recall_weight` 0.

**Measurement neutrality (normative).** Reference-event weights MUST be a
function of recall-source class and venue reach only. They MUST NOT vary
with the referencing Actor's rank, role, or governance authority.
Authority acts on the write path (§8.1), not the measurement path.

Rationale (informative): rank-weighted measurement would make the
instrument report the org chart rather than the organization, and would
destroy its most valuable signal — whether leadership statements actually
consolidate. A leader's practical influence emerges honestly through this
model: high-reach statements are heard widely, generating downstream
organic rehearsal by others, and that uptake is what strengthens memory.
A pronouncement nobody repeats decays like anything else — which is
exactly the zombie-principle early warning. Likewise, undamped agent
recall would let retrieval frequency manufacture institutional
importance; the loop closes through reality — when agent-assisted work
ships and the shipped exhaust references the artifact, that organic event
carries full weight.

### 6.5 Consolidation detector (episodic → semantic)

For each Decision, over a sliding window (default 6 months), maintain
`citation_rate` and `assertion_rate`. Because the two detectors have
asymmetric recall (citations are lexically explicit, assertions are
not), the ratio MUST be computed over **recall-corrected rates**: each
observed rate divided by its kind's measured detector recall (§4.2),
with correction factors recalibrated per §10.6. Uncorrected rates
systematically deflate the ratio and suppress consolidation for
anything not lexically distinctive. The detector MUST fire a
**nomination** (§8.4) when all hold:

- `corrected_assertion_rate / (corrected_citation_rate +
  corrected_assertion_rate) ≥ consolidation_ratio` (default 0.7)
- `dispersion.actors ≥ consolidation_actors` (default 5) and
  `dispersion.teams ≥ consolidation_teams` (default 2)
- artifact age ≥ `consolidation_age` (default 6 months)

Firing creates a nomination with the evidence attached. It MUST NOT create
or pin a Principle.

### 6.6 Narrative-promotion detector (episodic → narrative)

Cluster narrative recurrences of an Episode/Decision (semantic
near-duplicates of its telling). The detector MUST fire a Story nomination
when the cluster contains ≥ `retelling_min` (default 3) tellings by
≥ `teller_min` (default 2) distinct non-participant Actors.

### 6.7 Divergence detector (procedural)

For each Procedure, embed each Instantiation and compute divergence from
`canonical_rev`. When `divergence_trend` exceeds `divergence_threshold`,
the detector MUST fire a **revision flag** to the Procedure's owner,
including the top variant clusters found among recent instantiations.

### 6.8 Resurrection

A Reference Event on an artifact whose dormancy exceeds
`resurrection_dormancy` (default 3 × current half_life) MUST be logged as
a Resurrection. Resurrected artifacts receive a one-time half-life bonus
(`resurrection_boost`) and feed the calibration instrument (§10.6).

### 6.9 Parameters

All constants above MUST be configuration, not code. Defaults:

| Parameter | Default |
|---|---|
| initial `half_life` (episodic) | 45 days |
| `retrieval_boost` | +7 days |
| `max_half_life` | 720 days |
| `β` (dispersion factor) | 0.3 |
| `γ` (reach factor) | 0.25 |
| aging-pass interval / halving | 90 days |
| `archive_floor` / `archive_grace` | 0.05 / 3 passes |
| `consolidation_ratio` / `_actors` / `_teams` / `_age` | 0.7 / 5 / 2 / 6 mo |
| `retelling_min` / `teller_min` | 3 / 2 |
| `divergence_threshold` | 0.25 trend over 90 days |
| `lore_dormancy` | 12 months |
| `zombie_threshold` | implementation-defined, human-tuned |
| `resurrection_dormancy` / `_boost` | 3 × half_life / +90 days |

Defaults are seeded from human-memory research and MUST be recalibrated
per-organization from replay data (§12); the calibration report (§10.6)
exists for this purpose.

**Parameter profiles.** The defaults above assume a mid-size org
(roughly 30+ people). In an org of 2–10 people, `consolidation_actors
= 5` and `consolidation_teams = 2` are unreachable and nothing above the
episodic tier ever activates. Implementations MUST ship a named
**`small_org` profile** selectable at deployment, with defaults:

| Parameter | `small_org` default |
|---|---|
| `consolidation_actors` | 3 |
| `consolidation_teams` | 1 |
| `retelling_min` / `teller_min` | 2 / 1 |
| `γ` (reach factor) | 0.15 |

Reach scaling compresses in a small org (every venue is most of the
org), hence the lower `γ`. Profile choice MUST be recorded so that
instrument outputs are comparable only within a profile.

---

## 7. Lifecycle state machines

### 7.1 Common states

```
candidate ──verify──▶ active ──archive──▶ archived ──resurrect──▶ active
    │                    │
  reject             deprecate ──▶ deprecated
```

- `candidate → active`: verifier only (§8.3).
- `active → archived`: Dynamics (episodic only) or human.
- `archived → active`: Resurrection or human.
- Any state → `deprecated`: human, with rationale; deprecated artifacts
  remain visible in supersede chains but are excluded from context packs.

### 7.2 Principle states (extends common)

```
(decision, consolidating) ──nominate──▶ nominated ──ratify──▶ pinned
                                            │
                                          decline
pinned ──challenge──▶ challenged ──amend──▶ pinned (new revision)
                          │
                        retire ──▶ deprecated
```

- `ratify`, `amend`, `retire` MUST require named human ratifiers meeting
  the scope's configured authority rule (e.g. leadership sign-off for
  org scope; team quorum for team scope).
- A Challenge MUST force re-justification from current evidence before
  `amend` or reaffirmation; unresolved challenges past a deadline escalate
  in the governance queue, never auto-resolve.

### 7.3 Procedure states (extends common)

`register` (human, assigns owner) → `active`; `flag_divergence`
(Dynamics → owner) → `revise` (owner bumps `canonical_rev` with diff and
rationale) or dismissal with rationale; `deprecate` (owner or human with
authority).

---

## 8. Governance

### 8.1 Authority model

Authority in LOAM is explicit, configured, and confined to the write
path. It answers "who may apply which verbs, at which scope" — it never
answers "whose words count for more" (§6.4, measurement neutrality).

- Each scope (org, team, project) MUST define role bindings in
  configuration:

  ```
  ScopeAuthority {
    scope: ScopeRef
    ratifiers: AuthorityRule      // who may ratify/amend/retire Principles
    editors: [ActorRef | group]   // who may edit/merge/split canon in scope
    owners_default: AuthorityRule // who may claim Procedure ownership
    members: [ActorRef | group]   // who may propose, challenge, flag
  }

  AuthorityRule = named actors | group | quorum(group, n) | chain(...)
  ```

- Verb eligibility (§8.4) is evaluated against these bindings. Examples:
  org-scope Principles might require executive sign-off; team-scope
  Principles a team quorum. A CEO's greater influence is expressed here —
  broader ratification authority, org-scope edit rights, the power to pin
  and amend — not as a multiplier on their utterances.
- `propose` and `challenge` MUST be available to every member of a scope.
  Anyone can put evidence on the table; authority decides what gets
  pinned, not what gets said.
- **Proposal trust priors.** The verifier MAY apply per-actor trust priors
  (calibrated from historical overturn rates, or configured for roles) to
  triage scrutiny — a high-trust actor's proposals get lighter review, a
  new actor's get escalated. Trust priors affect verification *scrutiny
  and queue priority only*; they MUST NOT bypass verification, and MUST
  NOT feed activation.
- All authority evaluations MUST be logged with the verb application
  (who acted, under which rule, at which scope).

### 8.2 Single admission path

There MUST be exactly one path into canon: the candidate queue through the
verifier. Extraction pipelines, agents (via MCP `propose_artifact`), and
humans (via UI) all write to the same queue. No component may bypass it.
Human-authored artifacts still pass verification (dedup, provenance
check), but at elevated trust.

### 8.3 Verifier

A high-effort LLM pass (with human spot-check sampling) that, per
candidate, MUST:

1. Check that provenance actually supports the claim (read the linked
   exhaust).
2. Deduplicate against existing canon (merge, supersede, or reject).
3. Check type correctness (a Decision has a real resolution; a Procedure
   has a reusable form).
4. Admit (`active`), reject with rationale, or escalate to a human queue.

Verifier throughput, admission rate, and human-overturn rate MUST be
tracked as system health metrics. The verifier MUST have an explicit
queue SLA (default: median candidate age in queue ≤ 48h) and a
queue-depth alarm that pages the operator when breached — a silently
backed-up candidate queue makes the whole system look dead, since
nothing new reaches canon.

### 8.4 Verbs

The complete verb set. Every verb application creates a Revision (§5.2).

| Verb | Types | Allowed actor |
|---|---|---|
| propose | all | extraction, agent, human |
| verify / reject | all | verifier (+ human escalation) |
| edit | all | human |
| merge / split | all | verifier, human |
| archive / resurrect | episodic | Dynamics, human |
| decide / supersede / reopen | decision | human, extraction (propose-level) |
| nominate | principle, story | Dynamics, human |
| ratify / amend / retire | principle | ratifiers per scope rule |
| challenge | principle | Dynamics, any human |
| canonize / link / flag_endangered | story | human / human / Dynamics |
| register / revise / deprecate / flag_divergence | procedure | owner or authorized human; Dynamics for flag |
| flag_stale / reverify | fact | Dynamics, human / verifier |

`reopen` frequency per Decision MUST be tracked (input to §10.5).

### 8.5 Queues

The governance UI MUST expose four queues: **candidates** (awaiting
verification/escalation), **nominations** (awaiting ratification or
canonization), **challenges** (open enactment-gap cases), **flags**
(divergence, endangered lore, actor-merge ambiguities).

---

## 9. MCP interface

The MCP server is the primary access surface. Tool signatures below are
normative; parameter encodings follow MCP conventions.

### 9.1 Tools

```
get_context_pack(task_description: string, scope?: ScopeRef,
                 budget_tokens?: int) → ContextPack

search_memory(query: string, types?: [ArtifactType], scope?: ScopeRef,
              include_archived?: bool) → [ArtifactSummary]

get_artifact(id: uuid) → Artifact          // body + provenance + history

list_principles(scope: ScopeRef) → [Principle]   // the constitution; cheap

get_procedure(name_or_task: string) → Procedure  // canonical rev, current

propose_artifact(type: ArtifactType, body: markdown,
                 provenance: [ExhaustEventRef]) → CandidateRef
                 // candidates only — never canon

record_outcome(artifact_ids: [uuid], exhaust_ref: ExhaustEventRef) → void
                 // links agent work that shipped to the artifacts it used
```

Agent identity MUST be authenticated per session; all MCP-originated reads
generate Reference Events at agent weights (§6.4); `propose_artifact` is
the only write and lands in the candidate queue.

### 9.2 Context pack assembly

`get_context_pack` MUST assemble as follows:

1. Retrieve against `task_description` (lexical + vector, fused).
2. Rank by `relevance × activation`.
3. Fill the token budget in fixed tier order:
   1. **Principles** in scope — always all included (the pinned set is
      small by construction).
   2. **Decisions** touching the task's entities — with resolutions and
      supersede chains, so consumers neither relitigate settled questions
      nor resurrect superseded choices.
   3. **Facts** touching the task's entities — stale-flagged Facts carry
      the flag in the pack.
   4. **Procedures** matching the work type — canonical revisions.
   5. **Stories** linked to the included Principles — at most
      `pack_stories_max` (default 2), compressed to their canonical
      telling.
   6. **Episodes** — remaining budget by rank.
4. Every included item MUST carry its `artifact_id` and provenance refs,
   so downstream use is detectable and citable.
5. Inclusion logs a 0.05-weight Reference Event per artifact.

### 9.3 Session-start integration

A thin client for agent harnesses that support startup hooks MUST be
provided, injecting `list_principles(scope)` plus
`get_context_pack(inferred task)` at session start.

The same client MUST also hook session-end / work-shipped events
(commit, PR, message send — whatever the harness exposes) and call
`record_outcome` with the `artifact_ids` from the session's context
pack. `record_outcome` is the highest-value signal in the system — it
closes the agent-recall loop with full-weight organic evidence — and
MUST NOT be left to voluntary agent behavior. The §10.7 attribution
rate thereby measures the harness integration, not agent goodwill.

---

## 10. Instruments

Each instrument is a standing, reproducible query over the Reference Event
log, emitted as a report (markdown + charts). Required set:

1. **Decision survival.** Kaplan–Meier survival curves over decision
   reference lifetimes; cluster into died-early / long-lived /
   resurrected. Headline statistic: the organization's **decision
   half-life**. MUST also report goodness-of-fit of reference curves to a
   power-law-with-rehearsal model, as the standing test of the founding
   hypothesis (do organizational decisions decay like human memory?).
2. **Fragility.** Artifacts with high activation and `dispersion.actors
   = 1`. Naming the single rehearser is org policy, OFF by default (§11).
3. **Lore census.** Stories ranked by non-participant retelling;
   endangered-lore list.
4. **Drift.** Month-over-month movement of vocabulary, priorities, and
   entity attention in exhaust, measured relative to pinned Principles
   and declared priorities — i.e. the enactment gap's derivative.
5. **Tier flux.** Sizes and transition rates of each tier, plus `reopen`
   frequency. Documented pathology signatures: oversized pinned set
   (sclerosis), empty narrative tier with high reopen rate
   (relitigation), high procedural divergence (process theater), episodic
   growth without archival (data-lake regression).
6. **Calibration.** Resurrection rates and survival-curve fit residuals
   per artifact category, with recommended parameter adjustments (§6.9).
7. **Appreciation test** (research-grade; the standing measurement of
   §1's value model). Hold a frozen benchmark corpus constant; on each new
   model generation, run downstream tasks (org Q&A, contradiction
   detection, resurrection prediction) in two conditions — artifacts with
   provenance vs. bodies only — and record the with-trace advantage. The
   prediction under test: that advantage grows with model capability
   (provenance is forward-compatible leverage, not audit overhead).
   The frozen corpus is the Phase 0 benchmark corpus (§13) — one corpus,
   two standing uses.
   Cheaper standing proxies: extraction yield on replay (verified
   artifacts recovered from the same exhaust, per model generation) and
   `record_outcome` attribution rate over time. Predictions MUST be
   registered before each new-generation run.
8. **Latent-variable workbench** (research-grade; clearly labeled).
   Regressions of compressed features (decision half-life, lore density,
   reopen rate, divergence pressure, drift velocity) against
   pre-registered outcome variables (retention, cycle time, incident
   rate, renewals). Predictions MUST be registered forward in time and
   compared against naive baselines; the workbench MUST NOT present
   unvalidated factors as findings.

---

## 11. Trust invariants

These are invariants, not features. A conforming implementation MUST
enforce all of them.

1. **Symmetric visibility.** Every Actor whose exhaust is ingested can
   query the system, view all connector scope manifests, and view their
   own contribution surface. There is no analytics tier over individuals
   available to any role. Queryability applies to **artifacts and
   aggregates**: raw Exhaust Events are reachable only (a) by following
   provenance links from an artifact or Reference Event, or (b) by their
   own author over their own events. There MUST be no free-text search
   surface over the raw Exhaust Log — free exhaust search would
   reconstitute, self-serve, exactly the per-individual analytics tool
   invariant 3 prohibits.
2. **Declared scope.** Connectors read only their declared scope. DMs and
   private channels are excluded by default and may be included only by
   opt-in of all channel members. Scope changes are logged and announced.
3. **Aggregate reporting.** Instruments report on artifacts and
   aggregates. Any per-individual surfacing (e.g. naming the fragility
   rehearser) is a per-org policy switch, default OFF.
4. **No incentive coupling.** The system provides no per-individual
   scoring surface suitable for performance evaluation. (Dispersion
   weighting and organic-vs-lookup weighting additionally blunt reference
   gaming.)
5. **Read-only sources; recomputable interpretation.** LOAM never mutates
   sources, and every derived structure can be recomputed from the
   exhaust log.
6. **Erasure.** Source-side deletions propagate as tombstones; artifacts
   whose provenance is fully tombstoned are flagged for human review.
7. **Measurement neutrality.** Authority is confined to the write path:
   it determines who may ratify, amend, edit, and own (§8.1), never how
   much a person's references count (§6.4). Reference-event weights are a
   function of recall-source class and venue reach only — no Actor's
   rank, role, or governance authority scales the measurement of memory.

---

## 12. Initialization (replay)

Standing LOAM up against an existing organization MUST follow this
sequence. Initialization is a replay of history through the dynamics
engine, not an indexing job.

1. **Backfill** — connectors ingest full history with original
   timestamps, in priority order (§4.1).
2. **Extract** — batch artifact extraction over the full timeline.
3. **Resolve** — bulk entity resolution across the entire candidate set
   (bulk resolution precedes any incremental resolution).
4. **Replay** — run reference-event detection across history in time
   order, then compute activation trajectories as they would have
   evolved: decayed-and-resurrected artifacts show it; short-lived
   decisions initialize as archived; long-lived ones arrive
   pre-strengthened.
5. **Inaugural report** — before human curation, emit: top-activation
   decisions; the lore census; principle nominations with consolidation
   evidence; procedures under divergence pressure; the fragility report.
6. **Ratification bootstrap** — humans work the nomination queue;
   procedure ownership is claimed. Initial enactment gaps are reported,
   not hidden.
7. **Calibration** — fit decay parameters to the replayed curves (§10.6)
   and adopt org-specific values.

---

## 13. Implementation phases

Phasing is normative as to *order* (each phase's outputs are the next
phase's inputs), not as to schedule.

- **Phase 0 — Benchmark before implementation.** No implementation of
  Extraction (§4.2) or Dynamics (§6) proceeds until a benchmark exists to
  review it against. Deliverables:
  1. **Benchmark corpus** — one corpus (a git repo + its chat history),
     either consented-real or synthetic-with-ground-truth, frozen, with
     gold labels: (a) Reference Events labeled by kind (citation /
     assertion / retelling / instantiation), (b) a gold artifact set
     (decisions, episodes, stories, procedures, facts) extracted by hand
     or planted by construction.
  2. **Eval harness** — scores any extractor/detector implementation
     against the gold labels, reporting precision AND recall *per
     reference kind*, plus extraction yield against the gold artifact
     set. The harness is a conformance artifact and a permanent CI
     fixture.
  3. **Dynamics simulator** — synthetic-workload simulation of §6. Decay,
     `retrieval_boost`, and the 90-day halving interact multiplicatively
     and the healthy parameter regime is narrow; the deliverable is a map
     of the parameter space showing where the system degenerates into
     "everything archives" or "nothing archives."

  The Phase 0 corpus IS the appreciation-test frozen benchmark (§10.7):
  one corpus, two standing uses. Exit criteria are the per-kind
  precision/recall targets of §4.2, met on the benchmark corpus.
- **Phase 1 — Episodic core.** Ingestion (git + Slack), extraction of
  Decisions/Episodes, repository, activation dynamics, verifier, search.
  Exit: decision survival instrument produces stable curves on replayed
  history.
- **Phase 2 — Context.** MCP server, context packs, session-start client,
  `propose_artifact` / `record_outcome` loop.
- **Phase 3 — Full tier system.** Stories (retelling detection,
  canonization), Principles (consolidation detector, ratification,
  challenges), Procedures (instantiation + divergence).
- **Phase 4 — Instruments.** Full report set; calibration loop;
  latent-variable workbench last.

**Validation scale caveat.** Phase 3 detectors (consolidation,
retelling, divergence) cannot be validated on a small deployment under
default parameters — with the default profile, dispersion thresholds
never trip in an org of 2–10 people. Phase 3+ validation therefore
requires either the `small_org` profile (§6.9) on a small deployment,
or a design partner of roughly 50+ people under defaults. State which
in the validation report.

### 13.1 Cost model

Reference-event detection is a continuous LLM pass over all new exhaust
against the full artifact index — the dominant operating cost, and it
scales with org size × artifact count. Each phase plan MUST carry a
back-of-envelope cost model, maintained as parameters move:

```
daily_cost ≈ events_per_day
           × candidate_match_rate      // index hits per event, post-filter
           × adjudication_rate         // fraction sent to LLM adjudication
           × cost_per_adjudication
           + extraction_batch_cost + verifier_cost
```

Illustrative Phase 1 numbers (50-person org): ~3,000 exhaust
events/day; lexical+embedding prefilter yields ~0.3 candidate matches
per event; ~50% of candidates need LLM adjudication → ~450
adjudications/day. The intended mitigation is the
**cheap-triage / strong-adjudication split** that §1.1's per-role model
bindings exist for: a small model (or pure lexical/embedding score)
triages candidate matches, and only borderline cases reach the strong
adjudicator. The verifier (§8.3) is the high-effort pass but runs on
candidate volume, not exhaust volume, so it is second-order in this
model.

---

## 14. Open items

1. **Assertion-detection precision** — the load-bearing sensor risk;
   Phase 0 exists to answer it.
2. **Incremental entity resolution accuracy** — bulk is tractable;
   incremental accuracy targets TBD from Phase 1 data.
3. **Automated violation detection** for the enactment gap — human
   flagging ships first; automated contradiction detection is research
   until precision is demonstrated.
4. **Federated scoping** — whether team scopes are fields on one store or
   federated stores with a promotion path to org canon.
5. **Cross-org priors** — whether decay constants and pathology
   thresholds transfer between organizations, or every deployment is
   calibrated from its own replay only.
