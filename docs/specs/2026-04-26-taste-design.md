# Taste — Design

**Status:** V1 collapsed to principles-only (2026-04-27). V0 shipped.
**Date:** 2026-04-26
**Author:** Maya (with Greg)
**Ticket:** TK-063

> **2026-04-27 update — V1 scope collapse.** During the memory V1 cutover,
> the per-domain `applications/` tree, `exemplars/`, `source-material.md`,
> `pending.md`, and the `--taste <domain>` flag were all removed. Taste
> now lives at one altitude: `~/.hive/taste/principles.md` loads in the
> identity prefix and Pass V (Opus verify) reads the same principles during
> the nightly run. The original mining/applications design below is kept
> as historical record but is not what's running.

## Summary

Add a **taste layer** to HIVE: a curated, file-native record of a specific
human's tacit aesthetic, loaded into agent context so output reflects that
human's judgment without needing line-by-line correction. Two artifacts:

- `~/.hive/taste/principles.md` — ~15-25 universal principles in PG-shape,
  each carrying its own tension (e.g. *"Simple. As simple as possible, but
  no simpler."*). Always loaded when present.
- `~/.hive/taste/applications/<domain>.md` — concrete moves per domain
  (prose, code, ux, product, architecture). Loads at session start via
  `hive --taste <domain>` or mid-session via standing instructions in
  `OVERRIDES.md` when the domain emerges.

The strange priority — the design choice that distinguishes this from every
similar system in the literature: **the human is the discriminator, on
purpose.** No LLM critic, no judge agent, no regeneration gate. Greg
corrects; the system absorbs corrections into principles over time; agent
output drifts toward Greg's voice without intervention.

## Motivation

Every other layer of HIVE infrastructure — memory, skills, tools, identity
stack — improves what the agent *knows* and *how it operates*. None fix the
"technically correct but offensive-to-taste" failure mode: output that
satisfies the prompt but doesn't sound like Greg, doesn't choose like Greg,
doesn't ship like Greg. Memory is for retrieval; taste is for judgment.
Different computational objects, different infrastructure.

Failure shapes the layer is designed to address:

- **Voice drift across sessions.** Identity files load at start, then
  every session pulls toward generic-Claude defaults as context fills.
  Domain-specific principles loaded into the prefix counter-weight the drift.
- **Net steering cost.** Without the layer, every prose draft, design doc,
  or PR description is a round trip with corrections. With it, the agent
  produces work that stays closer to Greg's voice on first emit, reducing
  the round-trip count.
- **Dispatch trust.** Overnight builds and heartbeat-triggered runs produce
  artifacts Greg reads in the morning. If those artifacts feel off, the
  whole dispatch model loses confidence. Taste loaded at dispatch start is
  the unmonitored ground truth.
- **Continuity beyond identity files.** SOUL/IDENTITY/SELF carry voice and
  values; they're stable, low-churn, hand-curated. Taste extends that
  continuity into per-domain craft (how you write prose, how you choose
  abstractions, how you triage corrections) without bloating the identity
  stack.

The success metric is **net-less steering and higher dispatch trust**: a
dispatched task ships work that, when Greg reads it next morning, still
feels like his.

## Non-Goals

- **Not preference learning.** Honcho-style "what does this user prefer in
  context X" is retrieval over inferred user facts. Taste answers a different
  query — *"is this artifact a violation of the user's aesthetic?"* — which is
  judgment, not retrieval. If HIVE ever wants preference infra, integrate
  Honcho rather than building it here.
- **Not an LLM discriminator.** MetaMind's generator-discriminator pattern
  (utility-score gate triggering regeneration) was the obvious shape from
  the literature. We explicitly reject it: the human is the discriminator.
  No pre-emit judge, no `taste-check` skill, no regeneration loop.
- **Not a council-driven signal source.** Council picks would be high-quality
  contrastive pairs (well-formed alternatives + a Greg-labeled choice).
  Greg explicitly cut council from this workflow.
- **Not auto-promotion of mined principles.** Mining proposes; Greg curates.
  Two-thirds of automatic identity-proposal outputs landed wrong in past
  experiments (see HIVE memory: *Reflection-promotion gate triage 2026-04-21*).
  No principle lands in canon without a human composing the phrasing.
- **Not always-on for application slices.** Application files load only
  when the domain is known (flag at start, or mid-session inference via
  OVERRIDES). The recognition set (principles) is always-on; the concrete
  moves are situational.
- **Not domain-stratified at the principle level.** Principles are universal
  (PG-frame: mathematicians, architects, painters, engineers all use
  "beautiful" the same way). Domains are where principles *manifest*, not
  where they *live*. Apparent cross-domain contradictions ("bold product
  bet" vs. "boring architecture wins") dissolve at the right level of
  abstraction.

## Design

### Three artifact types

| Artifact | What it holds | Voice | Churn |
|---|---|---|---|
| **Principle** | Universal claim with internal tension | PG-shape, ~15-40 words | Low — earned, rarely added |
| **Application** | Concrete moves for a domain | Imperative bullets | Medium — accretes per domain |
| **Exemplar** | Pointer + short excerpt of a touchstone artifact | Quote + 1-line note | Manual curation |

The split mirrors the **shared / individuated** gradient. Principles are
~90% transferable across users (a well-shaped principle reads true to anyone
who shares the underlying craft). Applications are 100% individuated — how
"simple" manifests in *Greg's* prose differs from how it manifests in
someone else's. Exemplars are fully personal artifacts.

### Principles: PG-shape with tension

Each principle has:

- **Header** (1-3 words) — the recognition trigger.
- **Body** (1-3 sentences, ~15-40 words) — must contain its counter-pressure.

The tension is non-optional. *"Simple"* alone calcifies into a slogan.
*"As simple as possible, but no simpler — complexity is sometimes earned;
refuse it unless you can name what it buys"* carries the failure mode
internally. The discipline of writing the counter-clause is where tacit
knowledge gets partially encoded.

Total file readable in ~2 minutes. Past that, the list stops working as a
mnemonic and becomes a manual. Hard cap at ~25 entries; new principles must
displace older ones unless they're genuinely additive.

`Hold the tension` is a meta-principle in the canon — a principle *about*
how to read other principles. Fitzgerald's "first-rate intelligence holds
two opposed ideas" applied to the canon itself. It tells the agent: don't
collapse declared tensions into hedges; both poles matter.

### Applications: domain translations + exemplar pointers

Per-domain file (`prose.md`, `code.md`, etc.) contains:

- **Per-principle translation block.** How each universal principle manifests
  in this domain. Concrete moves, not restated principles.
- **Exemplar pointers.** Touchstone artifacts that embody multiple principles
  together. Format: path + 3-5 line inline excerpt + 1-line note of what
  it embodies.

Not every principle translates to every domain. `Pull abstractions, don't
push` is code-specific; it doesn't appear in `prose.md`. Curate the file
to what genuinely manifests; don't force generic translations.

Anti-patterns sections at the end name failure modes worth catching before
emit (e.g. for prose: preamble-and-throat-clearing, hedge stacking,
performance bullets, status-laundering language).

### File shape

```
~/.hive/taste/
├── principles.md              # ~15-25 universal entries, PG-shape with tension
├── applications/
│   ├── prose.md              # V0 — shipped
│   ├── code.md               # future
│   ├── ux.md                 # future
│   ├── architecture.md       # future
│   └── product.md            # future
├── source-material.md         # one-shot bootstrap material, throwaway after seed
├── pending.md                 # V1 — mined candidates awaiting curation
└── exemplars/                 # optional, V0 inlines pointers in applications
```

### Runtime

The taste layer extends `buildCanonicalIdentity` in `src/lib/identity.ts`.
Emission order is preserved with one new section between reflection and
overrides:

1. Soul stack (SOUL → IDENTITY → SELF → AGENTS → TRUST)
2. Project memory
3. Stack hint
4. Reflection protocol
5. **Taste layer** — principles always; applications only when hint provided
6. OVERRIDES.md (last = loudest)

`buildTasteLayer(domainHint?)` is a pure function in `src/lib/taste.ts`:

- Returns `null` if `principles.md` doesn't exist (graceful absence).
- Returns principles content as a string when no domain hint provided.
- Returns principles + separator + applications/`<domain>`.md when hint
  passes the `TASTE_DOMAIN_RE` regex AND the application file exists.
- Byte-stable per `(principles content, domain hint)` — preserves cache
  discipline established by TK-024.

The CLI exposes `hive --taste <domain>` and `hive --taste=<domain>`.
Invalid domain names are rejected with the available list. The flag is
parsed and stripped before passthrough to claude — it does not leak into
claude's argv.

### In-session mechanism

`hive --taste prose "draft hero copy"` — application loads at start, sits
in cache-stable prefix for the whole turn. This is the **dispatch / known-
domain mode**. Best for focused work where the domain is named at start.

For interactive sessions where the domain emerges or shifts mid-conversation,
the launcher already exposes `~/.hive/` via `--add-dir`. The agent can
read `~/.hive/taste/applications/<domain>.md` directly using the standard
Read tool. The instruction to do so lives in `OVERRIDES.md` under the
*"Taste — domain applications"* section, named triggers per domain (prose,
code, ux, product, architecture). OVERRIDES emits last in the identity
stack, so the directive is the loudest signal in the prefix.

This split is intentional:

- **Cache-stable when domain is known** (start-time flag) — applications
  ride in the cached system prompt; no per-turn token cost.
- **On-demand when domain shifts** (mid-session Read) — flexible at the
  cost of consuming turn tokens, but only when needed.

### Phasing

**V0 — shipped 2026-04-26.** Hand-seeded `principles.md` (19 entries) +
`applications/prose.md`. `buildTasteLayer` wired into the identity stack.
`--taste <domain>` flag. `OVERRIDES.md` directive for in-session loading.
`hive doctor` reports taste status. 16 unit tests; full suite green
(352/352). No mining, no promotion mechanism, no automated curation.

**V1 — unbuilt.** Mining script extends the existing nightly launchd
job. Reads session JSONL from the last 24h, finds `(draft → pushback →
revision)` clusters, optionally applies a Haiku pass to propose a
candidate principle per cluster, appends to `pending.md` with timestamp +
session reference. New CLI: `hive taste review` for a weekly walk-through.
Promotion = Greg accepts → entry lands in `principles.md` or
`applications/<domain>.md`. No automation past proposal.

**V2 — speculative.** PROSE-style verification (Apple ML, arXiv 2505.23815):
decompose mined principle into atomic components, score each via
LLM-as-judge across held-out samples, prune below threshold. Only justified
if V1 produces enough candidate volume that manual curation can't keep up
without a filter. Defer until evidence demands it.

**V0 → V1 gate.** Build mining only after V0 demonstrates that loading
principles into context actually shifts agent output. The honest test:
unmonitored dispatch produces work that, on morning review, feels like
Greg's. Vibe check after one week. If output doesn't shift, the principles
or the loading mechanism is wrong; mining can't fix that.

## Prior art

Four pieces of prior art shaped the design. Each contributed something
specific and was either adopted, adapted, or deliberately rejected.

### Honcho (Plastic Labs) — adapted shape, rejected purpose

[github.com/plastic-labs/honcho](https://github.com/plastic-labs/honcho).
Memory + theory-of-mind for stateful agents. Deriver extracts explicit
and deductive observations per message; Dreamer consolidates via random
walks; Dialectic API answers natural-language queries about peers
("how does this user prefer feedback?"). Working representations cache
the inferred user model.

**What we took:** the dialectic frame — agents query a user model rather
than carrying it raw — is the right shape for retrieval-style preference
work.

**What we rejected:** Honcho's whole architecture is preference
infrastructure. Its query is "what does the user prefer?" Ours is "is this
artifact a violation?" Different computational object. If HIVE ever wants
preference infra, integrate Honcho rather than building it here.

### PRELUDE / CIPHER (NeurIPS 2024) — selector shape

[arXiv 2404.15269](https://arxiv.org/abs/2404.15269v1). Context-conditional
preference inference from user edits. PRELUDE is the framework; CIPHER is
the implementation. Retrieves preferences from k-closest historical contexts,
aggregates, conditions generation.

**What we took:** the selector shape. `buildTasteLayer(domainHint)` is a
context-conditional retriever — given a domain, load the matching slice.
Same instinct as CIPHER, applied to file-native principles instead of a
preference vector store.

**What we adapted:** CIPHER mines from file edits in narrow writing tasks;
HIVE mines from conversational corrections across mixed-domain work,
which is harder and noisier. V1 mining acknowledges this with a
human-in-the-loop curation gate.

### PROSE (Apple ML, 2025) — verification methodology

[arXiv 2505.23815](https://arxiv.org/abs/2505.23815). Iterative refinement
of inferred preferences with LLM-as-judge verification. Decomposes
preference descriptions into atomic components, scores each on [-2, 2]
across held-out samples, prunes below threshold. 91.8% win rate over
CIPHER.

**What we took:** the V2 verification methodology if mining ever produces
enough volume to need automated filtering. The decompose-score-prune
algorithm is concrete, benchmarked, and directly applicable.

**What we deferred:** until V1 demonstrates real signal volume, PROSE-style
verification is over-engineering. The PG-shape principle list is small
enough that a Greg curation pass on `pending.md` is the cheapest filter.

### MetaMind (Stanford, 2025) — rejected architecture

[arXiv 2505.18943](https://arxiv.org/abs/2505.18943). Three-stage
generator-discriminator framework: Theory-of-Mind agent generates
hypotheses, Moral agent refines, Response agent generates with self-critic
utility score triggering regeneration on threshold violation. +35.7% on
real-social benchmarks vs. base.

**What we rejected:** the entire architecture. MetaMind embeds the
discriminator as a separate LLM agent with a regeneration gate. We
deliberately chose the opposite — Greg is the discriminator, no pre-emit
critic, no regeneration loop. The discrimination happens asynchronously
at human review, not in-loop. This is the strange priority of the design.

### Paul Graham — "Taste for Makers" — intellectual frame

[paulgraham.com/taste.html](https://paulgraham.com/taste.html). Argues
that taste is substrate-independent: mathematicians, architects, painters,
and engineers all use "beautiful" the same way. Lists ~14 universal
properties of good design (simple, timeless, daring, hard, suggestive,
etc.).

**What we took:** the entire frame. Principles are universal; applications
are domain-specific manifestations. Apparent cross-domain contradictions
dissolve at the right abstraction level. The PG-shape (short header,
short body with tension) is the form principles take.

## Decisions log

The major calls made during the design grill (TK-063, 2026-04-24):

### Goal frame
**Continuity + replication, with Greg as the discriminator.** Considered
prevention (LLM critic), compression (mining-driven preference reduction),
continuity (richer loadable layer), and replication (file-native, portable
aesthetic). Locked C+D. Greg's framing: *"I want the agent to be able to
pick up MY tastes based on MY feedback over time, allowing it to run more
autonomously and make decisions I would make."*

### Mining mechanism
**Hybrid: mine proposes, Greg curates.** Considered manual-only (loses
silent-majority signal), automation-only (high noise on thin data,
historical 2/3 false-positive rate on similar pipelines), and hybrid.
Locked hybrid with weighted-toward-curation. Mining is V1; staging area
must be low-friction to review or the system rots.

### Universality
**Universal principles + domain applications (PG-frame).** Considered
core-plus-domain with declared contradictions (TK-063 original),
universal-only, and hybrid. Locked hybrid. The contradictions in TK-063
("bold product" vs "boring architecture") dissolved at higher abstraction
into different principles dominating different contexts.

### Entry shape
**Principle + tension** (Einstein-form). Every entry names its
counter-pressure even when forced. Greg's framing on the discipline:
*"This is the nature (and importance) of tacit knowledge! It will be
flexible and bend to fit the shape from the creator."* Manufacturing the
tension where it doesn't obviously exist is itself the craft step.

### Runtime
**Static principles always-on; script-loaded applications on-demand.** No
LLM call in the hot path. Domain hint comes from `--taste` flag at start
or from agent self-detection via OVERRIDES.md directive mid-session.
PRELUDE/CIPHER's context-conditional pattern, simplified: deterministic
file-load, no embeddings, no retrieval index.

### Authorship discipline
**C-level: Maya extracts, Greg composes, Maya proposes applications,
Greg edits.** Strawman drafting was rejected on principle. Source-material
file contains clusters with theme labels and excerpts; no candidate
phrasings, no proposed principles. Greg writes principles by hand from
the raw material. This prevents Maya's voice leaking into canon under
edit-momentum.

### What was killed from TK-063 original
- LLM discriminator / generator-discriminator split (MetaMind shape)
- Council picks as Tier-1 mining signal
- Contrastive JSONL as separate format (session JSONL is the substrate)
- Core / domain split with declared contradictions + CSS-specificity
  firing order
- Always-on taste-check pre-emit gate

## Open questions

- **Does loading shift behavior?** V0's first real test. Vibe-check after
  one week. If output in unmonitored dispatch reads like Greg's, V0 worked
  and V1 (mining) earns its place. If not, the principles or the
  mechanism is wrong; mining can't fix that.
- **OVERRIDES directive vs. flag — which wins for in-session use?** Both
  paths work for V0. Open question whether the in-session Read directive
  fires reliably as context fills, or whether the agent forgets to check.
  Diagnose during week-of-use.
- **Application coverage.** Only `prose.md` exists in V0. Other domains
  (code, ux, product, architecture) translate from the same principles
  but the file shape may not generalize cleanly — code-taste is more
  pattern-based than translation-based. Build the next domain when the
  first task in it surfaces; iterate the shape if needed.
- **Heartbeat / dispatch propagation.** V0 wires taste only to interactive
  `hive`. Dispatch and heartbeat don't load applications. If V0 demonstrates
  value, propagate to dispatch with `--taste` in the dispatch goal or a
  per-ticket `taste_domain` field. Heartbeat probably never needs taste —
  it triages, doesn't draft.
- **Cross-user shareability.** Principles are PG-frame universal (~90%
  transferable). If HIVE grows past Greg, principles could ship as a
  default seed; applications stay individuated. Out of scope for V0, but
  the shape supports it.

## References

- TK-063 (HIVE) — *Taste infrastructure: encode and regurgitate a human's
  tacit aesthetic.* Original ticket + V0 design synthesis note (2026-04-24).
- `~/.hive/taste/principles.md` — the canon, hand-composed by Greg.
- `~/.hive/taste/applications/prose.md` — V0 application, drafted by Maya,
  edited by Greg.
- `~/.hive/SOUL.md` (Voice section) — voice exemplar.
- `~/.hive/SELF.md` (Communication Style) — voice exemplar.
- `docs/specs/2026-04-20-campaign-dispatch-design.md` (HIVE) — opener
  exemplar for *Hold the tension* and *Schwerpunkt*.
- Paul Graham, *Taste for Makers* — [paulgraham.com/taste.html](https://paulgraham.com/taste.html).
- Plastic Labs, *Honcho* — [github.com/plastic-labs/honcho](https://github.com/plastic-labs/honcho).
- Gao et al., *Aligning LLM Agents by Learning Latent Preference from User
  Edits* (PRELUDE / CIPHER), NeurIPS 2024 —
  [arXiv 2404.15269](https://arxiv.org/abs/2404.15269v1).
- Apple ML, *Aligning LLMs by Predicting Preferences from User Writing
  Samples* (PROSE), 2025 — [arXiv 2505.23815](https://arxiv.org/abs/2505.23815).
- Stanford et al., *MetaMind: Modeling Human Social Thoughts with
  Metacognitive Multi-Agent Systems*, 2025 —
  [arXiv 2505.18943](https://arxiv.org/abs/2505.18943).
- HIVE memory — *Reflection-promotion gate triage 2026-04-21* (rationale
  for human-in-the-loop curation).
