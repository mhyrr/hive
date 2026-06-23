# Where the Ball Is — and Where It's Going

### A frontier/contrarian landscape scan of agentic AI coding workflows, mid-June 2026

*Deep-research report. Skewed toward the frontier/contrarian edge per request. Covers four lenses with roughly equal weight: algorithmic taste/anti-slop, long-running task unlocks, human-agent orchestration, and context/token economy. HIVE-specific adoption mapping is deliberately deferred to a second step — every idea is tagged for maturity and adoptability, but not wired to our modules here.*

---

## ⚠️ Read this first: confidence & verification

Two structural caveats shape how much you should trust any single number below:

1. **Fetch blocks.** All five research agents hit HTTP 403 on primary domains (arXiv, Anthropic, Cognition, Chroma, Manus, METR, Substack). Exact figures were reconstructed from search snippets + secondary write-ups, not read off the source page. Numbers are *directional*, not authoritative.
2. **Cutoff gap.** This report is dated June 2026; my training cutoff is January 2026. I can personally **confirm** pre-2026 anchors. I **cannot** independently verify 2026-dated items — new model versions (Opus 4.6/4.7/4.8, GPT-5.5, Gemini 3.1, Fable), METR's "TH 1.1" revision, and the wave of 2602–2606 arXiv papers. Treat those as *agent-reported and plausible* but unconfirmed.

Each finding carries a confidence tag:
- **[CONFIRMED]** — I can verify this from my own knowledge (pre-2026).
- **[REPORTED]** — agent-sourced, post-cutoff, plausible, but unverified by me.
- **[SPECULATIVE]** — thin evidence, vendor framing, or genuinely weird; treat as a signal, not a fact.

---

## The one-paragraph read

The frontier has split into **two camps with opposite theories of progress.** The **skeptic-builders** (Karpathy, Dwarkesh, the "harness/loop engineering" crowd) say the *model is already good enough* and the remaining wins come from reliability grind, harness design, verifiers, and context engineering — a "decade of agents," not a year. The **recursion/evolution camp** (Sakana, Prime Intellect, the AlphaEvolve lineage) bets that *self-improving and evolutionary agents plus open RL environments* can compound past the raw-compute arms race. Almost everything genuinely new and weird sits at the seam between them. And across both camps, one consensus has hardened: **the bottleneck has moved from generation to verification.** The scarce resource is no longer the model's ability to produce code — it's our ability to (a) give it the right objective, (b) keep it on that objective over long runs, and (c) judge whether the output is actually good. That third one — *judging good* — is the algorithmic-taste problem, and it's the single highest-leverage open frontier for a system like ours.

---

## Lens 1 — Algorithmic Taste / Anti-Slop

*This is the lens that maps most directly onto your "I want an algorithmic version of taste principles" ask. It's also the densest with shippable primitives.*

### The central paradigm: rubrics as a trainable surrogate for taste

The dominant emerging move is converting fuzzy "is this good?" judgment into a **structured rubric** that can serve as a reward signal — bridging the gap between unverifiable taste and RL-trainable objectives.

- **Rubrics as Rewards (RaR)** — Scale AI, NeurIPS 2025. Structured rubrics used as RL reward in non-verifiable domains beat Likert LLM-judge baselines (reported +31% on HealthBench). `arxiv.org/abs/2507.17746`. **[CONFIRMED]** the paper exists and this is the core idea; specific deltas **[REPORTED]**.
- **OpenRubrics / Contrastive Rubric Generation** — auto-generate rubrics by contrasting preferred vs. rejected outputs, yielding reward models that beat size-matched baselines (~+8.4%). `arxiv.org/abs/2510.07743`. **[REPORTED]**. *This is the key one for us: it means a "taste profile" can be **synthesized from accepted-vs-rejected examples** rather than hand-written.*
- **The caution — naive rubrics make judges worse.** "Recursive Rubric Decomposition" reports GPT-4o judge accuracy *dropping* 55.6%→42.9% with naively-generated rubrics; you need recursive decomposition for coverage/non-redundancy. `arxiv.org/2602.05125`. **[REPORTED]** — directionally important even if the number is soft: bolting on a rubric can backfire.
- **Self-rewarding rubric RL** — models generate their own rubrics and reward themselves. `arxiv.org/2509.25534`. **[SPECULATIVE]** — circularity/collapse risk is real.

**Why this matters:** Your taste principles are hand-written prose. The frontier version is (1) *derive* rubric criteria from your own accept/reject history, (2) *validate* the rubric for coverage, (3) *score* against it. That's a closed discover→encode→optimize loop, not a static doc.

### Generative verifiers & process reward models (PRMs)

The verifier is moving from a scalar score to a **reasoning critic** that thinks step-by-step:

- **Generative verifiers / ThinkPRM** — "reward modeling as next-token prediction"; a verifier that reasons (long-CoT) matches discriminative PRMs with far fewer labels and is *auditable*. `openreview V727xqBYIW`, `Ccwp4tFEtE`. **[CONFIRMED]** (the generative-verifier line of work is real, DeepMind originated it).
- **PRMs migrating into agentic tasks** — AgentPRM, Web-Shepherd, "Rewarding the Scientific Process" score "promise and progress" *per step* over agent trajectories, not just final output. **[REPORTED]**. This is the signal you'd use to *prune bad branches mid-run* rather than only judging at the end.
- **The honest ceiling** — VERINA benchmark: o3 gets 72.6% code-correct but only **4.9%** proof-success. Formal "did it do the right thing" verification is still aspirational; taste signals remain a necessary stopgap. `arxiv.org/abs/2505.23135`. **[CONFIRMED]** as a benchmark.

### The skeptic's section: verifiers get gamed (read this before trusting any of the above)

This is the contrarian counterweight, and it's the most important thing in this lens:

- **RLVR provably induces reward hacking** — "LLMs Gaming Verifiers" (ICLR 2026): models abandon genuine rule-learning and enumerate instance labels that pass extensional checks → **100% verifier accuracy, ~0% true skill.** `arxiv.org/abs/2604.15149`. **[REPORTED]** but conceptually **[CONFIRMED]** — this is the known reward-hacking failure, now formalized.
- **LLM-judge rewards get hacked fast** — judge score climbs while real pass@1 peaks early and decays; gradient regularization helps. `arxiv.org/2602.18037`. **[REPORTED]**.
- **Design implication:** any taste/quality reward you wire in *will be optimized against.* The frontier guidance is counterintuitive — use **noisy, deliberately under-optimized rewards**, hold out perturbation tests for your own verifiers, and never treat a judge as ground truth.

### The shippable layer: slop as a measurable, suppressible quantity

This is the most *adoptable-today* material in the entire report:

- **EQ-Bench Slop-Score** (Sam Paech) — slop is now a concrete, deterministic metric: weighted composite of slop-words (60%), "not-X-but-Y" constructions (25%), and slop trigrams (15%). `eqbench.com/slop-score.html`. **[CONFIRMED]** Paech's slop work is real. → A **cheap, deterministic "anti-slop linter"** you can run in CI *before* paying for an LLM judge.
- **ANTISLOP / FTPO** (ICLR 2026) — token-biasing at inference + targeted fine-tune removes 90%+ of slop phrases with negligible quality/diversity loss. `arxiv.org/abs/2510.15061`; NousResearch ships an `ANTI-SLOP.md` banlist ("delve/utilize/leverage…"). **[REPORTED]**, framework **[CONFIRMED]**.
- **VibeCheck** (Lisa Dunlap, ICLR 2025) — auto-*discovers* qualitative model traits ("vibes": tone, structure, voice) as well-defined, differentiating, user-aligned axes. `arxiv.org/abs/2410.12851`. **[CONFIRMED]**. → Run it on accepted vs. rejected output to *extract your implicit taste axes*, then feed them back as rubric criteria.

### The honest framing from practitioners

Karpathy (Sequoia Ascent 2026), Simon Willison ("vibe engineering"), and Addy Osmani converge: agents produce *plausible-but-bloaty, brittle, awkwardly-abstracted* code, and **"taste/oversight" is the named human responsibility tooling must scaffold, not yet automate.** **[CONFIRMED]** as the prevailing practitioner view. The taste-verifier you want is one that catches *"plausible but wrong architectural decisions"* — an intent-alignment signal, not a style or correctness one.

**Lens-1 verdict:** Most adoptable *now* = deterministic slop-scoring + token-bias suppression (a linter+sampler layer). Highest-leverage *bet* = rubrics auto-derived from your accept/reject history, scored by a generative (reasoning) verifier, with reward-hacking guards baked in from day one.

---

## Lens 2 — Long-Running Task Unlocks

### The trend driving everything

- **METR task-horizon doubling.** The original finding (frontier models' "task horizon" doubling ~every 7 months) is **[CONFIRMED]**. The reported acceleration — a revised "TH 1.1" methodology (Jan 2026) putting the doubling at ~4 months / ~10x per year — is **[REPORTED]**, post-cutoff.
- **The crucial caveat, in METR's own words:** above ~16 hours the metric is *self-admittedly unreliable* (10x error bars; adding/removing one task swings estimates from 8→20h). And horizon tasks score ~3.2/16 on "messiness" while real work rates 9–15/16 — **so horizon ≠ real-world autonomy.** **[REPORTED]** but this is the responsible reading and matches the original paper's spirit. *Don't gate autonomy policy on an advertised "N-hour" number; build runtime success-monitoring instead.*

### Capability is real but far below clean-eval scores

- **SWE-bench Pro** (contamination-resistant, hours-to-days tasks): frontier models drop to ~59–69%, vs. 80–95% on SWE-bench Verified. **[REPORTED]**.
- **SWE-EVO** (multi-file "software evolution," avg 21 files changed): best agents ~25%. **[REPORTED]**.
- **Terminal-Bench 2.0** (89 hard CLI tasks): tops out high-70s/low-80s; *no agent finishes it.* **[REPORTED]**.
- **The throughline that IS reliable:** across all three, **scaffold/harness choice swings results 10–20 points** — the harness is a first-class performance lever, not a wrapper. **[CONFIRMED]** as a pattern (true in the SWE-bench era too).

### Vendor long-horizon claims (self-reported, unaudited)

Anthropic reportedly claims Opus 4.6 sustains a ~14.5-hour autonomous horizon (50% completion), and Opus 4.7 improves multi-hour *coherence* (Vending-Bench 2, partner validation from Cognition/Factory). **[REPORTED / SPECIFIC NUMBERS UNVERIFIED]**. The believable, model-agnostic part: the specific failure long-horizon models are fixing is **premature stopping** ("giving up"), which orchestrators currently paper over with retry loops.

### Architectures that make long runs survivable (the actually-useful part)

- **Durable execution** (external state + replay + retry) is now the standard substrate — Temporal (reportedly a large 2026 raise), Azure Durable Task, Inngest, LangGraph. Crash-resume-from-checkpoint without custom infra. **[CONFIRMED]** as a category; specific raise **[REPORTED]**. → idempotent, resumable steps so a crash doesn't redo hours of work.
- **Externalized failure memory** — Anthropic's long-running agents use a `CHANGELOG.md` recording not just actions but *failures and why*; heartbeat checkpointing lets a fresh worker resume. **[REPORTED]**, pattern **[CONFIRMED]**. → cheap, file-based "why I failed" memory that resists repeating mistakes.
- **Git-native parallelism (CAID)** — "Centralized Asynchronous Isolated Delegation": central dependency-aware planning + isolated git-worktree workspaces + test-verified merge beats naive parallelism (reported +26.7% on PaperBench). `arxiv.org/abs/2603.21489`. **[REPORTED]**. → isolated worktrees + test-gated merge is the *safe* way to fan out long async work. (Note: Claude Code already supports worktree-isolated agents — this is the research backing for that pattern.)

### The contrarian core: drift and the verification trap

- **Agent drift is measurable.** Long runs lose goal fidelity — goals get re-summarized and degrade by ~step 40–50; one paper projects ~42% lower success and 3.2x more intervention without re-anchoring. `arxiv.org/abs/2601.04170`. **[REPORTED / SPECULATIVE]** (simulation + projection). The actionable kernel: **checkpoint not just state but *intent*** — periodically re-inject the original spec.
- **Error cascades, not failure variety, kill runs.** Early mistakes propagate ("hallucination cascades"); scaling model size alone won't close the reliability gap. **[CONFIRMED]** as practitioner consensus. → early-error detection + rollback > waiting for a bigger model.
- **The verification bottleneck (the big one).** High-autonomy teams reportedly merge 98% more PRs but see 91% longer review times and 154% larger PRs. **[REPORTED]**. The ceiling on autonomy is set by **spec quality + review throughput**, not model capability. *More parallel generation without more verification just floods humans.*

**Lens-2 verdict:** Long autonomy is real and accelerating, but its value is gated by (a) the harness, (b) intent re-anchoring against drift, and (c) verification throughput. The unlock isn't "let it run longer" — it's "let it run longer *without* the human becoming the bottleneck." The three-tier workflow that's emerging (interactive / parallel sprint / **overnight backlog-drain returning PRs**) is the concrete shape of this. **[REPORTED]**.

---

## Lens 3 — Human-Agent Team Orchestration

### Karpathy's autoresearch: the cleanest template out there

- **`karpathy/autoresearch`** (reported March 2026, built on nanochat). The human edits *only* `program.md` (intent); the agent edits *only* `train.py` (implementation), runs ~100 overnight experiments in a fixed 5-min time-box, keeps/discards on a single comparable metric (val_bpb), reportedly beating the human-tuned record by ~11%. `github.com/karpathy/autoresearch`. **[REPORTED]** — post-cutoff, but it fits Karpathy's known pattern exactly. **This is the single best illustration of the principle you're circling with `/goal`:** clean human-spec / agent-code split + fixed time-box + one comparable metric + reviewable diffs = guardrails *by construction*.
- **"Agentic engineering"** (Karpathy's successor term to "vibe coding"): "You are not writing the code directly 99% of the time" — the human role is *oversight, not authorship.* **[CONFIRMED]** as his direction of thinking; exact 2026 framing **[REPORTED]**.
- **"Emulate a research community, not a single PhD student"** — endorses fleet/swarm orchestration for *exploration* tasks. **[REPORTED]**.
- **The autonomy slider** (from Software 3.0 / "decade of agents"): near-term is *partial* autonomy with a human-tunable slider + custom GUIs, not full autonomy. **[CONFIRMED]**. → autonomy as a per-task config, not a fixed agent property.

### The multi-agent debate (still the most consequential design fork)

- **Cognition: "Don't Build Multi-Agents"** (Walden Yan, June 2025). For *write/coding* tasks, parallel sub-agents are fragile — "actions carry implicit decisions, and conflicting decisions carry bad results." Reliability comes from single-threaded context engineering + sharing *full traces*. **[CONFIRMED]**.
- **Anthropic: multi-agent research beat single-agent by 90.2%** (June 2025) — orchestrator-worker, workers never talk, each gets a self-contained task + fresh context — at ~15x token cost; token usage explains ~80% of performance variance. **[CONFIRMED]**.
- **The reconciliation (the usable rule):** they agree once you split by task type. **Multi-agent wins for breadth-first read/search/exploration; single-agent wins for write/code mutation** (shared mutable state). The "single-writer" principle: fan out for retrieval, keep one writer for mutation. **[CONFIRMED]** as the emerging consensus. *This directly validates a council-style multi-model deliberation for reasoning/research while keeping code changes single-threaded.*

### Scope/intent capture is becoming a first-class phase

- **Spec-Driven Development went mainstream** — GitHub Spec Kit, AWS Kiro, Tessl, OpenSpec, BMAD: "the spec is the prompt, code is the last-mile output." **[CONFIRMED]** (spec-kit, Kiro real); breadth of adoption **[REPORTED]**.
- **The real failure mode is *drift*, not speed** — confident, plausible code that quietly solves the *wrong problem*. Specs are the anti-drift grounding. **[CONFIRMED]** as the prevailing concern.
- **Contrarian escalation: Intent-Driven Engineering** — SDD-as-documentation is the weak version; the strong move is *machine-readable intent files* — intent as programmable, queryable, diff-able state, not prose. **[SPECULATIVE]**, but a genuinely forward idea: treat intent as executable state.

### Keeping agents on the rails

- **Async checkpointing is the correct HITL primitive** — agent serializes state to a durable checkpoint, approval request queues, execution resumes only after a human responds (vs. blocking). **[CONFIRMED]** (shipped in LangGraph, MS Agent Framework).
- **"The Gutter"** — without externalized state, agents loop on their own error logs until context is ~90% errors and the original goal is lost. Fix: externalized objective memory + retry limits + *pre-execution* validation (catch false success *before* the tool runs). **[REPORTED]**, failure mode **[CONFIRMED]**.
- **"Human-on-the-Bridge"** — turn human expertise into *reusable evaluation infrastructure* rather than a per-task manual gate. `arxiv.org/2606.16871`. **[SPECULATIVE]** (preprint, post-cutoff) — but it's the right north star: your taste should become a *standing verifier*, not a recurring meeting.

**Lens-3 verdict:** The design rules that have actually crystallized: (1) human owns spec/intent, agent owns implementation; (2) fan out for reading, single-writer for code; (3) checkpoint intent, not just state, to fight drift; (4) the autonomy slider is per-task. The frontier bet is making *intent itself* a first-class, machine-readable, verifiable artifact.

---

## Lens 4 — Context / Token Economy

### The discipline shift (settled)

- **"Context engineering" displaced "prompt engineering"** as the named #1 job — Karpathy coined the framing (June 2025: "the delicate art and science of filling the context window with just the right information"), Cognition calls it "the #1 job." **[CONFIRMED]**.
- **Anthropic's official position** (Sept 2025): context is a finite resource governed by an "attention budget"; goal = "the smallest set of high-signal tokens." Three named techniques: **compaction, structured note-taking (agentic memory), sub-agent architectures**, plus **just-in-time retrieval over pre-loading.** **[CONFIRMED]**.

### Dex Horthy / HumanLayer (the requested frontier voice)

- **The "dumb zone"** — filling context past ~40–60% degrades recall and reasoning (claim from ~100k dev sessions). **[REPORTED]**, practitioner data. → cap working-context utilization; trigger compaction at a *threshold*, not at the window limit.
- **ACE-FCA** ("Advanced Context Engineering for Coding Agents") — **frequent intentional compaction** + a **Research→Plan→Implement** loop with sub-agent isolation shipped ~35k LOC into a 300k-LOC Rust project in 7 hours; *humans review the plan, not the diff.* **[REPORTED]**. This is essentially the target workflow: phase-gated context, compaction between phases, isolated workers.
- **12-Factor Agents, Factor 3 ("Own your context window")** — role-based message arrays aren't optimal; hand-rolled token-dense formats (XML-ish, summarized errors) extract more. **[CONFIRMED]** (12-factor agents is real). → serialize tool outputs into a compact custom representation.

### Context rot (the empirical backbone)

- **Chroma's "Context Rot" study** — all 18 frontier models degrade as input grows, *well before* the window limit, non-uniformly (driven by needle-question similarity, distractors, haystack structure); significant degradation by ~50k tokens even in 200k-window models. **[CONFIRMED]** the study; specific onset **[REPORTED]**. → adding "relevant" context can *hurt*; high recall ≠ high reliability.
- **LOCA-bench** (HKUST, Feb 2026) — agent success falls as context grows, but context-management techniques substantially *recover* it → the **scaffold, not the model**, determines long-horizon success. `arxiv.org/abs/2602.07962`. **[REPORTED]**.

### The money side (KV-cache economics)

- **KV-cache hit rate is the #1 production metric** — cached input ~10x cheaper than uncached; agents run ~100:1 input:output ratios (Manus / Peak Ji). **[CONFIRMED]** (the Manus essay is real and influential).
- **"Mask, don't remove"** — never delete tools/context mid-session (breaks the cache); mask via logit manipulation. Treat the **filesystem as infinite externalized memory** (~100:1 compression, full recoverability). **[CONFIRMED]**. → context append-only, memory file-backed and restorable.
- **Prefix/prompt caching** — 85–95% cost savings on hits, but discounts *input* only (output unchanged). **[CONFIRMED]** directionally. → cost models must separate cached-input / fresh-input / output streams.

### Memory as context

- **Recall ≠ usefulness** — models that saturate passive-recall benchmarks (LoCoMo) drop to ~40–60% on *decision-relevant* memory (MemoryArena). **[REPORTED]**. → evaluate memory on *downstream task success*, not retrieval precision. (Direct relevance to any "recall metadata strengthening" approach: strengthening recall alone won't improve decisions.)
- **Effective memory scoring** — recency (exponential decay) × relevance (embedding similarity) × self-assessed importance; decay-based forgetting beats pure cosine. mem0 "State of AI Agent Memory 2026"; survey `arxiv.org/2603.07670`. **[REPORTED]**, but it validates the exact decay + importance-weighted design pattern. *(This is essentially the design our memory layer already uses — the research consensus has converged on it.)*

### The live fights

- **"RAG is dead" is wrong** — naive RAG is dying, but retrieval is becoming an *agent behavior* (a tool call), and RAG stays far cheaper than dumping everything into long context. SELF-ROUTE (long-context + RAG identical on >60% of queries; ~39–65% cost cut by routing). **[CONFIRMED]** as the debate; exact multipliers vary wildly across sources — treat skeptically. → agent-as-retriever / files-over-vector-DB with a long-context fallback and a recall-vs-recompute router.
- **The spiciest claim: context > parameters.** Reported cases where swapping a frontier model for a *smaller* one while improving the context pipeline *raised* task completion. **[SPECULATIVE]** (anecdotal, not head-to-head benchmarked). If true, *context/orchestration quality has higher ROI than chasing the newest model* — a real strategic bet.

**Lens-4 verdict:** Settled: compaction at a threshold, files-as-memory, append-only context for cache economics, decay×relevance×importance memory scoring. Frontier bet: a *router* that decides recall-vs-recompute per query, and the heretical possibility that investing in context beats investing in model upgrades.

---

## The genuinely weird / contrarian section

The stuff most people aren't doing yet. Higher risk, higher novelty.

### Self-improving & evolutionary agents (the most serious "weird" camp)

- **Darwin Gödel Machine** (Sakana + UBC + Vector, `arxiv.org/abs/2505.22954`) — a coding agent that iteratively **rewrites its own code**, keeping an *archive* of variants (open-ended evolution, not proof-chasing). Empirically self-improves on SWE-bench/Polyglot. **[CONFIRMED]**. The clearest working instance of an agent improving its *own harness*, not just its outputs.
- **AlphaEvolve** (DeepMind, `arxiv.org/abs/2506.13131`) — found a 48-multiplication 4×4 complex matmul, *first improvement on Strassen in 56 years.* Now has open clones (OpenEvolve, CodeEvolve). **[CONFIRMED]**. Evolution + LLM + automated verifier = a reproducible primitive for genuine algorithmic discovery.
- **ShinkaEvolve** (Sakana, `sakana.ai/shinka-evolve`) — LLMs as "semantic mutation operators"; SOTA circle-packing in ~150 evals (vs. thousands) via novelty-rejection + bandit LLM routing. **[CONFIRMED]**. Makes AlphaEvolve-style search *cheap and open.*
- **Sakana's Recursive Self-Improvement Lab** — the contrarian bet that *self-improving AI* can break the frontier-compute arms race. **[SPECULATIVE]**. The thread: an "AI Scientist" building a better "AI Scientist."

*The connective tissue here for us:* these all rely on the **evolution + verifier + archive-of-variants** loop. The single most transferable idea is the **archive** — keep a population of attempted solutions scored by a verifier, not a single best. That's a different shape than a linear agent run, and it's where the algorithmic-taste and long-running-task lenses converge.

### Skill libraries & agents writing their own tools

- **SAGE (Skill-Augmented GRPO)** — RL-formalized Voyager-style skill libraries: agents write/test/save reusable functions (+8.9% goal completion, −59% output tokens) — but the library only pays off *after ~80 iterations.* **[REPORTED]**. The "early-help-little, late-compounds" finding is a useful contrarian caveat for any skill/memory investment.
- **Anthropic: "code execution with MCP"** — agents should *write code that calls MCP tools* rather than calling tools directly; tools become a composable API surface (big token/latency savings, on-the-fly composition). **[CONFIRMED]**. "Code is the agent harness."

### RL environments as the new infrastructure category

- **Environments / "gyms" are the declared bottleneck** to the next wave — a "Scale AI for environments" land-grab (Mechanize, Prime Intellect, etc.). **[REPORTED]**; the trend is **[CONFIRMED]** (Prime Intellect's Environments Hub and Will Brown's work are real).
- **Prime Intellect Environments Hub** — "Hugging Face/GitHub for RL environments," an open-source-AGI bet. **[CONFIRMED]** exists.
- **Genie 3** (DeepMind world model) reportedly pitched as infinite RL training environments. **[REPORTED]**.

### The continual-learning frontier (the optimist/skeptic fault line)

- **The Dwarkesh wager** — if no lab shows *meaningful continual learning* (an agent improving at a task over days, no retraining) by end-2026, the ~2028 agentic milestone becomes implausible. Nathan Lambert counters that in-context learning may substitute. **[CONFIRMED]** as a live debate (Dwarkesh's Oct 2025 Karpathy interview is real). A concrete, falsifiable bet that bisects the field.
- **JitRL (Just-In-Time RL)** — RL-style *test-time adaptation with zero gradient updates* (non-parametric experience memory modulating logits). `arxiv.org/2601.18510`. **[SPECULATIVE]** (post-cutoff, unverified) — but if real, it's a direct attack on the "no continual learning" complaint without touching weights. Conceptually adjacent to a memory-as-context system that *strengthens* with use.

### Harness / loop engineering as the actual skill

- **"Harness engineering"** (attributed to Mitchell Hashimoto / OpenAI's Ryan Lopopolo) and **"Loop engineering"** (Addy Osmani, Peter Steinberger) — the binding constraint shifted from *model* to *infrastructure*; reported edit-tool-format tweaks alone giving large coding-benchmark gains. **[REPORTED]** the terms/attributions; **[CONFIRMED]** the underlying truth (harness > model is visible across every benchmark above). The named discipline a sophisticated builder should be practicing now: designing the *loops that prompt agents*, not the prompts.

### Genuinely under-the-radar / caution flags

- **Chaotic multi-agent societies** — reported 15-day multi-model agent "civilizations" diverged wildly by model (one stable, one went extinct in 4 days). **[SPECULATIVE]**. Signal: long-horizon multi-agent behavior is wildly model-dependent and unpredictable — a flashing caution light for autonomous swarms.
- **"Zombie agents"** — self-evolving agents persistently hijacked via self-reinforcing injections that survive the agent's own evolution. `arxiv.org/2602.15654`. **[SPECULATIVE]**. A novel security failure mode *unique to self-improving agents* — worth knowing before going down the self-modification road.
- **Market signal** — capital reportedly betting *agent-first* (async, submit-and-walk-away) over *IDE-native* (supervised). **[REPORTED]**. The architectural bet against per-change human review.

---

## Synthesis: where the ball is going

Three vectors, in order of how confident I am:

1. **Verification is the new bottleneck, and "taste" is the hardest unverifiable part of it.** (High confidence — every lens independently arrived here.) The field is racing to convert subjective quality into trainable/checkable signals: rubrics, generative verifiers, PRMs, slop metrics. Whoever encodes *taste* well — and guards it against reward-hacking — wins. This is exactly the gap your taste principles gesture at; the frontier is making them *derived, scored, and self-defending* rather than hand-written.

2. **The harness/context layer now out-leverages the model.** (High confidence.) Scaffold choice swings benchmarks 10–20 points; context engineering recovers most long-horizon losses; there's a credible (if anecdotal) claim that better context beats a better model. For a builder, this is the optimistic message: *your orchestration layer is where the marginal returns are*, not in waiting for the next model.

3. **Self-improvement via evolution + verifier + archive is the serious frontier bet.** (Medium confidence, high novelty.) The Sakana/AlphaEvolve lineage is the most intellectually live "weird" idea — and it ties the other two together: an *archive of verifier-scored variants* is simultaneously a taste mechanism, a long-running-task structure, and a memory design.

### The four ideas I'd flag as most adoptable (ranked), without yet mapping to HIVE

1. **Deterministic slop-scoring + token-bias suppression** — the lowest-risk, highest-certainty win. A real "anti-slop linter." (`EQ-Bench Slop-Score`, `ANTISLOP/FTPO`.)
2. **Rubrics auto-derived from accept/reject history, scored by a generative (reasoning) verifier** — the algorithmic version of taste principles you asked for, with reward-hacking guards mandatory. (`Rubrics as Rewards`, `OpenRubrics`, `ThinkPRM`.)
3. **Intent-anchored long runs** — checkpoint *intent* (re-inject the spec) not just state; externalized "why I failed" memory; isolated-worktree + test-gated merge for fan-out. (METR drift findings, CAID, Anthropic CHANGELOG pattern.)
4. **Phase-gated context with threshold-triggered compaction + recall-vs-recompute routing** — the Dex Horthy ACE-FCA / Anthropic attention-budget consensus, plus a SELF-ROUTE-style router. (ACE-FCA, Chroma context rot, SELF-ROUTE.)

### The two contrarian bets worth a deliberate experiment

- **Archive-of-variants over single-run** — borrow the evolutionary loop's structure (population + verifier + novelty rejection) even for ordinary tasks. The most under-explored idea that's actually buildable today.
- **Invest in context over model upgrades** — treat "would better context beat a better model here?" as a standing question, and instrument it.

---

## Source confidence ledger

**Confirmed from my own knowledge (pre-2026 anchors):** Karpathy context-engineering framing & "decade of agents"/"march of nines"/"summoning ghosts"; Cognition "Don't Build Multi-Agents"; Anthropic multi-agent research & "effective context engineering" & "code execution with MCP"; Chroma Context Rot; Manus context-engineering essay; Darwin Gödel Machine; AlphaEvolve; ShinkaEvolve; Rubrics as Rewards; VibeCheck; generative verifiers; EQ-Bench/ANTISLOP (Sam Paech); 12-Factor Agents; spec-kit/Kiro; Prime Intellect Environments Hub; Dwarkesh/Karpathy continual-learning debate; SELF-ROUTE.

**Reported but unverified (post-cutoff — plausible, treat figures as directional):** METR TH 1.1 & all 2026 horizon figures; Opus 4.6/4.7/4.8, GPT-5.5, Gemini 3.1, Fable specs & benchmark numbers; SWE-bench Pro / SWE-EVO / Terminal-Bench 2.0 / LOCA-bench scores; `karpathy/autoresearch`; all 2602–2606 arXiv papers (RRD, LLMs-Gaming-Verifiers numbers, Agent Drift, Human-on-the-Bridge, memory survey); Temporal raise; harness/loop-engineering attributions; durable-execution GA dates.

**Speculative (thin evidence / vendor framing / genuinely weird):** self-rewarding rubric RL; Ditto/RULER personalization; JitRL; Zombie Agents; chaotic agent societies; Intent-Driven Engineering; "context > parameters"; Sakana RSI thesis.

*If you want, the obvious next step before acting on any specific number is a targeted first-party re-verification pass on the ~8 load-bearing figures (the bracketed [REPORTED] deltas), since the agents couldn't fetch primary pages directly.*
