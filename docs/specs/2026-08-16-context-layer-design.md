# The Context Layer — design

**Status:** proposal, 2026-08-16
**Scope:** taste first, memory second
**Touches:** `2026-04-26-memory-design.md` (read path), `2026-06-22-taste-extraction-design.md` (admission model)

---

## 1. What this is for

One sentence: **at the moment of work, put the right ~3,000 tokens in front of the agent.**

Not the most. The right ones. Everything below follows from that, and every existing
mechanism gets judged against it. Memory and taste are not two systems — they are two
producers feeding one context budget, and they should be designed as one layer.

The layer has to span sessions (a judgment learned Tuesday must reach Thursday) and,
where the judgment is general enough, projects.

---

## 2. What we measured

### Taste

```
store:  99 units  —  73 holding · 9 pending · 10 active   (as of 2026-08-16 13:51)
before that write:   78 holding · 24 pending · 0 active
search_taste calls with a recorded response:  79      → returned a hit: 0
```

For the system's entire history until this afternoon, `search_taste` returned nothing on
all 79 calls, across 36 sessions, from four call sites that ask for it correctly
(`maya-coder.md:11`, `maya-planner.md:11`, `maya-executor.md:14`, `AGENTS.md`).

The three general-store files were rewritten at **13:51 today** and 10 units are now
`active`. `hive taste review` is the only code path that sets that status
(`taste-store.ts:284`, sole caller `commands/taste.ts:423`). The first non-empty
retrieval in the system's history happened immediately after.

**That single data point is the most useful thing we have.** The read path — BM25 ×
decay-strength, relative floor at 0.25 × top, top-k 5, retrieval strengthening on recall
(`taste-store.ts:360-400`) — is finished, correct, and now demonstrated end to end. It
returns good units with useful reasoning. Nothing below proposes changing it.

### Memory

```
search_memory:  126 hits · 14 empty · 22 "No project found"
results per hit:  min 4 · p25 12 · median 24 · p75 45 · max 162
```

No cap anywhere (`mcp-server.ts:345-353`, `memory.ts:1232`). At 459 chars/entry, the
median call is ~2,800 tokens and p75 is ~5,200. Stanford's lost-in-the-middle result puts
accuracy degradation at 20 documents / ~4,000 tokens — **our median call sits on that
threshold and p75 is well past it.** The empirical work on experience-following
(arXiv:2505.16067) finds noisy memory can leave an agent worse off than no memory at all.

Memory is not dysfunctional. It is over-saturating: high recall, falling precision. Its
fix is a cap and a rollup, not a rebuild.

---

## 3. The four defects

Root causes, each with its evidence. These are what the design has to answer.

### D1 — The human gates instances, so nothing is ever admitted

`active` requires human sign-off, per unit, with reasoning + delta + canonical example +
evidence on each card. 24 cards is 24 decisions, so the review didn't run for months and
the cost of it not running was total: zero retrievable procedural memory, system-wide.

### D2 — The ladder is unvalidated free text

`ladders_up_to` is a free-form string. TC is asked to name "the exact PRINCIPLE heading
it instantiates" but nothing checks the answer against `principles.md`:

```
99 units carry a ladder · 26 distinct targets · 20 real principle headings
8 targets are invented — 10 units sit on rungs that do not exist
```

Invented rungs include *Conservation of complexity* (×2), *Iterate* (×2), *Leave the
workspace as clean as you found it*, *Ask when interpretations diverge in blast radius*.

**This is the mechanism behind the useless coherence signal.** TC is not choosing whether
a unit ladders — it is free to invent the rung. Of course nothing comes back
`orthogonal`: when no principle fits, the model makes one up and calls it instantiation.

Which explains the numbers that made no sense:

```
22 nights · 90 candidates  →  86 instantiates · 5 orthogonal · 0 tension
```

Zero tensions in ninety candidates was never a fact about our work being
principle-compliant. It was an artifact of an open enum.

And the invented rungs are not noise — several are good, and a few are near-misses on
real principles. They are the new-principle signal, hiding inside the `instantiates`
bucket. Real standing pressure is **15 units** (10 invented-rung + 5 declared orphan),
not the 5 the system knows about.

### D3 — The orphan gate counts a cross-time signal within one night

`orthogonalEligible` is local to a single run and fires at ≥3
(`taste-consolidate.ts:596-600`). The 5 declared orphans are spread over 4 nights, never
more than 2 in one. Structurally unreachable, not merely unmet. `newPrincipleProposals`
has fired zero times in 22 nights.

### D4 — Nothing rolls instances up

No operation anywhere turns N related instances into one generalization. Taste has
`principles.md` but only hand-edits reach it. Memory has 321 flat entries in hive and 359
in revrec with per-entry supersede and no compression at all.

---

## 4. The model

### Two layers, defined by blast radius

| | Instances | Generalizations |
|---|---|---|
| taste | units | `principles.md` (20) |
| memory | facts | conventions |
| reaches the agent | retrieved on a matching query, capped at top-k | injected into every session, always |
| volume | high, fine | small, must stay small |
| cost of one error | local, self-limiting, outranked by neighbors | global, permanent, compounding |
| **gated by** | **machine** | **human** |

The current design has this exactly inverted. It defends instances — narrow, scoped,
retrieved only on match, competing against other instances for 5 slots — with the most
expensive gate we have. It defends `principles.md`, which is injected unconditionally
into every session forever, with nothing but hand-editing.

*Defend in proportion.* The fence should match the size of the loss.

### The inversion

**Instances auto-admit past the machine gate. Only generalizations reach Greg.**

This is the whole design. Everything else is mechanism.

Objection, stated fairly: the `active` guard exists so an un-curated judgment cannot leak
into a session as canon (`taste-store.ts:368`). Removing it means wrong units can be
retrieved. True. Three things make the trade worth taking:

1. The guard's realized precision/recall is 100% / 0%. Any nonzero recall beats it.
2. An instance is advisory context, not a command, and it competes for 5 slots against
   better-matching neighbors. It is outranked, not obeyed.
3. It stays reversible — `hive taste reject <hash>` demotes and blacklists the
   `dedupe_key` so it cannot re-admit. **This must ship with the inversion, not after.**

The 10 units Greg approved this afternoon are the seed. Future ones admit on their own.

---

## 4a. Course correction (Greg, 2026-08-16, after slice 1 shipped)

**Principles are the durable artifact. Memory is the operational one. Taste units
are scaffolding toward principles, not a product in their own right.**

The evidence that forced this: of the first 15 admitted units, several restate
principles already injected into every session. *"Don't over-engineer privacy for
data that doesn't warrant it"* is **Defend in proportion** with an example bolted
on. *"Don't invent new names for established concepts"* and *"Name concepts for
what they literally do"* are near-duplicates of each other, and both ladder to
principles you already have. An instance layer that mostly paraphrases the
always-on layer is duplicating context, not adding it.

Meanwhile memory carries the thing that actually helps an agent do the work in
front of it: what happened in previous sessions, and what is true about *this*
project. That is where the leverage is — 126 productive `search_memory` calls
against 15 taste units.

### What this changes

| | before | after |
|---|---|---|
| taste units | retrievable product, gated for precision | evidence for principle change |
| weekly review | contradiction queue | **principle proposals** |
| `search_taste` | invest in precision, dedupe, ranking | leave running, stop investing |
| next focus | slices 3–5 (pressure, TD, gate) | **memory lookup quality** |

### What survives, and why it matters more now

- **Slice 2 (closed enum) is more important, not less.** The entire question is
  now "which principle does this touch, and does it change it." That question is
  unanswerable while a third of ladder targets are invented.
- **Semantic dedupe survives, with a different justification.** Recurrence is no
  longer a gate on retrieval — it is the *evidence* that a judgment is real
  enough to touch `principles.md`. Key drift (`read-before-edit-file-state-tracking`
  / `read-before-edit-tool-constraint` / `read-before-write-existing-files` — one
  judgment, three keys, three singletons) breaks the evidence chain. It matters
  more under this framing than the last one.
- **Slices 3–5 collapse.** Keep the path that turns accumulated instances into a
  principle proposal; drop the retrieval-facing gate machinery, the pressure
  dashboard, and the card UI. A monthly proposal into the inbox that Greg
  hand-applies to `principles.md` is the whole feature.

### Deferred, not rejected

The behavioral instrument (correction-rate in sessions that retrieved taste vs.
sessions that didn't — 588 divergence flags across 71 sessions are already on
disk) is worth running if the unit layer ever needs justifying again. Under this
correction it doesn't: units are judged by whether they produce good principle
proposals, which is directly observable at the weekly review.

---

## 5. The messy middle

The part that was hand-waved. Here is the full lifecycle of one observation.

```
  TA/TB          observation → candidate
    │
  TC             dedupe/merge by dedupe_key
    │            ├─ new           → unit @ holding, recurrence 1
    │            └─ seen before   → recurrence += 1
    │
  TC gate        recurrence ≥ 2  AND  replay not-failed
    │                     │
    │                     └────────────→  unit @ ACTIVE     ← machine, retrievable now
    │
  TC relation    pick ladders_up_to from a CLOSED ENUM of the 20 headings, or none
    │
    ├─ covered     principle already implies it        → no pressure     (expect majority)
    ├─ extends     principle is silent on this case    → +1 pressure on P
    ├─ contradicts conflicts with the principle        → +1 pressure on P, always surfaces
    └─ uncovered   no heading fits                     → +1 to the orphan pool
    │
  TD (new)       WEEKLY. For each principle with unresolved pressure ≥ 2,
    │            and for each orphan cluster ≥ 3, draft one proposal.
    │
  GATE           Greg approves / edits / rejects. Decision resolves the pressure.
    │
  principles.md  changes. Injected everywhere from the next session.
```

### What changes vs. today

- **The gate moves.** `pending → active` stops being a human decision and becomes the
  existing recurrence + replay gate. `pending` as a status disappears.
- **The coherence question changes.** Not "instantiates / orthogonal / tension" over an
  open vocabulary, but a closed-enum ladder plus *does this change what the principle
  would tell you to do?* `covered` is the boring majority answer and it costs nothing.
- **TD is new.** It is the missing pass — the one that turns instances into a proposed
  generalization.
- **Pressure is new state.** It lives per-principle and persists across nights.

### Why TD is per-principle and weekly, not per-instance and nightly

Per-principle, because three `extends` on *Show, don't narrate* want **one** sentence,
not three amendments. TD writes in light of all the accumulated pressure at once.

Weekly, because the HITL research is consistent on this: batch similar cases, use
exception-only triggers, present an evidence pack, and a human clears the set in minutes.
Nightly amendment cards would put a decision in front of Greg most days for a file that
should change a few times a quarter.

Detection stays nightly (pressure accrues every night). Only the drafting and the card
are weekly.

### Convergence guard

A rejected proposal **resolves** its pressure units as `resolved:rejected`. They never
pressure again. Without this, every rejected amendment re-fires next week forever — the
same bug as deduping against *accepted* instead of against *seen*.

TD may also return `no change warranted`, which resolves the pressure as `covered`
retroactively. That is the escape valve for pressure that looked real and wasn't.

### Thresholds (initial, to tune)

| | value | basis |
|---|---|---|
| unit → active | recurrence ≥ 2, replay not-failed | existing `minRecurrence` default (`taste-consolidate.ts:317`) |
| amendment draft | unresolved pressure ≥ 2 on one principle | one-off `extends` shouldn't move canon |
| new-principle draft | orphan cluster ≥ 3, semantically related | today's standing pressure is 15 units — it would fire |
| retrieval | top-k 5, floor 0.25 × top | unchanged; already correct |

The orphan threshold needs *clustering*, not counting. Three unrelated orphans are not a
principle. This is a TD judgment call, not a counter.

---

## 6. The gate

One dashboard surface. Two cards. Most weeks it is empty, and that is the design working.

**Card A — Amendment**

> **↑ Defend in proportion** — 2 units say this is too narrow
>
> **Now:** "Risk buys defense — without risk, the guard is theater."
> **Proposed:** *(+)* "…but a guard on a write path into canon is never theater."
>
> Motivated by: `memory-write-paths-need-guards` (3×), `candidates-never-bypass-verifier` (2×)
> — with evidence anchors
>
> `[y] amend` `[e] edit` `[n] reject` `[d] defer`

**Card B — New principle**

> 4 units ladder to no principle and cluster around *workspace hygiene*
>
> · `leave-workspace-clean-after-tooling`
> · `cleanup-verification-artifacts-before-push`  …
>
> **Proposed:** *(draft heading + body)*
>
> `[y] accept` `[e] edit` `[n] not a principle` `[s] split`

There is no instance card. Instances no longer need approval — that is the point.
Visibility is not approval: `/taste` stays browsable read-only, and `hive taste reject`
is always available.

---

## 7. Retrieval

Largely done. For taste, the only change is that the `active` filter now has content
behind it.

Two things to carry forward when memory adopts this:

1. **Hard top-k with a reported overflow.** `"showing 8 of 41 — refine or raise limit"`.
   A cap that hides what it dropped reads as coverage it doesn't have.
2. **Episodic excluded by default.** Session logs currently blend into every
   `search_memory` result under `### Session Log (raw)`. They belong behind an explicit
   flag, not in the default recall path.

---

## 8. Implementation — taste first

Slices, each shippable and green on its own.

> **Status 2026-08-16:** slices 1 and 2 shipped. Slices 3–5 are superseded by
> §4a — keep the principle-proposal path, drop the retrieval-facing gate
> machinery. Next focus is memory lookup quality (§9).

**Slice 1 — Unblock retrieval (the inversion)** ✅
- `pending → active` on the existing recurrence + replay gate; retire `pending`
- `hive taste reject <hash>` — demote + blacklist `dedupe_key`
- Migrate the 9 currently-pending units through the new gate
- *Done when:* `search_taste` returns units on a cold store with no human in the loop

**Slice 2 — Close the enum** ✅
- TC receives the 20 headings as a closed enum; `ladders_up_to` must be one of them or null
- Reclassify the 10 units on invented rungs — most become `uncovered`
- Replace three-way coherence with `covered / extends / contradicts / uncovered`
- *Done when:* zero ladder targets fail validation against `principles.md`

**Slice 3 — Pressure**
- Persist per-principle pressure and the orphan pool across nights (fixes D3)
- Nightly accrual; `resolved:{accepted,rejected,covered}` states
- *Done when:* today's 15 standing units show as pressure instead of vanishing

**Slice 4 — TD (distill)**
- Weekly Opus pass: principle + its pressure + evidence → proposed text, or "no change"
- Orphan clustering → new-principle draft
- *Done when:* TD produces a non-trivial amendment against the real store

**Slice 5 — The gate**
- `/review` dashboard page, Cards A and B, decisions write `principles.md` + resolve pressure
- *Done when:* an approved amendment changes `principles.md` and the pressure clears

Slices 1–2 are the ones that matter most and are the least speculative. 3–5 should not
start before 2 lands, because pressure accumulated against invented rungs is garbage.

---

## 9. What memory adopts later

Memory already has machine admission — the verifier — so it skips the inversion entirely.
It needs three things, and one of them shouldn't wait:

1. **Read cap** (`top_k` default 8 + overflow notice) and **episodic excluded by default**.
   This is a bug fix, not a design change. Ship it independently of everything above.
2. **Gap dedupe** — TK-147.
3. **TD over facts → conventions**, reusing whatever slice 4 builds. Same pass, different
   store: the generalization target is a project's Conventions section rather than
   `principles.md`.

Taste first is right because taste needs the full stack and memory needs a subset. Build
it where it's all required, then port down. 99 units is also a much cheaper place to be
wrong than 1,000+ memory entries.

**Cross-project memory: dropped** (Greg, 2026-08-16). Not deferred — deleted. Projects
differ, and facts are the least portable content in the system: "revrec's deposit
reconciliation fires on 47/54 rows" has no business near dobby. The portable layer
already exists twice — `principles.md`, injected everywhere and human-curated, and
taste's `general-taste` scope. A third mechanism aimed at the least-portable content
would be the worst of the three.

### Shipped 2026-08-17

The three small changes, and nothing else:

1. **Relevance floor** at 0.25 × top score, ported from `searchTasteStore`. This does the
   real work — a sharp query returns two or three results because only two or three are
   close to the best match. It adapts where a fixed `k` can't.
2. **Hard `topK` of 8** as the backstop, with the overflow reported
   (`Showing top 8 of 31 …`) so a cap never reads as coverage it doesn't have.
3. **Session logs excluded by default**, `include_logs` to opt in. They come out of the
   BM25 corpus too, not just the results — they dominated the document count, which
   skewed IDF against the compiled knowledge worth ranking.

Plus one thing found while wiring it: **retrieval strengthening was bumping every entry
that scored above zero**, up to 162 on a single search. That flattens the decay signal it
exists to sharpen — if everything is recalled, nothing ever ranks lower. Now it bumps only
what was returned, and dedupe probes pass `noBump` so an internal check no human reads
can't strengthen anything. Same fix TK-133 made for the auto-loaded index.

Measured on the real store, same query that returned 47 results / ~12k tokens that
morning: **8 of 31, ~1,266 tokens.**

### Then measured, same day — "is the top N the right N?"

A known-answer harness: pick queries whose correct entry you can name, then find that
entry's rank in the *full* ranking (`topK` huge, `floor` 0). The rank tells you which
fix applies — **low rank is a reranking problem; absent is a tokenization problem.**

```
                                          before      after
test fixture timestamps flaky nightly       1 / 67      1      ✅
install the hive binary after building      2 / 275     1      ✅
where do taste units get stored            16 / 65      3      ✅ was below the cap
what model does the verifier use            — / 251    51      ⚠️ scored ZERO
```

The fourth case is the finding. `tokenize()` did no stemming, so `model` ≠ `models` and
`verifier` ≠ `verifies`. All six query terms missed, BM25 returned 0, and the entry was
**invisible rather than low-ranked** — silent zero-recall, indistinguishable from never
having learned the thing. A reranker could never have fixed it: you cannot rerank a
candidate that never entered the pool. My recommendation to defer precision work was
wrong, and the measurement is what overturned it.

**Shipped: conservative suffix stripping.** Rules ordered longest-first, first match wins,
and a rule is *rejected* if it would leave a stem under 4 chars. That guard is what bounds
over-merging: "notes" declines the `es` rule (would give "not") and falls through to `s` →
"note". verify/verifies/verifier/verified converge on `verif`; store/stores/stored/
storing/storage on `stor`. Deliberately lighter than Porter — correctness here is
convergence, not linguistics, since query and document run through the same function.

**Cap raised 8 → 10**, on evidence rather than taste. The floor already trims sharp
queries on its own, so the cap only binds on *vague* ones — exactly the queries that need
more recall, not less. Two reasonable phrasings put truth at rank 9 and 10, so 8 was
slicing the band where truth sometimes sits. Costs ~250 tokens.

The surviving rank-51 case is substantially a **query** problem: naming "pass V" moves the
same entry to rank 5–10. Both content terms in "what model does the verifier use" are
low-IDF across this corpus.

Still deliberately NOT shipped: the LLM rerank. It now has a demonstrated target (the
rank 9–51 band) but stemming may have taken most of what it would have won. TK-148
re-measures in a week and decides.

---

## 10. Open questions

1. **Does `pending` disappear entirely, or survive for `contradicts` units?** A unit that
   contradicts a principle is the one case where auto-admitting is genuinely risky —
   it will be retrieved and it disagrees with something injected everywhere. Leaning:
   `contradicts` units hold until the gate resolves them. Everything else auto-admits.

2. **Who owns `principles.md` writes?** TD drafts, Greg approves, but the file is also
   part of the identity stack and hand-edited. It needs a `_meta.json` sidecar recording
   which amendments touched which heading, or the provenance is lost.

3. **Weekly on what trigger** — a cron, or "when pressure crosses threshold, at most
   weekly"? The second avoids empty cards but makes the cadence unpredictable.

4. **Replay is currently inconclusive-by-default** — no corpus means FUZZY candidates stay
   in holding (`taste-consolidate.ts:324-328`). With the human gate gone, replay becomes
   the primary quality signal. Does it need to get stricter, or is recurrence ≥ 2 enough?

---

## Sources

- [The Consolidation Problem in Agent Memory — Hindsight](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation)
- [Beyond Recall: Behavioral Specification as an Interpretive Layer (arXiv:2605.28969)](https://arxiv.org/pdf/2605.28969)
- [How Memory Management Impacts LLM Agents: Experience-Following Behavior (arXiv:2505.16067)](https://arxiv.org/pdf/2505.16067)
- [Types of AI Agent Memory: Episodic, Semantic, Procedural (CoALA taxonomy)](https://atlan.com/know/types-of-ai-agent-memory/)
- [Context rot explained — Redis](https://redis.io/blog/context-rot/)
- [Human-in-the-Loop AI Agents: designing approval workflows](https://www.stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation)
