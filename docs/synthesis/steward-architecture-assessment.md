# Steward Architecture Assessment

## Bottom Line

The steward is not yet operating cleanly at the abstraction layer above tasks.
HIVE has good pieces: a persistent chat head, deterministic supervision,
derived state, scoped worker dispatch, and a real routing policy surface. But
agency is split across too many places. The result is a system that can talk,
launch, and summarize, but does not yet have one durable coordinator brain
that decomposes work, staffs the team, runs the topology, and iterates for
hours without hand-holding.

The main problem is not missing prompts. It is missing control-plane
separation.

## 1. Are Conversation, Orchestration, and Planning Separated?

Short answer: partly separated in infrastructure, tangled in responsibility.

What is separated:

- The runtime docs correctly split `steward`, `state monitor`, `supervisor`,
  and `workers` as different layers
  (`docs/PERSISTENT-STEWARD-RUNTIME.md:76-141`).
- The supervisor already owns deterministic launch limits, scope conflict
  checks, and stale-run recovery (`src/lib/supervisor.ts:96-240`).
- The gateway already peels off some trivial conversation into tier-0 and
  tier-1 preprocessing (`src/gateway/console.ts:254-518`).

What is still tangled:

- The steward design explicitly keeps orchestration and synthesis as two
  modes of one steward (`docs/PERSISTENT-STEWARD-DESIGN.md:94-112`).
- Persona theory goes further and keeps scheduling, team composition, and
  synthesis inside one persona with tiered execution
  (`docs/HIVE-PERSONA-THEORY.md:992-1060`).
- The persistent steward session is persistent as a chat transport, but each
  turn still reloads runtime state, rebuilds steward context, rebuilds the
  bootstrap/refresh message, and decides what to do inside the same turn path
  (`src/lib/steward/turn.ts:897-996`, `src/lib/steward/context.ts:85-178`,
  `src/lib/steward/prompts.ts:109-220`).
- The strategic loop is a second planner, but it also acts directly by
  writing assignment and nudge messages itself instead of advising a single
  orchestrator (`src/lib/strategic-loop.ts:72-117`, `src/lib/strategic-loop.ts:173-249`).
- The gateway is a third decision locus: it can answer directly, wake the
  persistent steward, fall back to a disposable direct steward run, or route
  into background coordination (`src/gateway/console.ts:254-518`,
  `src/lib/steward/workflow.ts:560-910`).

Verdict:

- Conversation is split between gateway preprocessors and the steward.
- Orchestration is split between supervisor, steward tools, workflow fallback,
  and the strategic loop.
- Planning is split between steward prompting and the strategic loop.

That is not role separation. That is role overlap.

## 2. What Is the Current Cognitive Routing Capability?

Short answer: strong policy surface, weak autonomous staffing.

What exists now:

- A real routing policy object with explicit modes:
  `direct-answer`, `targeted-inspection`, `plural-synthesis`
  (`src/lib/cognitive-routing.ts:20-52`, `src/lib/cognitive-routing.ts:226-311`).
- Explicit runtime-lane resolution across direct runtimes and Pi routes
  (`src/lib/cognitive-routing.ts:303-474`).
- Tier-1 local/cloud/fallback configuration and local-model discovery
  (`src/lib/cognitive-routing.ts:314-368`).
- Actual tier-0/tier-1 interception for obvious console queries and simple
  message preprocessing (`src/gateway/console.ts:302-518`,
  `src/lib/cognition/tasks/message-preprocess.ts:81-157`).
- A delegation tool that lets the steward pick a model-pool entry and a
  persona per worker (`src/lib/steward/tools/delegate.ts:31-115`).

What does not exist yet:

- No first-class team-composition engine that reads a task and selects the
  right lenses, models, and topology from persona theory.
- No automatic cross-model critic rule, even though the design wants it
  (`docs/HIVE-PERSONA-THEORY.md:588-594`, `docs/HIVE-PERSONA-THEORY.md:969-981`).
- No planner that chooses between pipeline, fan-out/fan-in, and swarm as an
  execution graph. The topology language exists in docs, not in the runtime.
- No unified routing engine for all cognition. The strategic loop bypasses the
  routing system entirely and hardcodes a single Haiku pass with one action
  (`src/lib/strategic-loop.ts:23-25`, `src/lib/strategic-loop.ts:251-280`).

Verdict:

HIVE can route between deterministic, tier-1, direct-runtime, and Pi-backed
steward lanes. It cannot yet intelligently staff work end-to-end. The current
system exposes routing choices; it does not yet own them.

## 3. What Agent Patterns Exist Today?

Short answer: the primitives exist; the execution patterns do not yet exist as
first-class runtime objects.

What exists:

- Ad hoc worker creation with persona, model, scope, and optional verification
  (`src/lib/steward/tools/delegate.ts:31-115`).
- Deterministic parallel launch with max-parallel and scope-conflict gates
  (`src/lib/supervisor.ts:175-240`).
- Automatic assignment consumption and worker launch dispatch
  (`src/commands/worker-launch-dispatch.ts:134-235`).
- The docs clearly define the intended topologies:
  pipeline, fan-out/fan-in, and swarm
  (`docs/HIVE-PERSONA-THEORY.md:434-522`).

What does not exist:

- No durable task graph or execution graph representing topology.
- No notion of map phase vs reduce phase as runtime state.
- No first-class review gate that says "craftsman output must clear critic
  review before task completion."
- No commit boundary at all. Workers edit the shared working tree; the closest
  gate is shell verification, not critic approval
  (`src/lib/steward/tools/delegate.ts:41-45`, `src/lib/supervisor.ts:406-458`).
- `plural-synthesis` appears today mostly as a routing label in session
  metadata after worker activity is observed, not as a planner-owned execution
  strategy (`src/lib/steward/workflow.ts:387-397`, `src/lib/steward/workflow.ts:435-445`).

So can the steward run N agents in parallel?

- Yes, when scopes are disjoint and `maxParallel` allows it.

Can it run a real pipeline with critic review before commit?

- Not as a native architecture.
- It can simulate it by sending multiple assignments in sequence.
- It cannot enforce it as a durable coordination contract.

That gap matters. Simulation is not autonomy.

## 4. Biggest Architectural Change Needed

Build a coordinator control plane with a durable work graph, and move agency
into it.

That is the change.

Right now, the system has multiple partial brains:

- gateway preprocessor
- persistent steward turn path
- disposable direct steward path
- strategic loop
- supervisor

Only one of those should own decisions about what happens next.

### What The New Split Should Be

1. Conversational Interface

- Owns only human I/O.
- Decides only trivial tier-0/tier-1 replies.
- For non-trivial work, it hands the message to the coordinator and reports
  coordinator state back to the human.

2. Planner / Synthesizer

- Owns decomposition, team composition, topology choice, and disagreement
  synthesis.
- Runs episodically, not on every file event.
- Produces and updates a durable work graph, not direct worker launches.

3. Orchestrator / Executor

- Owns dispatch, retries, monitoring, interrupt, verification, and review
  gates.
- Deterministically advances the work graph.
- Never improvises strategy.

### What The Work Graph Must Contain

Each goal or mission needs durable state under project state, not just prompt
text:

- objective
- success criteria
- task nodes
- dependency edges
- execution topology: pipeline, fan-out/fan-in, swarm
- staffing decisions: persona + model + scope
- gates: critic review required, verify command required, human decision required
- synthesis points
- current state of each node

Without that artifact, the steward will keep improvising turn by turn.

### Why This Is The Highest-Leverage Change

It solves all four questions at once:

- Role separation becomes real and testable.
- Cognitive routing has somewhere concrete to write its decisions.
- Agent patterns become executable topologies instead of prompt advice.
- Critic-before-commit becomes a gate in the graph, not a convention.

## What To Build Next

Do this in order:

1. Introduce a durable coordination graph under project state.

- Not another prose plan.
- A machine-readable execution graph the orchestrator can advance.

2. Refactor the strategic loop into a planner that updates the graph only.

- It should stop dispatching workers directly.
- It should produce tasks, topology, staffing, and gates.

3. Refactor orchestration into a deterministic graph runner.

- Consume graph nodes.
- Launch workers.
- Enforce scope, parallelism, retries, verify, and critic gates.
- Trigger synthesis when graph nodes require integration.

4. Demote the steward session to interface + synthesis.

- The live steward should present progress and make judgment calls.
- It should stop being the only place where "what happens next" exists.

5. Add a first-class review gate.

- `craftsman -> critic -> verify -> steward synthesize` should be a native
  path, not an ad hoc pattern.
- Cross-model critic should be the default, not a prompt suggestion.

## What Not To Do

Do not start with:

- more prompt tuning
- more persona prose
- more routing prose
- more one-off strategic heuristics

Those all improve narration around the same architectural gap.

The missing piece is a durable autonomous coordinator that owns the work graph.
