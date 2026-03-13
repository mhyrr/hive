# HIVE Persona Theory: Cognitive Lenses, Not Job Titles

A design document. March 2026.

---

## The Mistake Everyone Makes

Open any multi-agent framework and look at how they set up teams. CrewAI
will give you a "Product Manager," a "Designer," a "Frontend Engineer,"
and a "Backend Engineer." MetaGPT literally simulates a software company
with a CEO, CPO, Architect, Engineer, and QA. AutoGen gives you
"AssistantAgent" and "UserProxyAgent" — the assistant and the boss.

They're copying the org chart. And it's wrong. Not a little wrong —
*structurally* wrong, in a way that limits what multi-agent systems can
actually do.

### Why Org-Chart Personas Fail

**Human org charts exist to manage human problems.** The reason companies
have PMs and designers and frontend engineers and backend engineers is
because those are specialization boundaries that help humans manage
cognitive load, career growth, communication overhead, and accountability.
A PM exists because *someone* needs to talk to customers and translate
business needs into technical requirements, and most engineers don't want
to do that. A designer exists because visual/spatial/aesthetic thinking
is a genuine specialization that takes years to develop in a human brain.
A "frontend engineer" exists because the JavaScript ecosystem is large
enough that knowing it deeply *and* knowing distributed systems deeply
is rare in one person.

None of these constraints apply to AI agents.

An LLM doesn't have career goals. It doesn't burn out from context
switching. It doesn't need years to develop visual intuition — it either
has it from training or it doesn't. It doesn't resent being moved from
frontend to backend. It doesn't build relationship capital with
stakeholders over months of 1:1s. It doesn't have a personality conflict
with the designer.

The things that make human orgs *need* distinct roles — ego management,
cognitive fatigue, institutional knowledge siloed in individual brains,
political navigation, the physical impossibility of one person knowing
everything — are precisely the things agents don't have.

**The skill-equivalence problem.** Every frontier model can write both
frontend and backend code. Telling one Claude "you're the frontend
engineer" and another "you're the backend engineer" doesn't give you
specialization — it gives you *two generalists with artificial blinders*.
Both have the same training data. Both know the same patterns. The "split"
adds handoff overhead without adding cognitive diversity. You get the org
chart's costs (coordination, context loss at boundaries) with none of its
benefits (genuine deep specialization, institutional relationships).

**The handoff tax.** Every role boundary creates a communication surface.
In human orgs, this is necessary overhead — the PM has to tell the
engineer what to build because the PM talked to the customer and the
engineer didn't. But when both agents have access to the same files, the
same plan, the same context — the handoff is pure waste. You're
manufacturing communication overhead to satisfy a metaphor borrowed from
a different species' organizational constraints.

**The sycophancy trap.** When you tell an agent "you're the PM," it
doesn't suddenly gain product intuition. It gains a *role to perform*.
It will generate PM-shaped output: user stories, acceptance criteria,
roadmap documents. It'll sound like a PM. It won't *think* like a PM,
because thinking like a PM requires the thousands of customer
conversations, the market intuition, the stakeholder relationships that
the role actually draws on. You get the format without the substance.
The agent is playing a character, not exercising a skill.

---

## What Actually Produces Different Outputs

If org-chart roles don't work, what does? What actually causes two
agents looking at the same codebase to produce *genuinely different*
analysis?

Two things: **cognitive lens** and **model substrate**.

### Cognitive Lenses

A cognitive lens is not a job. It's a way of seeing. It determines what
you notice first, what you consider important, and what you're blind to.
Every human engineer has a default lens — the one they revert to under
pressure. The security-minded engineer sees attack surfaces before they
see features. The systems thinker sees data flows before they see UI.
The pragmatist sees shipping deadlines before they see technical debt.

These lenses are real. They produce genuinely different outputs from
the same input. And crucially, they work on LLMs. When you tell a model
"look at this code and think about where it breaks at the edges," you
get *different tokens* than when you tell it "look at this code and
think about how the data flows through the system." Not superficially
different — substantively different. Different concerns raised. Different
risks identified. Different solutions proposed.

The five personas we've built are cognitive lenses:

| Persona | Lens | What It Sees First |
|---------|------|-------------------|
| Steward | Coordination | Dependencies, sequencing, communication gaps |
| Architect | Structure | Boundaries, contracts, data flows, coupling |
| Craftsman | Material | Code quality, grain, fit, naming, testing |
| Critic | Failure | Edge cases, attack surfaces, race conditions |
| Scout | Terrain | Options, precedent, traps, context |

These aren't jobs. An architect persona doesn't "design systems" the way
a human architect does (by drawing on years of experience with specific
technologies and organizational constraints). It *thinks structurally*
— it notices boundaries and flows the way the craftsman notices code
quality and the critic notices failure modes. The prompt shapes what the
model attends to, and different attention produces different insight.

### Why Lenses Produce Better Outcomes Than Roles

A "PM agent" and a "backend engineer agent" will mostly agree. They're
the same model with different costumes. Their outputs converge because
their cognitive approach is identical — they're both trying to "do a
good job" from the same training distribution.

An architect and a critic will **disagree**. The architect says "clean
separation, two modules, one contract." The critic says "that contract
doesn't handle the case where the upstream service returns a 200 with an
empty body — which it does, I checked." That disagreement is where the
value lives.

This is epistemic diversity applied to software. The insight from
cognitive science research (and from how the best human teams work) is
that **groups with diverse cognitive styles outperform groups with
uniform expertise, even when the uniform group is individually more
skilled.** Three mediocre perspectives that see different things beat
one excellent perspective that has blind spots.

The architect misses implementation details. The craftsman misses
system-level coupling. The critic misses the creative solution hiding
behind the risk. The scout misses the 80/20 call to stop researching.
The steward misses the technical nuance that makes a plan infeasible.
Alone, each is incomplete. Together, they cover the problem space.

---

## Model Substrate: The Second Axis

Here's where it gets interesting. The personas above work with any
model — the cognitive lens is in the prompt. But different models are
genuinely, measurably different in ways that make certain models
*better substrates* for certain lenses.

This isn't marketing copy. This is empirical observation that any
engineer working with multiple models has noticed:

### How Models Actually Differ

**Reasoning depth vs speed.** Claude Opus thinks longer and finds
subtle issues that faster models miss. Sonnet produces good code
quickly. Haiku is fast enough for coordination but shallow on complex
reasoning. These aren't quality tiers — they're different cognitive
profiles. A steward doesn't need deep reasoning about code structure.
An architect does. A craftsman needs speed more than depth on
straightforward implementation.

**Training data distribution.** Claude, GPT, Gemini, and open models
were trained on overlapping but different data. They've internalized
different code patterns, different naming conventions, different
architectural preferences. When two models produce different solutions
to the same problem, that difference is signal, not noise. It's the
model equivalent of two engineers with different professional
backgrounds.

**Context handling.** Gemini can hold 1M+ tokens. Claude handles 200K
well. Smaller models fall off at 32K. A scout reading through
documentation, issue trackers, and prior art benefits from massive
context. A craftsman writing a single function doesn't need it — and
paying for it is waste.

**Code fluency.** Some models produce genuinely cleaner code in certain
languages and frameworks. This varies by model and changes with each
release. But at any given moment, there's a real answer to "which model
writes the best Elixir?" and it's not always the most expensive one.

**Risk profile.** Some models are conservative — they'll warn about edge
cases and add defensive code. Others are creative — they'll propose
unconventional solutions that work beautifully or fail spectacularly.
Conservative maps well to the critic lens. Creative maps well to the
architect and scout lenses.

### Model-Lens Affinity

The insight: **a persona is not just a prompt. It's a prompt + model
pairing where the model's genuine strengths align with the cognitive
mode.**

| Lens | Cognitive Need | Model Affinity |
|------|---------------|----------------|
| Steward | Fast assessment, coordination, low cost | Small/local model (8B-class), or Sonnet/Haiku for judgment calls |
| Architect | Deep structural reasoning, trade-off analysis | Opus-class. The cost is worth it for decisions that shape everything downstream. |
| Craftsman | Fast, practical, high code quality | Sonnet-class. Speed matters for implementation velocity. Best model for the target language/framework. |
| Critic | Thorough, adversarial, finds edge cases | Opus-class for security/correctness. Different *model* from the one that wrote the code — training distribution diversity catches what same-model review misses. |
| Scout | Breadth, research, large-context synthesis | Large-context model (Gemini for 1M+ context), or web-enabled model for research tasks. |

The last row is revealing. A scout researching library options benefits
from a model that can ingest entire documentation sites. A critic
reviewing code benefits from a model with deep reasoning. A craftsman
implementing a feature benefits from a model that writes clean code
fast. These aren't preferences — they're functional requirements that
different models serve differently.

**The cross-model critic is the strongest example.** When Claude writes
code and Claude reviews it, there's a systematic blind spot — the same
training biases that led to the implementation also lead to approving
it. When a *different* model reviews the same code, it applies a
genuinely different evaluation function. Bugs that Claude finds
"obviously fine" might trigger GPT's pattern-matching on a known
anti-pattern from its different training corpus. This is real. Anyone
who's had two different models review the same PR has seen it.

---

## Beyond the Base Five: Extending the Lens System

The five base personas cover the core cognitive territory for general
software engineering. But the system should support extension in two
directions: **deeper specialization** of existing lenses, and **novel
lenses** for specific problem domains.

### Lens Specialization (Depth)

A lens can be narrowed to a domain without changing its cognitive
character. The critic lens — adversarial, edge-case-hunting, failure-mode
thinking — is the same whether applied to:

- **Security review:** the critic is specifically hunting for injection,
  auth bypass, data exposure, cryptographic weakness.
- **Performance review:** the critic is hunting for N+1 queries, memory
  leaks, unnecessary allocations, hot paths.
- **API design review:** the critic is hunting for inconsistency,
  missing error cases, versioning problems, breaking changes.

These aren't different personas. They're the **same cognitive lens** with
**different domain context injected**. The prompt structure is:

```
[base lens: how to think] + [domain context: what to think about]
```

This matters because domain-specialized critics don't need entirely new
persona files. They need the critic's adversarial cognitive pattern plus
domain-specific knowledge. The persona system should support this
composition:

```markdown
# Agent: gamma
persona: critic
domain: security
model: claude-opus-4
scope: src/api/**, src/auth/**
```

The domain context can come from:
- A domain knowledge file (`~/.hive/domains/security.md`)
- Project-specific rules (from project config.md)
- Accumulated persona memory (`memory/personas/critic-security.md`)

### Novel Lenses (Breadth)

Some problem domains benefit from cognitive modes that the base five
don't cover well. These are genuine extensions to the lens vocabulary,
not just domain specialization:

**The Reducer lens.** Sees what's unnecessary. While the craftsman sees
code quality (is this well-made?) and the architect sees structure (is
this well-organized?), the reducer sees *weight* — is this needed at
all? Dead code, unnecessary dependencies, over-abstracted layers,
features nobody uses, complexity that serves no constraint. The reducer's
question is always: "What happens if we delete this?" The cognitive
mode is subtractive rather than additive. This is valuable because
every other lens tends to *add* — the architect adds structure, the
craftsman adds quality, the critic adds checks. The reducer is the
counterweight.

**The Integrator lens.** Sees the seams between systems. When a project
touches multiple services, APIs, databases, or external dependencies,
the integrator's attention goes to the joins — where data transforms
across boundaries, where assumptions from system A meet reality in
system B, where the contract says one thing and the implementation does
another. Different from the architect (who designs boundaries) and
different from the critic (who tests them). The integrator *lives at*
the boundary and understands both sides.

**The Historian lens.** Sees the codebase through time. Why was this
decision made? What was tried before and abandoned? What patterns recur
across projects? The historian draws on the hive's accumulated memory —
journal entries, decision logs, project learnings — to provide temporal
context that other lenses miss. "We tried this approach in MyApp six
months ago and rolled it back because of X" is something only the
historian would surface, because only the historian is attending to
the past.

**The Emissary lens.** Sees through the human's eyes. Not in the
sycophantic sense of agreeing with everything — in the sense of
modeling what the human cares about, what they'll ask about, what
will make them nervous, what they'll want to celebrate. The emissary
is the persona that writes briefings, surfaces decisions for review,
and anticipates the leader's next question. This is the persona that
powers the leadership UI's anticipation engine. It's the chief of
staff cognitive mode — not doing the work, but understanding the
leader well enough to present the work effectively.

These novel lenses should be creatable on demand. The hive should
support:

```
hive chat "I need a persona that thinks about data migration risks"
```

And the hive mind creates a lens definition — not a job title, but a
cognitive pattern:

```markdown
# Persona: Migrator

You see data the way a river sees its banks — always in motion, always
shaped by what contains it. While others think about the code that
transforms data, you think about the data itself: where it lives, how
much there is, how long the move takes, what happens if the move fails
halfway, what happens when old and new coexist.

You know that most migration disasters aren't technical failures —
they're planning failures. Someone forgot the production table has
400M rows and the migration takes 6 hours. Someone forgot that the
old system is still writing during the cutover window. Someone forgot
that the rollback plan assumes you can reverse a destructive column
rename.

Your questions: How big? How long? What if it fails at step 3? What's
writing to the old system during the migration? Is the rollback plan
actually tested, or just documented?
```

Notice: this is a cognitive lens, not a job title. It doesn't say "you
are a database migration engineer." It says "here's how to think about
data in motion." Any model can adopt this lens. But a model that's
strong on database internals and has seen many migration failures in
its training data will exercise it better than one that hasn't.

---

## Team Composition as Cognitive Design

If personas are cognitive lenses and models are substrates, then team
composition is a **cognitive design problem**: given a task, what
combination of lenses and substrates will produce the best outcome?

### The Anti-Org-Chart Principle

Don't mirror how humans would staff this. Ask instead:

1. **What cognitive modes does this task need?** A greenfield feature
   needs architectural thinking, implementation, and review. A bug fix
   needs adversarial thinking and careful implementation. A research
   spike needs exploratory thinking. A refactor needs structural thinking
   and the subtractive instinct.

2. **Where will disagreement be valuable?** If two lenses are likely to
   agree on everything, you only need one. If they're likely to see
   different things, you want both. An architect and a craftsman will
   disagree productively on almost every non-trivial design. Two
   craftsmen will mostly agree (same lens, same outputs). But two
   craftsmen on *different models* will disagree in useful ways —
   different training data surfaces different patterns.

3. **What's the minimum team?** More agents means more coordination
   overhead and more token spend. A three-file bug fix needs one
   craftsman and maybe a quick critic pass. It does not need a five-
   agent team with an architect. The steward should right-size the team
   to the task. The answer is often two agents, not five.

### Composition Patterns

Some task shapes have natural team compositions:

**Greenfield feature:**
```
steward (coordination) + architect (structure) + 1-2 craftsmen (build)
+ critic (review)
```
The architect designs, craftsmen build in parallel with different scopes,
the critic reviews. This is the full ensemble and it's expensive. Use
it for work that justifies the cost.

**Bug fix:**
```
craftsman (fix) + critic (verify)
```
Two agents. The craftsman reads the code, understands the bug, writes
the fix and tests. The critic verifies the fix doesn't introduce new
issues. No architect needed — the structure already exists.

**Research spike:**
```
scout (explore) + architect (evaluate)
```
The scout researches options. The architect evaluates structural
implications. No craftsman needed — nobody's writing production code.

**Security audit:**
```
critic/security (primary) + critic/performance (secondary, different model)
```
Two critics with different domain specializations *and* different model
substrates. The cross-model review catches what single-model review
misses. No craftsman — this is analysis, not implementation.

**Refactor:**
```
architect (plan) + reducer (simplify) + craftsman (execute)
```
The architect identifies the target structure. The reducer identifies
what to eliminate. The craftsman does the mechanical work. The reducer
is essential here — without it, refactors tend to *add* complexity
(new abstractions) rather than remove it.

**Legacy migration:**
```
historian (context) + architect (plan) + migrator (risk) + craftsman (execute)
```
The historian pulls context on why the legacy system exists and what's
been tried before. The architect designs the target state. The migrator
thinks about the transition itself — the dangerous middle state. The
craftsman does the work.

### Dynamic Composition

The steward shouldn't just pick from a fixed menu. Given a task
description, the steward should reason about what cognitive modes are
needed:

```
Human: "Add rate limiting to the API"

Steward's reasoning:
- This is an additive feature on an existing system → needs structural
  thinking (where does rate limiting live?) and implementation
- Security implications → needs adversarial thinking
- Not a big enough task for a full team
- Team: architect (quick structural decision on middleware vs per-route),
  craftsman (implement), critic/security (review)
- Models: architect on Opus (structural judgment worth the cost),
  craftsman on Sonnet (fast implementation), critic on different-model
  (cross-model review value)
```

This is the steward exercising the coordination lens: reading the task,
identifying the cognitive needs, composing the team, matching models to
roles. It's what the leadership UI's informed commander experience
relies on — the leader says "add rate limiting" and the steward does the
organizational thinking.

---

## The Model Roster

The hive should maintain a model roster — an understanding of what models
are available, what they cost, and what they're good at. This isn't
static; it evolves as models improve and as the hive accumulates
experience with model-task pairings.

### Configuration

```markdown
# ~/.hive/config.md (model roster section)

## Models

### claude-opus-4
runtime: claude-code
cost-tier: high
strengths: deep reasoning, architectural thinking, nuanced judgment,
           complex code review, Elixir, system design
best-for: architect, critic (security/correctness), complex decisions
context: 200K tokens

### claude-sonnet-4
runtime: claude-code
cost-tier: medium
strengths: fast, practical, clean code generation, good test writing
best-for: craftsman, steward (when judgment quality matters)
context: 200K tokens

### gpt-4o
runtime: codex
cost-tier: medium
strengths: different training distribution (cross-review value),
           strong Python, good at data-heavy code
best-for: craftsman (Python projects), critic (cross-model review)
context: 128K tokens

### gemini-2.5-pro
runtime: gemini-cli
cost-tier: medium
strengths: massive context window, research synthesis, documentation
best-for: scout, historian (large context ingestion)
context: 1M+ tokens

### llama-3-8b
runtime: ollama
cost-tier: free (local)
strengths: fast, zero marginal cost, good enough for routing
best-for: steward (routine coordination), memory curation
context: 32K tokens
```

### Learned Affinity

Over time, the hive accumulates data on which model-persona pairings
produce the best outcomes. This goes into persona memory:

```markdown
# ~/.hive/memory/personas/critic.md

## Model Observations
- Claude Opus consistently catches subtle type-level bugs that Sonnet
  misses. Worth the cost for critic passes on core modules.
- Using a different model for critic than for craftsman catches ~30%
  more issues in practice. Cross-model review is real.
- GPT-4o as critic on Elixir code over-flags pattern matching as
  "possible nil" — Elixir's pattern matching makes these safe. Adjust
  domain context when using GPT-4o for Elixir review.
```

This is the institutional memory angle from the research doc, applied
to model selection. The hive gets better at staffing decisions over time
because it remembers what worked.

---

## The Disagreement Protocol

If cognitive diversity is the value, then **disagreement is the
product**. The system needs to handle it explicitly rather than
papering over it.

### Structured Disagreement

When two agents produce contradictory outputs (architect says "two
modules" and craftsman says "this is one module's worth of work"), the
steward shouldn't just pick a winner. It should:

1. **Surface the disagreement** — make both positions visible, with
   the reasoning behind each.
2. **Classify the disagreement** — is this a factual dispute (one of
   them is wrong), a judgment call (both are defensible, someone needs
   to choose), or a values tension (speed vs quality, simplicity vs
   flexibility)?
3. **Route appropriately** — factual disputes get resolved by checking
   (scout, or just reading the code). Judgment calls go to the leader
   if they're significant, or the steward decides if they're minor.
   Values tensions get escalated — they're the kind of decision the
   human should make because they reflect priorities, not analysis.

### The Synthesis Pass

For complex disagreements, the steward can request a **synthesis pass**:
one agent reads the outputs of two others and finds the answer that
captures what's right about both. This is different from compromise
(splitting the difference) — it's integration (finding the higher-order
solution that resolves the tension).

The emissary lens is good for this. It models the human's priorities
and applies them to the technical dispute. "The architect wants clean
separation and the craftsman wants to ship fast. Given that we're two
days from demo and this isn't a long-lived module, the craftsman's
approach is right *this time*. But the architect should file the
structural concern for post-demo cleanup."

### Confidence Signaling

Agents should signal confidence so the steward can weight disagreements:

- **High confidence, specific claim:** "This will cause a race condition
  under concurrent requests. I can show you the sequence." → Treat as
  near-certain. Verify.
- **Medium confidence, judgment call:** "I think two modules is cleaner,
  but one module works if we want to move faster." → Legitimate
  trade-off. Route to decision-maker.
- **Low confidence, pattern match:** "This reminds me of a pattern
  that's sometimes problematic, but I'm not sure it applies here." →
  Worth noting, not worth blocking on.

The steward uses confidence levels to decide what needs escalation vs
what can be resolved autonomously. High-confidence blockers always
surface. Low-confidence suggestions get noted and batched.

---

## Persona Creation Principles

When creating new personas — whether as base templates or on-demand for
specific tasks — follow these principles:

### 1. Describe Cognition, Not Role

Wrong: "You are a database administrator."
Right: "You see data at rest and data in motion. You notice when a
schema can't efficiently serve the queries it'll face, when an index
is missing, when a migration will lock a table for longer than the
application can tolerate."

The role description tells the model to *perform* a job. The cognition
description tells the model *how to see*. The difference in output is
substantial.

### 2. Include the Weakness

Every persona should name its blind spot. The architect over-designs.
The craftsman gold-plates. The critic bottlenecks. The scout
over-researches. The steward micromanages.

This isn't character flavor. It's a **self-correction mechanism**. When
the prompt says "your weakness is over-designing — if you can't explain
it in two minutes, simplify," the model actually produces simpler
designs. The named weakness creates a check that the model applies to
its own output. Without it, the model will indulge the lens's natural
excess.

### 3. Define the Handoff

Every persona should know what it delivers and to whom. The architect
delivers structure to the craftsman. The scout delivers options to the
architect. The critic delivers findings to the steward. Clear handoffs
prevent the "agent produces a beautiful artifact that nobody asked for
and nobody can use" failure mode.

### 4. Voice Matters More Than You Think

The voice examples in persona files aren't cosmetic. They're **output
calibration**. When the critic's example says "Blocker: This endpoint
has no auth check," it's teaching the model the format, the severity
language, and the specificity level. When the craftsman's example says
"Done. Tests pass. One trade-off I made: [specifics]," it's teaching
completion criteria and communication patterns.

Different voices produce different behaviors. A terse voice produces
focused outputs. A narrative voice produces contextual outputs. Match
the voice to the lens's function.

### 5. Composability Over Completeness

A persona doesn't need to cover every situation. It needs to define
a cognitive mode clearly enough that any model can adopt it. Domain
knowledge, project context, and specific instructions get layered on
top. The persona is the foundation — how to think. Everything else is
what to think about.

---

## The Full Stack: How It All Fits Together

```
Task arrives from human
        │
        ▼
    ┌──────────┐
    │ Steward  │  Cognitive design: what lenses does this task need?
    │  (lens)  │  Model selection: which models serve those lenses best?
    └────┬─────┘  Team sizing: minimum viable cognitive diversity
         │
         ▼
    ┌──────────────────────────────┐
    │  Team Composition            │
    │                              │
    │  architect (Opus) ──────┐    │
    │  craftsman (Sonnet) ────┤    │  Each agent = lens + model + scope
    │  critic (GPT-4o) ──────┘    │
    └──────────────────────────────┘
         │
         ▼
    ┌──────────┐
    │ Execution │  Agents work. Disagreements surface.
    │           │  Steward coordinates, resolves, escalates.
    └────┬─────┘
         │
         ▼
    ┌──────────┐
    │ Learning │  Model-persona affinity data accumulates.
    │          │  The hive gets better at team composition.
    └──────────┘
```

The human says "build auth." The steward thinks: this needs structural
design (architect), implementation (craftsman), and security review
(critic with security domain specialization). The architect should be
Opus because the structural decisions shape everything downstream. The
craftsman should be Sonnet because fast, clean implementation matters
more than deep reasoning here. The critic should be a *different model*
because cross-model security review catches training-data blind spots.

Three agents. Three lenses. Three models. Not because three is a magic
number — because the task needs structural, material, and adversarial
thinking, and each benefits from a different model substrate.

That's what multi-agent orchestration should actually be.

---

## What This Means for HIVE's Design

### Persona Files Stay Simple

The current persona format is right. Cognitive description, weakness,
team interaction, voice examples. Don't add complexity. A persona file
should be something a human can read in two minutes and understand
completely.

### Team Configuration Gets Smarter

Project config.md should express team composition as lens + model + scope,
not as fixed agent assignments:

```markdown
## Team
- orchestrator: steward, llama-3-8b (local), full project
- alpha: architect, claude-opus-4, system design + contracts
- beta: craftsman, claude-sonnet-4, backend (src/lib/**)
- gamma: craftsman, codex, frontend (src/web/**)
- delta: critic, claude-opus-4, review (full project)
```

But the steward should also be able to create ad-hoc teams for tasks
that don't match the default configuration. "This task needs a scout"
shouldn't require editing config.md.

### The Model Roster Is a First-Class Concept

The hive needs to know what models are available, what they cost, and
what they're good at. This information changes — new models ship monthly.
The roster should be human-editable (it's a section in config.md) and
hive-learnable (persona memory tracks which models work best for which
lenses on which kinds of tasks).

### Cross-Model Review Is a Default

The critic should default to a different model than the agents whose
work it's reviewing. This is the single highest-value practice in the
model-persona affinity theory — it catches bugs that same-model review
misses because the reviewer has genuinely different training biases.
The steward should enforce this unless overridden.

### Persona Creation Is a Hive Capability

`hive chat "create a persona for data migration thinking"` should
produce a usable persona file that follows the principles above:
cognitive description, weakness, handoff definition, voice examples.
The hive mind — even running on a small local model — can generate
good persona drafts because the template is clear and the principles
are documented.

### The Steward's Meta-Cognition

The steward is the only persona that needs to think about *other
personas*. It needs to:
- Read a task and identify which cognitive lenses are needed
- Select models based on lens-model affinity and available budget
- Size the team (resist the impulse to use all five when two will do)
- Detect when a task needs a lens that doesn't exist yet
- Learn from outcomes which compositions worked

This is what makes the steward the hardest persona to get right, and
why it benefits from the best available model for judgment calls even
when routine coordination runs on a cheap local model.

---

## The Long Game

As models get cheaper and faster, the cost of multiple perspectives
drops toward zero. The question stops being "can I afford three agents?"
and becomes "why would I ever use just one?"

As models specialize (code models, reasoning models, vision models,
domain-specific fine-tunes), the value of heterogeneous teams increases.
The right model for architectural thinking is different from the right
model for implementation is different from the right model for security
review. A system that composes these naturally — lens + substrate,
matched to task — extracts more value from the model ecosystem than
a system that picks one model and hopes it's good enough at everything.

As the hive accumulates experience, its team composition improves. It
learns which models shine on which tasks in which domains. It learns
which lens combinations produce productive disagreement and which
produce redundant agreement. It learns when three agents are worth the
overhead and when one is enough.

This is the thesis: **the future of AI-assisted software engineering
is not a better model. It's a better team.** And a better team requires
genuine cognitive diversity — not job titles from the human org chart,
but different ways of seeing applied through different substrates to
the same problem.

HIVE is built for this future. Not because it's the most sophisticated
framework — but because its primitives (cognitive personas, model
heterogeneity, file-based coordination, accumulated memory) are the
right primitives for composing intelligent teams from increasingly
capable and increasingly specialized models.

The org chart is dead. Long live the cognitive ensemble.
