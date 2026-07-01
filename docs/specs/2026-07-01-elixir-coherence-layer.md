# A Coherence Layer for Elixir/Phoenix — Research & Concept

**Status:** Exploration (research synthesis + concept sketch, not an approved design)
**Date:** 2026-07-01
**Author:** Maya (with Greg)
**Prompt:** What are 8090.ai and Palantir's ontology actually selling, conceptually?
Is there a version of that layer for our most common stack — Elixir/Phoenix —
that gives a large, growing project *coherence* as models and agents do more
of the work?

---

## 1. The thesis in one paragraph

Models are intelligent but context-starved, and the failure mode of
context-starvation is **incoherence**: in the small, sessions rot as context
windows fill (Chroma's "context rot" study shows every frontier model
degrading on long inputs, even on trivial retrieval tasks¹); in the large,
codebases drift as hundreds of locally-reasonable changes accumulate with no
shared frame. Both 8090 and Palantir are selling the same answer at
different altitudes: a **typed, governed, machine-checked layer between
intent and model** — a structure that *delivers* the right context instead of
hoping the model discovers it, *constrains* writes to governed verbs instead
of raw edits, and *detects* drift instead of assuming it away. Chamath's
crispest formulation, from the Series A announcement: *"The hard part of
enterprise software is keeping fifty agents and a hundred engineers changing
the same complex system every week without it pulling apart."*² Karp's, from
the Q4 2025 letter: *"The strings of text produced by the language models are
little without a software architecture that can lend a grammar and structure
to the output of these probabilistic prediction engines. The models must be
tethered to objects in the real world."*³ Coherence is the product. The
question for us is what the Elixir-shaped version looks like.

---

## 2. What the sources actually say

### 2.1 Palantir: the ontology as semantic + kinetic + security

Palantir's Ontology is not (despite the name) a static knowledge graph. Its
own docs partition it into **semantic** elements — object types, properties,
link types — and **kinetic** elements — action types, functions, dynamic
security: *"the Ontology serves as a digital twin of the organization,
containing both the semantic elements (objects, properties, links) and
kinetic elements (actions, functions, dynamic security) needed to enable use
cases of all types."*⁴ The load-bearing details:

- **Objects are typed and backed.** An object type has typed properties, a
  primary key, and backing datasources. Link types are schema definitions of
  relationships. Interfaces give polymorphism.⁵
- **Writes only flow through governed actions.** *"By default, new object
  types only allow edits via actions."* An action type is a schema-defined
  edit with **submission criteria** (validations that gate whether it can be
  submitted at all) and side effects (notifications, webhooks).⁶
- **The AI harness never hands the model the keys.** From the AIP Logic
  docs: *"LLMs do not have direct access to tools; LLMs can only ask to use
  tools, and these tool calls are then executed by AIP Logic within the
  invoking user's permissions."*⁷ Context is scoped per-tool ("an LLM only
  has access to what you specifically provide"), edits are staged and gated
  behind actions or human confirmation, and autonomy is a dial — agents are
  onboarded *"like a new team member that is gradually granted a wider
  purview."*⁸
- **The strategic claim.** Karp: value accrues to "chips and ontology";
  model intelligence is commoditizing. Shyam Sankar, Q1 2025 call: *"Our
  advantage comes down to Ontology... that has positioned AIP to be the
  platform that is able to capture the ever-expanding capability of the raw
  LLMs and turn that into business value."*⁹ And the most transferable
  framing, from Palantir's "Ontology-Oriented Software Development" post:
  the generated, scoped SDK means *"the programmer interacts with these
  business concepts... and writes code in the language of the business — not
  in terms of rows and columns, but in terms of Airplanes, Flight Schedules,
  and Airports."*¹⁰

Worth keeping the deflationary reading in view, because it's clarifying
rather than damning: critics point out that at the technical level this is
*"database modeling, with Object Type corresponding to a table, Property to
a column, Link to a foreign key, and Action to a stored procedure"*¹¹ — i.e.
the ontology is mostly ordinary schema plus governance plus narrative. That's
the right takeaway for us: **the power isn't exotic technology, it's the
discipline of making the schema, the verbs, and the permissions explicit and
machine-consumable in one place.** (Attribution hygiene: "commoditization of
cognition" is CRO Ryan Taylor's line, not Karp's; "context is the new code"
is Patrick Debois's phrase, not Palantir's.)

### 2.2 8090: the software factory as a typed document graph

8090's Software Factory (GA Feb 2026, $135M Series A led by Salesforce
Ventures, Chamath now CEO) is an SDLC control plane whose core is **a
knowledge graph of requirements → architecture → tasks that feeds structured
context to any coding agent** — theirs or yours, over MCP. Their own
published harness (github.com/8090-inc/software-factory-harness and
software-factory-plugin — the methodology docs are public, verbatim)¹² is
the most concrete artifact any of these players has shipped:

- **Two spec types, typed and linked.** *"Requirements capture the
  externally expected outcomes and constraints through structured user
  stories and acceptance criteria; Blueprints are the technical
  specifications that define how the software system operates to satisfy
  those requirements."* Requirements get stable machine-addressable IDs
  (`REQ-AUTH-PR-001`, `AC-…`). Blueprints are *"written diagrams: structured
  blocks define nodes, and prose relationship paragraphs define edges. They
  should trace up to Requirements and down to code symbols."* Blueprint
  principle #1 is **code-grounded**: components map to runtime components,
  elements to concrete schemas and contracts.
- **A three-type mention syntax** — `#Component` (things that do work),
  `` `Element` `` (things that describe shape), `@SystemEntity` (platform
  documents) — i.e. a tiny hyperlink ontology over markdown.
- **Context is delivered, not discovered.** Work orders are *"packed into a
  context-rich prompt"*; the guide explicitly says *"link the correct
  requirements and blueprints so the implementer can read the source records
  directly. Do not restate details that already live in connected
  Requirements or Blueprints."* The agent's first mandated phase is reading
  linked context, not exploring the repo.
- **Verification is a separate agent role with named dimensions** —
  requirements alignment, blueprint alignment, user-facing behavior — with
  append-only review logs, per-phase certification lines, and escalation to
  a human *"instead of endless retry loops."*
- **Drift is a first-class managed quantity, not prevented by
  regeneration.** *"Proactive Drift Detection automatically compares code
  against Blueprints on every push."* Background agents *"constantly observe
  any changes, minimize drift those changes may cause"* (Chamath).¹³
  Notably, there is **no** regenerate-code-from-spec doctrine: the model is
  bidirectional sync, and drift is either fixed or *explicitly accepted and
  documented*. Completion gates include "Architecture is aligned with linked
  blueprints, **or documented drift is accepted**."
- **Determinism at the output level.** Their flagship legacy story compiles
  18M lines of COBOL into ~300k plain-English business rules used as a
  deterministic pre-filter (self-reported). Regenerated pricers are
  expressed in Gherkin — executable acceptance specs.

Caveat: nearly all impact claims (80x delivery with EY, etc.) come from
8090 or its partners; independent practitioner discussion is close to
zero.¹⁴ The methodology documents are real and specific, though, and they're
what matters here.

### 2.3 The convergence

Strip the branding and both systems make the same six moves:

1. **A typed graph, not prose.** Objects/links/actions; requirements/
   blueprints/work-orders with stable IDs. Not a 3,000-line CLAUDE.md.
2. **Context assembled and delivered per task**, scoped to what the task
   touches — never "here's everything, good luck."
3. **Writes flow through governed verbs** with validations, permissions,
   and audit — not raw table edits, not unreviewed file mutations.
4. **Verification is a separate role** with named dimensions and an escape
   hatch to humans.
5. **Drift is detected and managed**, never assumed away. Accepted drift is
   documented drift.
6. **The harness is model-agnostic.** Both explicitly treat the model as a
   commodity input (8090 ships its harness for Claude Code, Cursor, Gemini,
   and Codex; Palantir's entire thesis is model-interchangeability).

That's the whole ontology idea at the altitude that matters to us. Note
also what it is *not*: it is not "more documentation." Every artifact in
both systems has a **guaranteed consumer** (a tool that assembles it into
prompts, a checker that compares it to code) and a **drift story**. That's
the difference between an ontology and a wiki.

---

## 3. Why the known failure modes all point the same direction

The prior-art sweep turns up a consistent graveyard, worth designing
against explicitly:

- **Monolithic context files get ignored.** Practitioner consensus and
  measurement both say a bloated CLAUDE.md fails — *"if your CLAUDE.md is
  too long, Claude ignores half of it because important rules get lost in
  the noise"*; models reliably follow on the order of 150–200 distinct
  instructions per window, and "high priority everywhere equals priority
  nowhere."¹⁵ Anthropic's own context-engineering guidance: context is a
  finite attention budget; prefer just-in-time retrieval over pre-stuffing.¹⁶
- **Artifacts without consumers stall.** llms.txt is the cautionary tale:
  grassroots adoption, but *"no evidence shows that any LLM uses it"* and no
  major provider committed to reading it.¹⁷ A context artifact only matters
  if a consuming tool is guaranteed to load it.
- **Spec-driven development fails as waterfall-in-markdown.** Teams report
  generating *"1,300 lines of Markdown just to display a date"* and specs
  consuming ~50% of project time; and *"in spec-driven development, specs
  drift because everyone can update them, but nobody takes responsibility
  for reconciling concurrent changes."*¹⁸ The survivable version is
  OpenSpec's **delta specs** — describe what's *changing* (ADDED/MODIFIED/
  REMOVED), never re-author the whole world — plus 8090's drift-detection
  model where reconciliation is a system responsibility, not a social one.
- **Enforcement beats prose, everywhere.** The parts of any ecosystem that
  stay coherent are the ones where the "spec" is machine-checked (boundary's
  compile-time checks, Ecto validations, ExUnit) or machine-applied
  (Igniter's AST patches). Rules that live only in markdown decay.

Design principle that falls out: **every artifact in the layer must be
either derived (regenerated from code/runtime, so it cannot drift) or
authored-but-checked (small, typed, with a CI gate that notices when code
moves out from under it). Anything else is future lies.**

---

## 4. Why Elixir/Phoenix is unusually well-positioned

Here's the part that makes this more than stack-flavored imitation: **in
Elixir, most of Palantir's ontology is already lying around in the
codebase, derivable rather than authored.** The mapping is almost
embarrassingly direct:

| Palantir Ontology | Plain Phoenix equivalent | Already machine-readable? |
|---|---|---|
| Object type (typed properties, primary key, backing datasource) | Ecto schema | Yes — `__schema__/1` reflection at runtime |
| Link type | Ecto association (`has_many`, `belongs_to`, join schemas) | Yes — `__schema__(:associations)` |
| Action type (schema-defined edit, gated by submission criteria) | Context function wrapping a changeset | Mostly — changeset **validations are literally submission criteria**; the function signature is the action schema |
| "Edits only via actions" | "The web layer only calls context functions, never Repo/schemas directly" | Enforceable — the `boundary` compiler makes it a compile error¹⁹ |
| Functions (typed logic) | Pure context/domain functions, specs, dialyzer | Partially |
| Dynamic security | Policy modules / plugs / LiveView `on_mount` hooks | Convention-dependent |
| Interfaces / polymorphism | Behaviours, protocols | Yes |
| OSDK ("APIs for your business, in the language of your business") | The context modules *are* this — Phoenix's whole contexts pitch | Yes |
| Kinetic side effects (webhooks, notifications) | Oban jobs, PubSub broadcasts | Yes — introspectable |

And the ecosystem has independently converged on the runtime half of the
thesis, harder than any other ecosystem:

- **Tidewave (Dashbit/Valim) bet on "runtime intelligence"**: an MCP server
  *inside the running app* — `project_eval` (evaluate code in the app
  itself), `execute_sql_query`, `get_logs`, `get_docs` for exact dep
  versions, `get_ecto_schemas`, `get_ash_resources`.²⁰ The running BEAM is
  the source of truth, not the file tree. This is Palantir's "tethered to
  objects in the real world" — except the objects are live processes and
  the tether is a REPL.
- **Valim's four-pillar argument for Elixir-as-best-AI-language**²¹ —
  immutability means local reasoning ("anything a function needs must be
  given as input, anything it changes must be given as output"), first-class
  docs with doctests, decade-stable APIs so model knowledge doesn't rot, and
  fast compile/warn loops — is really an argument that *the language itself
  reduces the context an agent needs*. Tencent's AutoCodeBench found Elixir
  had the highest agent completion rate of 20 languages.
- **usage_rules (Zach Daniel)** solved context distribution: packages ship
  terse `usage-rules.md`, `mix usage_rules.sync` composes them into
  AGENTS.md with managed markers so stale sections auto-remove.²² This is
  8090's context-delivery move, community-edition, wired into mix.
- **Phoenix 1.8 ships AGENTS.md from `phx.new`**, deliberately scoped by
  Chris McCord as *"gap-filling for SOTA LLMs... only"*²³ — not an
  architecture doc. Correct instinct: the generated file covers the stack
  layer; the project layer is the gap this concept fills.
- **Ash is the existence proof** that a full declarative ontology works in
  this ecosystem: resources/actions/policies as introspectable data, with
  ash_ai deriving LLM tools directly from them — *"because the tools are
  backed by Ash actions and subject to existing policies and validations,
  the LLM can never bypass your business logic."*²⁴ That is Palantir's
  kinetic layer, verbatim, in a hex package.

So the Elixir version of the ontology is **not a parallel document store to
author and maintain**. It's mostly a *derivation* — from the compiler, the
schemas, the router, the supervision tree, the running app — plus a thin
authored layer for the one thing that genuinely cannot be derived: **intent**.

---

## 5. Concept: the Phoenix coherence harness

Working shape — six pieces, deliberately mapped to the six convergent moves
from §2.3. Names are placeholders.

```
                    ┌────────────────────────────────────────┐
                    │  INTENT (authored, small, typed, gated) │
                    │  per-context intent cards + delta specs │
                    └──────────────┬─────────────────────────┘
                                   │ checked against
┌──────────────────┐   ┌───────────▼──────────────┐   ┌──────────────────────┐
│ RUNTIME           │  │  MAP (derived, never     │   │  DRIFT SENTINEL      │
│ Tidewave MCP in   ├─▶│  hand-edited)            │◀──┤  CI: derived map vs  │
│ the live BEAM     │  │  contexts, schemas, links,│   │  intent cards; fix or│
└──────────────────┘   │  routes, jobs, boundaries │   │  explicitly accept   │
                       └───────────┬──────────────┘   └──────────────────────┘
                                   │ sliced per task
                       ┌───────────▼──────────────┐
                       │  ASSEMBLY (work packets)  │──▶ agent implements via
                       │  map slice + intent cards │    governed verbs
                       │  + usage-rules + skills   │    (contexts/changesets,
                       └───────────┬──────────────┘    boundary-enforced)
                                   │
                       ┌───────────▼──────────────┐
                       │  VERIFY (separate role)   │
                       │  intent / boundary /      │
                       │  runtime-behavior dims    │
                       └──────────────────────────┘
```

### 5.1 The Map — semantic layer, 100% derived

A mix task (`mix hive.map` or similar) that regenerates a compact,
git-tracked description of the system's actual shape:

- contexts and their public functions (the "action surface"),
- Ecto schemas, fields, associations (objects and links),
- routes → LiveViews/controllers → contexts (the call topology),
- Oban workers, PubSub topics, supervision tree,
- boundary declarations and any violations.

Sources: compiler tracers, `__schema__` reflection, `Phoenix.Router`
introspection, Sourceror where AST is needed — and optionally the live app
via Tidewave for what static analysis can't see. Prior art to steal from:
Aider's repo map (tree-sitter graph + personalized PageRank under a token
budget)²⁵ and Meta's Glean (typed facts, queryable — the right long-term
shape if the map outgrows markdown)²⁶.

**Rule: never hand-edited, regenerated in CI, therefore it cannot lie.**
This is the artifact that fixes "session N knows things session N+1
rediscovers expensively" without trusting anyone to maintain docs.

### 5.2 Intent cards — the thin authored layer

One small file per context (`intents/accounts.md`), typed sections, stable
IDs, usage-rules ethos (only what cannot be derived):

- **Purpose** — one paragraph of why this context exists.
- **Invariants** — the things that must stay true ("a User always has ≥1
  Org membership"; "money amounts are integers, cents, never floats").
- **Decisions** — ADR-style, dated, with the rejected alternative
  (`DEC-ACC-003: soft-delete, not hard-delete, because …`).
- **Non-goals / do-not** — the anti-patterns specific to this context.
- **Open questions.**

Changes to intent ride with the PR that motivates them, delta-spec style —
you never re-author a card, you amend it. Target size: a card the model can
swallow whole, ~1–2KB. This is the blueprint layer, but scoped to what 8090
calls "Foundations" plus per-component intent — we skip their full
Requirements/FRD apparatus, which is where the waterfall-in-markdown failure
lives (docs/specs/ already covers feature-level design when a feature
warrants it).

### 5.3 Governed verbs — the kinetic layer

Mostly a discipline we already believe in, made mechanical:

- All writes through context functions; web layer never touches `Repo` or
  schema modules directly. **Enforced by `boundary`**, so violations are
  compile errors an agent sees immediately — the Phoenix equivalent of
  "new object types only allow edits via actions."
- Changesets carry the submission criteria; context function docs state
  side effects (jobs enqueued, broadcasts).
- For agent tooling: in dev, the agent gets Tidewave (`project_eval`,
  `execute_sql_query`) — meaning it can *exercise the real verbs and verify
  results in the real runtime* instead of reasoning about them. Where a
  project uses Ash, ash_ai's derived tools are the fully governed version.

### 5.4 Assembly — context delivered, not discovered

A work-packet builder (a skill/command, and eventually `hive dispatch`
input): given a task, assemble (a) the map slice reachable from the modules
it touches, (b) the intent cards for affected contexts, (c) usage-rules for
affected deps, (d) pointers to the relevant `elixir:*` stack skills. The
8090 rule applies verbatim: *link, don't restate* — the packet points at
source records; it doesn't paraphrase them into a second truth.

### 5.5 Verify — separate role, named dimensions

A review pass (separate agent or fresh-context run) with exactly three
dimensions, in the 8090 style, logged append-only:

1. **Intent alignment** — invariants and decisions in the touched contexts'
   cards still hold; any violated decision is either a bug or a proposed
   supersession, surfaced explicitly.
2. **Boundary alignment** — compiles clean under `boundary`; new public
   surface on a context is flagged (that's an ontology change, not a detail).
3. **Runtime behavior** — not just tests: exercise it in the running app
   via Tidewave / LiveView tests / a browser pass for user-facing changes.
   The BEAM makes "did it actually work" cheap; use it.

Unresolvable findings escalate to a human rather than looping.

### 5.6 Drift sentinel — the piece almost nobody builds

CI job on every push: regenerate the map, diff the action surface and
schema/link shape against the intent cards' claims. Three outcomes:
no-drift; **drift-fixed** (the PR updates the card); **drift-accepted** (a
dated `accepted-drift` annotation — 8090's "documented drift is accepted"
gate, verbatim). Nightly, HIVE's existing pipeline is the natural home:
Pass A already reads sessions and git; a drift report per project slots
into the condition report, and accepted-drift entries become candidates for
the knowledge verifier. **This is the mechanism that keeps the authored
layer honest, and it's what separates this concept from "we added more
markdown."**

---

## 6. How this composes with what HIVE already has

Nothing in §5 replaces existing HIVE machinery; it fills the one layer HIVE
deliberately doesn't cover. Current stack, bottom to top:

1. **Stack knowledge** — `~/.hive/stacks/elixir` skills (how to write
   Ecto/LiveView/OTP well). Generic across projects. ✅ exists.
2. **Project memory** — knowledge.md via candidates → nightly Opus verifier
   → canon, with decay and BM25. Facts, conventions, decisions *as
   observed*. ✅ exists. (Structurally, HIVE's provenance-checked verifier
   is the same move as 8090's review gates and Palantir's action gating —
   we already believe writes to canon need a governed verb.)
3. **Codebase ontology** — the map + intent cards + drift sentinel,
   *in-repo, per-project*. ❌ this is the gap. Project memory knows what we
   learned; nothing currently knows what the code *is* and what it's *for*
   in a machine-deliverable form.
4. **Execution** — dispatch/Ralph loops consume work packets (§5.4) instead
   of raw PRDs; the ralph-loop doc's "write a good PRD" step gets its
   context section generated instead of hand-written.

The memory pipeline and the drift sentinel also mirror each other
pleasingly: one governs what enters *belief*, the other governs what enters
*intent*. Both are "no un-verified writes to canon."

---

## 7. Is it generalizable past Elixir?

The **architecture** is stack-agnostic — map/intent/verbs/assembly/verify/
drift is exactly the 8090/Palantir convergence and would structure a
TypeScript or Python project fine. What's stack-specific is the
**derivability ratio**: how much of the map you can generate versus author.
Elixir is an outlier — declarative-ish schemas, runtime reflection, an
introspectable live runtime (Tidewave), compile-time boundary enforcement,
stable APIs, doc culture. A Next.js codebase would need tree-sitter
scraping and a lot more authored intent to reach the same fidelity; Ash
projects sit at the far other end where the map is nearly total. So: design
the harness generically, build the first deriver for Elixir, and treat
"percent of ontology derived vs authored" as the honest metric of how well
a stack supports the pattern. This also suggests the contrarian pitch
lurking in Valim's and Daniel's posts: *Elixir isn't just tolerable for AI
agents — it's the stack where the coherence layer is cheapest to build.*

## 8. What I'd deliberately not build

- **8090's full module suite** (Refinery/Foundry/Planner/Assembler/
  Validator). Four modules is a lot of adoption even for their customers;
  we need the map, the cards, and the sentinel — not a control plane.
- **A requirements-management layer** (PRDs/FRDs/acceptance-criteria IDs).
  For a small team this is where spec-time eats 50% of the project.
  docs/specs/ design docs on demand, as today.
- **Regeneration-from-spec doctrine.** Even 8090 doesn't do it. Code stays
  primary; specs trace and check.
- **A graph database.** Markdown + generated markdown, git-tracked, same as
  the memory-architecture decision. Glean-style typed facts only if a map
  ever outgrows what BM25 over markdown can serve.

## 9. Suggested incremental path (when/if we build)

1. **`mix hive.map` prototype** against one real Phoenix project; judge the
   derived map's usefulness by hand before anything else exists. (Days.)
2. **Intent cards for 2–3 contexts** of that project + a work-packet skill
   that assembles map-slice + cards + usage-rules. Use in real sessions;
   see if sessions stop rediscovering. (Days.)
3. **Drift sentinel v0**: map regen + surface-diff in CI, warn-only.
4. **Verify skill** with the three dimensions; wire Tidewave into dev.
5. **HIVE integration**: drift report into Pass A; packets into dispatch;
   `hive project bootstrap --infer` learns to seed intent cards.

Each step is independently useful and cheap to abandon — the opposite of
buying the factory.

---

## Sources

1. Chroma, "Context Rot" — research.trychroma.com/context-rot
2. 8090 Series A PR — businesswire.com/news/home/20260626795833/en/
3. Palantir Q4 2025 annual letter — palantir.com/q4-2025-letter/en/
4. Palantir docs, Ontology overview — palantir.com/docs/foundry/ontology/overview
5. Palantir docs, core-concepts; object-types-overview; interfaces
6. Palantir docs, action-types/overview; object-edits/permission-checks
7. Palantir docs, AIP Logic blocks — palantir.com/docs/foundry/logic/blocks
8. Palantir docs, why-ontology — palantir.com/docs/foundry/ontology/why-ontology
9. Q1 2025 earnings call — investing.com/news/transcripts/…-4023247; sherwood.news/markets/what-the-heck-is-palantirs-ontology/
10. Wilczynski, "Ontology-Oriented Software Development" — blog.palantir.com/ontology-oriented-software-development-68d7353fdb12
11. Vonng, "Palantir's Ontology Narrative" — vonng.com/en/db/ontology-bullshit/
12. github.com/8090-inc/software-factory-harness (sofa-rws.md, sofa-bws.md, work-order/blueprint/requirements writing guides, review-phase.md); github.com/8090-inc/software-factory-plugin; docs mirrored from 8090.ai/docs/opinions/*
13. x.com/chamath/status/1951550306317185170; 8090.ai/docs/resources/changelog
14. rywalker.com/research/8090-software-factory
15. rahuulmiishra.medium.com/your-claude-md-is-doing-too-much…; claudefa.st/blog/guide/mechanics/rules-directory; humanlayer.dev/blog/writing-a-good-claude-md
16. Anthropic, "Effective context engineering for AI agents" — anthropic.com/engineering/effective-context-engineering-for-ai-agents
17. llms-txt.io/blog/is-llms-txt-dead; searchengineland.com/llms-txt-proposed-standard-453676
18. sudoish.com/spec-driven-development-waterfall-trap/; rogerwong.me/2026/03/spec-driven-development; augmentcode.com/guides/spec-driven-development-vs-waterfall
19. github.com/sasa1977/boundary; Jurić, "Towards Maintainable Elixir: Boundaries"
20. github.com/tidewave-ai/tidewave_phoenix; dashbit.co/blog/the-path-to-tidewave; tidewave.ai/blog/tidewave-web-phoenix-rails
21. Valim, "Why Elixir is the best language for AI" — dashbit.co/blog/why-elixir-best-language-for-ai
22. github.com/ash-project/usage_rules; zachdaniel.dev/p/usage-rules-leveling-the-playing
23. phoenixframework.org/blog/phoenix-1-8-released; elixirforum.com/t/phoenix-phx-new-generator-and-agents-md/71850
24. github.com/ash-project/ash_ai; alembic.com.au/blog/ash-ai-comprehensive-llm-toolbox-for-ash-framework
25. aider.chat/2023/10/22/repomap.html
26. engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/

**Attribution notes preserved from research:** "commoditization of
cognition" = Ryan Taylor (Palantir CRO), Q3 2024 call, not Karp. "Context
is the new code" = Patrick Debois (Tessl), not Palantir. 8090 impact
numbers (80x, $20M saved) are company/partner-reported, not independently
verified. Palantir quotes were verified against a docs mirror or multiple
independent search extracts; direct fetches of palantir.com were blocked in
the research environment.
