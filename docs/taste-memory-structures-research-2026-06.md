# Storage Structures for Taste & Project Memory — Research Synthesis

### Companion to `frontier-agentic-research-2026-06.md`. Answers: "what structure should hold extracted taste, instead of a flat decaying lookup-memory?"

*Sourcing caveat: agents hit HTTP 403 on nearly all primary domains; most figures are snippet-sourced and post-date my Jan-2026 cutoff. Treat numbers as directional. Confidence tags: [CONFIRMED] I can verify from training; [REPORTED] agent-sourced, plausible, unverified; [SPECULATIVE] thin/weird.*

---

## The reframe: it's not one store, and "graph vs. brain" is the wrong axis

The single most consistent finding across all five agents: **don't use one structure — split by *kind of knowledge*.** The recurring neurosymbolic mapping (CoALA taxonomy, echoed by Letta/Mem0/LangChain) is:

- **Episodic** (what happened) → raw session logs. *(You have this.)*
- **Semantic** (facts about the project) → flat/vector store, optionally light graph edges. *(You have the flat half.)*
- **Procedural / normative** (taste, heuristics, "a senior wouldn't do X") → **a separate rule/policy layer with different write, retrieve, and decay semantics.**

The field *explicitly* says repeated regularities should be **promoted out of the flat fact store into a procedural/skill layer** (Memp; "Memory for Autonomous LLM Agents" survey). [REPORTED] So your instinct is dead right: **taste does not belong in the decaying-lookup-memory.** But the fix isn't a graph either — graphs are for *facts and their relations*. Taste wants a third thing.

So the answer is a **three-store split**, and each store gets a *different* structure. GBrain/Zep/graph stuff answers the *semantic* question. Taste needs its own answer.

---

## What taste storage should actually be: a tiered, scoped, validated policy — store *reasoning*, not a rule-list

The convergent template, assembled from the strongest findings:

### 1. The single most important steer: **store the reasoning, not the enumerated rule.**
Anthropic's Jan 2026 constitution rewrite deliberately shifted **from a rule-LIST to a reason/explanation form** — "the original was a list; the new one is closer to an explanation of *why*." [REPORTED, but a real and notable pivot] The bet: judgment generalizes better from explained principles than from brittle enumerated don'ts. This directly answers your worry that taste is too nuanced/fickle to codify — *don't* codify it as `length(list) == 0` bans; codify the *reasoning* ("prefer failing loud on invariant violations because swallowed errors hide real misconfig"), and let a model apply the reasoning to novel cases. Lists ossify; rationale travels.

### 2. The schema for a "taste unit" (the skill = procedure + heuristics + constraints + failure modes definition).
A taste rule is richer than a one-line memory:
```
{
  id,
  reasoning,            // WHY, in prose — the load-bearing field
  tier:  hard | deterministic | soft-fuzzy,
  scope: always | glob/context-triggered | agent-requested,
  evidence: [immutable links to the originating corrections],   // never deleted
  canonical_example: { bad, good },
  recurrence_count, confidence,
  status: candidate | active | deprecated,
  last_fired, decay
}
```
- **Two altitudes** (Memp): a concrete recipe *and* a generalized heuristic for the same lesson. [REPORTED]
- **Immutable evidence** (All-Mem, #25): every rule keeps pointers to the corrections that justify it; consolidation reorganizes but never destroys the source episode. [REPORTED] This is what lets you (the curator) audit *why* a rule exists.

### 3. Tiering, the ex_slop way (the deterministic end).
`ex_slop` is the existence proof you cited, confirmed: **40 Credo checks encoding "patterns LLMs generate but senior Elixir devs avoid"** (blanket rescues, N+1, `acc ++ [item]`, narrator docs). [CONFIRMED] Semgrep's community frames custom rules identically: "when a senior discovers a subtle misuse, they write a rule that catches it everywhere — the value is the *explanatory message*, not the YAML." [CONFIRMED] So:
- `deterministic` tier → compiles to an actual lint/Credo/Semgrep check. Cheap, always-on, no model.
- `soft-fuzzy` tier → a reasoning criterion the rigor-agent applies.
- `hard` tier → non-negotiable (Anthropic's hard-coded vs. soft-coded distinction). [REPORTED]

### 4. The lifecycle that flat decaying memory lacks (MAC — the most directly applicable find).
**Multi-Agent Constitution Learning** treats the rule set as an optimizable object: agents **propose/edit/reject** candidate rules, each is **validated on a held-out batch and kept only if it improves score**, and the set is **pruned**. [REPORTED] This is the validate/dedup/expire machinery your candidates→canon pipeline needs, specialized for rules. WALL-E adds **max-coverage pruning** as a concrete dedup/conflict mechanism. [REPORTED]

### 5. Scoped activation (rules-files don't scale).
Hard limit: models reliably follow ~150–200 instructions; a useful CLAUDE.md is effectively ~80–120 lines before rules get dropped. [REPORTED] So an ever-growing always-on taste list **self-defeats.** Cursor's model is the fix: rules with activation modes — **Always / glob-auto-attached / agent-requested / manual.** [CONFIRMED Cursor has this] Deterministic checks stay always-on (free); fuzzy rules load *only when their scope matches*, so you never blow the budget.

---

## The fickleness problem has a concrete answer: **your corrections ARE the eval set**

You worried you have no ground truth but your own fickle taste. MAC's "validate on a held-out batch" gives the mechanism, and your own history supplies the batch: **replay a candidate rule against past sessions — would it have flagged the things you actually corrected, without flagging the things you accepted?** That's a self-supervised validation signal needing zero external ground truth. A candidate that doesn't predict your *past* corrections doesn't get promoted. This closes the loop with the extraction pass: the same divergence events that *generate* candidate rules also *validate* them. Fickleness is bounded because a rule must earn its place against your actual track record, not a single mood.

---

## The fact side (semantic store): graph is a targeted tool, not the default

For the *non-taste* part of project memory, the evidence is pointedly skeptical of going graph-first:
- **Graph buys little on average:** Mem0's graph mode = ~+1.5 points at ~2x tokens and +53% latency on LoCoMo; gains concentrate *only* in temporal/multi-hop categories. [REPORTED]
- **It clearly wins for relational/temporal/multi-hop** queries specifically — HippoRAG (KG + PageRank, ~+7 F1 on associative recall) and Zep/Graphiti's **bi-temporal supersession-with-provenance** (facts invalidated, never deleted). [REPORTED] That bi-temporal pattern is a more rigorous version of your existing hashed supersede/merge.
- **GBrain** (Garry Tan, Apr 2026, confirmed = your "G brain") is the cheap on-ramp: **plain-text markdown + typed edges wired by mention-matching with *no* LLM extraction + a nightly "dream cycle."** [REPORTED] It's the closest analog to HIVE's own plain-text-canon + nightly-pipeline philosophy.

**Recommendation for the fact store:** keep flat/retrieval as the base; add graph edges *only* for the relational/temporal slice (dependency chains, supersession history), GBrain-style (plain-text + mention-wired edges), if/when you feel the relational blind spot. Don't adopt a graph DB on spec.

---

## Process: how learnings move from raw to canon (you already do most of this)

- **Offline consolidation is convergent and validated.** Letta sleep-time compute, OpenAI "Dreaming," Zep, GBrain dream-cycle *all independently* arrived at *temporal facts + background nightly consolidation*. [REPORTED] That convergence on **your nightly pipeline** is a stronger signal than any benchmark.
- **The abstraction ladder** (raw → reflection → principle): RAPTOR (recursive summarize-tree), Generative-Agents reflection trees, Synapse episodic→semantic graph. [CONFIRMED foundational] Your facts→conventions→decisions maps onto this.
- **Reorganize, don't append** (A-MEM evolving Zettelkasten notes; All-Mem SPLIT/MERGE/UPDATE with immutable evidence). [REPORTED]
- **Forgetting is a feature, not a bug.** FSFM, "Learning to Forget," MemoryBank's Ebbinghaus decay; consolidation actively prevents *proactive interference* (stale learnings poisoning new ones). [REPORTED] Procedural rules especially need **active expiry** to avoid "procedural drift" (SSGM) — entrenching suboptimal habits. [REPORTED]

---

## Skeptic guardrails (how much to actually build)

The contrarian camp is strong enough to set the build budget:

- **Minimalism keeps winning.** A simple retrieval baseline (EMem) reportedly matches elaborate architectures at ~30x fewer tokens; Anthropic ships *files + grep + markdown + JIT*; "every clever architecture lost to LLM + markdown + bash." [REPORTED] → **Keep the taste store as tiered plain-text** (constitution-style markdown + a checks file), not a new database. The structure is *conceptual* (tiered/scoped/validated/evidence-linked); the implementation stays in your existing plain-text + nightly-pipeline world.
- **"Agent skills are a transitional layer."** Capable models absorb simple rules from context; the fastest-growing rule repos are the *simplest*. [SPECULATIVE] → **Only encode the non-obvious, recurring, project-specific judgments a good model *wouldn't* already make.** Don't write rules for taste the model already has. This is also the recurrence gate's job.
- **Benchmarks are gameable** (LoCoMo disputed; recall ≠ usefulness). [REPORTED] → Trust the replay-against-your-corrections eval over any public number.
- **Memory poisoning is a >95%-success attack** that separates injection from execution (no anomaly to detect). [REPORTED] → Your write-gate (candidates→canon, never auto-admit) *is* the defense. Keep it.
- **Transparency > clever.** Added memory layers can make agents *less* debuggable; governability beats max recall. [REPORTED] → Favors the inspectable, human-curated, reason-form rule set over any learned reward model — which is exactly where the taste argument already landed.

---

## How this updates the extraction pass (Pass C routing, now resolved)

The extraction pass produces *typed* outputs; the research tells us where each goes:

| Extraction tier | Routes to | Structure |
|---|---|---|
| `CONTEXTUAL` (project fact) | semantic store | flat/retrieval (current); graph edges only for relational/temporal |
| `DETERMINISTIC` (checkable) | a **checks artifact** | compiles to Credo/Semgrep/lint-style rule + rationale |
| `FUZZY` (judgment) | the **taste/policy store** | constitution-style reasoning unit, scoped + validated + evidence-linked |

And the lifecycle for the two rule stores = **MAC**: propose (from extraction) → validate by replay against past corrections → accept/edit/reject → scope it → periodically prune by usage/coverage/age.

---

## Bottom line

1. **Taste leaves the decaying-memory store** and gets its own **tiered, scoped, validated policy layer** — deterministic checks (ex_slop end) + soft reasoning units (constitution end), each carrying immutable evidence.
2. **Store reasoning, not rule-lists** (Anthropic's pivot) — the answer to "taste is too nuanced/fickle to codify."
3. **Validate against your own past corrections** — the fickleness fix; no external ground truth needed.
4. **Graph/GBrain is for the fact side, targeted to relational/temporal queries — not for taste, and not by default.**
5. **Build it as plain-text on your existing nightly pipeline,** gate writes, expire aggressively, and only encode judgments a capable model wouldn't already make.

The shape that keeps recurring is a **constitution** — layered, reasoned, hard/soft-tiered, deployer-scoped, lifecycle-managed — sitting *next to* your fact memory, not inside it.
