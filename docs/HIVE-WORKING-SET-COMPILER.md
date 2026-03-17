# HIVE Working-Set Compiler

Design document. March 2026.

Depends on:
- [HIVE Cognitive Resource Management](./COGNITIVE-RESOURCE-MANAGEMENT.md)
- [HIVE Memory Architecture](./HIVE-MEMORY-ARCHITECTURE.md)
- [HIVE Persistent Steward Design](./PERSISTENT-STEWARD-DESIGN.md)

---

## 1. The Problem

HIVE's durable file substrate is its greatest strength and its biggest
bottleneck. Files make state inspectable, versionable, and recoverable. But
every consumer — the steward, the front door, `hive ask`, worker prompt
assembly, the gateway UI — independently reads raw files, parses them, and
assembles its own view of reality. That's duplicated work and duplicated
tokens.

The steward wakes up and re-reads BOARD.md, recent run results, open messages,
and memory files. A worker launches and assembles its own context from similar
raw sources. `hive ask` does the same. Each consumer pays the full I/O and
token cost of understanding state from scratch.

Meanwhile, HIVE already has three tier-1 consumers that compress state cheaply:
run compression, diff triage, and message preprocessing. They work, but they're
implemented as isolated functions, not as instances of a shared pattern.

The next architecture doesn't change HIVE's coordination topology. The steward
remains the single coordinator. Workers remain ephemeral. Personas remain
attentional stances. What changes is that **raw files stop being prompt cargo
and start being source material that gets compiled into reusable attention
artifacts.**

This is a speed layer, not a restructuring.

---

## 2. What HIVE Already Has Right

- **One coordinator.** The steward is the single writer to coordination state
  (BOARD.md, PLAN.md, messages). Workers communicate through msg/ and run
  results. This is Erlang-shaped: one process owns the shared state, others
  communicate through messages.

- **Ephemeral workers.** Workers are disposable. Their internal state doesn't
  matter. If they fail, the supervisor handles it. This is "let it crash."

- **Tier-1 compression.** Three real consumers already compile raw state into
  compact artifacts using cheap models. The pattern works.

- **Cognitive routing.** The escalation ladder (deterministic → tier-1 → worker
  → steward) is implemented and wired into the supervisor.

- **File substrate.** Inspectable, versionable, recoverable. Every piece of
  HIVE state can be understood by reading files.

What's missing is a **compiler** that turns those files into reusable compiled
state, so consumers stop paying the raw-file tax on every turn.

---

## 3. Design Principles

### 3.1 One Mind, Many Workers

HIVE is one entity. The steward is its coordinating intelligence. Workers are
its hands. Personas (architect, craftsman, critic, scout) are attentional
stances the steward or workers adopt — different lenses on the same soul, not
separate beings.

The user talks to one HIVE. Internally, HIVE routes work to the cheapest
sufficient model. But the external experience is always one coherent mind.

### 3.2 Compile Attention Before Spending Reasoning

Raw files are source material, not prompt cargo. The system should compile
compact, reusable artifacts from board state, messages, run results, diffs,
logs, memory files, and session history.

The expensive model should consume compiled state first and raw state only on
demand.

### 3.3 Spend the Cheapest Sufficient Tokens

- deterministic first
- small/local models second
- strong worker models third
- frontier synthesis last

The question is not "which model is smartest?" It is "what is the cheapest
lane that changes the decision?"

### 3.4 Compile Once, Consume Many

If five consumers need to know that a worker finished successfully and touched
three files, HIVE should not pay five times to rediscover it.

A packet generated for any purpose should be reusable by the steward, workers,
front door, UI, `hive ask`, and memory extraction.

### 3.5 The Steward Owns Coordination State

The steward is the single writer to BOARD.md, PLAN.md, and coordination
messages. Workers never write to coordination state — they write to msg/ and
run results. The steward integrates.

This is the principle that keeps HIVE coherent. Distributed coordination
over shared mutable files is a race condition wearing a design pattern costume.
One writer, many readers, message passing for everything else.

### 3.6 Durable Truth Lives on Disk

Files remain source of truth. Derived state (including compiled packets)
remains disposable. Delete the packet cache, restart, and the system
reconstructs from files.

---

## 4. Core Concepts

### 4.1 Packet

A **packet** is a compiled, fingerprinted unit of attention.

```ts
type Packet = {
  kind: string;
  projectId: string;
  fingerprint: string;
  producedAt: string;
  expiresAt: string | null;
  tier: 0 | 1;
  summary: string;
  details: Record<string, unknown>;
};
```

Packets are small. A `run-result` packet might be 120 tokens compiled from
5,000 tokens of raw worker output. A `board-health` packet might be 80 tokens
compiled from 2,000 tokens of BOARD.md plus active runs plus open messages.

Packets are identified by `kind` + `fingerprint`. If the source fingerprint
hasn't changed, the cached packet is still valid. No re-computation.

Example packet kinds:

- `run-result` — compressed worker output (existing: `compressCompletedRunOutput`)
- `diff-triage` — is this result steward-worthy? (existing: `triageRunDiffForSteward`)
- `human-request` — classified human message (existing: `preprocessHumanMessage`)
- `board-health` — board state summary (new, currently deterministic digest)
- `open-decisions` — pending decisions and blockers (new)
- `log-rollup` — compressed log window (new, idle)
- `phase-summary` — completed plan phase digest (new, idle)
- `memory-hotset` — most relevant memory entries (new, idle)
- `worker-brief` — assignment context for a new worker (new)

### 4.2 Working Set

A **working set** is the current collection of packets relevant to a turn or
consumer. It is what a consumer should see first.

The steward's working set for a refresh turn might be:
- `board-health`
- `open-decisions`
- recent `run-result` packets
- recent `diff-triage` packets
- `human-request` (if a human message triggered the wake)

A worker's working set for a new assignment might be:
- `worker-brief`
- relevant `run-result` packets from prior work on the same scope

`hive ask` might consume:
- `board-health`
- `open-decisions`
- `log-rollup`

The working set is assembled per-consumer, but the underlying packets are
shared.

### 4.3 Compile Task

A **compile task** is a registered function that produces a packet from source
inputs.

```ts
type CompileTask = {
  id: string;
  kind: string;
  trigger: "event" | "turn-start" | "idle";
  freshnessMs: number;
  shouldRun(input: CompileInput): boolean;
  fingerprint(input: CompileInput): string;
  run(input: CompileInput): Promise<Packet | null>;
};
```

The `shouldRun` gate is deterministic. It decides whether the task needs to
execute at all. Most events exit here.

The `fingerprint` function computes a cache key from source inputs. If the
fingerprint matches a cached packet, the task doesn't run.

The `run` function produces the packet. It may use deterministic logic (tier-0)
or a tier-1 model call.

### 4.4 Workbench

The **workbench** is the compiler engine. It owns:

- the task registry
- the packet cache
- the scheduler
- concurrency bounds
- budget awareness

It is not a daemon. It is a library that the supervisor, gateway, and front
door call when events happen or turns start.

---

## 5. Architecture

```
Layer 0: Durable Files
  SOUL / IDENTITY / SELF / AGENTS / TRUST
  PLAN / BOARD / LOG / msg / memory / runs
        │
        ▼
Layer 1: Deterministic State Fabric  (existing: src/lib/state.ts)
  parsers, fingerprints, run ledger, delta history, revision tracking
        │
        ▼
Layer 2: Working-Set Compiler  (new: src/lib/cognition/)
  task registry, tier-1 runners, packet cache, scheduler, budget
        │
        ▼
Layer 3: Consumers
  steward ─── front door ─── hive ask ─── worker prompts ─── gateway UI
```

### Layer 0 and Layer 1 don't change.

Layer 0 is the file substrate. Layer 1 is the existing deterministic state
fabric in `state.ts` — revision tracking, board parsing, message summaries,
run ledger, delta history. These remain as-is.

### Layer 2 is the new thing.

The workbench sits between the state fabric and the consumers. It takes raw
state as input and produces cached packets as output. Consumers read packets
instead of raw files.

### Layer 3 consumers get simpler.

Today, `loadPersistentStewardContext` reads config, session state, runtime
state, memory, history, and assembles everything into a massive context
object. After the compiler exists, it reads a working set of pre-compiled
packets and adds only what's unique to the steward turn.

---

## 6. Compilation Modes

### Event Compile

Triggered by a specific change. Low latency. Bounded concurrency.

- worker completed → `run-result` + `diff-triage` packets
- human message arrived → `human-request` packet
- board file changed → `board-health` packet

The existing tier-1 consumers (`compressCompletedRunOutput`,
`triageRunDiffForSteward`, `preprocessHumanMessage`) become event compile
tasks.

### Turn-Start Compile

Triggered when the steward or a consumer is about to reason. Assembles the
working set from cached packets, refreshing any that are stale.

- steward waking → assemble `board-health` + `open-decisions` +
  recent `run-result` + `diff-triage` + `human-request`
- `hive ask` → assemble `board-health` + `log-rollup`
- worker launching → assemble `worker-brief`

If all packets are fresh (fingerprints match), this is pure cache reads.
No model calls, no file parsing.

### Idle Compile

Triggered only when no human turn is active, no critical work is waiting,
and budget allows background cognition.

- `log-rollup` — compress old log entries
- `phase-summary` — summarize completed plan phases
- `memory-hotset` — identify most relevant memory entries
- stale-memory detection — flag memory entries that may be outdated

These run on local models or Haiku during quiet periods. The steward's
bootstrap context gets smaller and richer over time instead of growing
without bound.

---

## 7. Scheduler and Concurrency

The workbench scheduler uses bounded concurrency:

- local tier-1 tasks: 1-2 concurrent
- cloud tier-1 tasks: 2-3 concurrent
- foreground event/turn-start tasks outrank idle tasks
- deterministic gates run first; only ambiguous inputs reach a model

When five worker results land between supervisor ticks:

1. Run all deterministic gates (instant, parallel)
2. Most results exit — only ambiguous ones need tier-1
3. Tier-1 triage runs with bounded concurrency (not serial)
4. If one result is already steward-worthy, deprioritize the rest

This directly fixes the "serial triage loop" in the current supervisor.

---

## 8. Caching

Packets are cached by `kind` + `fingerprint`.

The fingerprint is computed from source inputs: the revision of the files or
state that the task reads. If the sources haven't changed, the cached packet
is returned without re-execution.

Cache storage is simple: JSON files in derived state.

```
state/
  packets/
    board-health.json
    open-decisions.json
    run-result/
      <run-id>.json
    diff-triage/
      <run-id>.json
    log-rollup/
      <window>.json
    memory-hotset.json
  compiler/
    cache-index.json
```

`cache-index.json` maps fingerprints to packet files. Disposable — delete it
and the workbench rebuilds from source on next compile.

---

## 9. Token Economics

### The Laws

1. **Never spend frontier tokens to reconstruct cheap state.** If tier-0 or
   tier-1 can compile it, the steward should not be reading raw logs.

2. **Spend cheap tokens to save expensive tokens.** A 4B local model compressing
   5,000 tokens into 120 tokens for the steward is a net gain.

3. **Compile once, reuse everywhere.** A `run-result` packet serves the steward,
   the UI, `hive ask`, and worker prompt assembly.

4. **Cache by fingerprint.** No changed source, no new model call.

5. **The steward should see the smallest sufficient working set.** Large context
   is a safety net, not the default operating mode.

### Measurement

Packets should track estimated token counts so HIVE can measure:

- tokens saved per packet reuse
- cost of tier-1 compilation vs. cost of raw steward hydration
- which compile tasks are most accretive

This makes "maximizing tokens" measurable, not rhetorical.

---

## 10. Steward and Workers

### The Steward

The steward remains the single persistent coordinator. It:

- owns BOARD.md, PLAN.md, and coordination messages
- consumes compiled working sets instead of raw state
- assigns work to ephemeral workers
- synthesizes results (the "reduce" in map-reduce)
- talks to the human

The steward is the one process that needs continuity. Everything else is
ephemeral.

### Workers

Workers are ephemeral. They:

- receive a working set (compiled assignment brief + relevant packets)
- execute within a scoped assignment
- write results to run records and msg/
- never write to BOARD.md, PLAN.md, or coordination state
- can be any model, any persona lens

Workers are the "map" in map-reduce. The steward launches them, they do work,
their output gets compiled into packets, the steward integrates.

### Personas

Personas are not separate entities. They are attentional stances:

- **steward**: coordination, integration, human conversation
- **architect**: boundaries, structure, interfaces
- **craftsman**: implementation quality, fit, detail
- **critic**: failure modes, review, adversarial challenge
- **scout**: terrain, options, precedent, research

The steward may adopt any persona stance. Workers are launched with a persona
lens that shapes their attention. But they all share one soul, one identity,
one set of operating principles.

### Adversarial Review

The one place where a "second opinion" genuinely helps is adversarial review:
a different model reviewing the steward's plan or a worker's output and
finding flaws the original model missed. This is epistemic diversity.

This doesn't require a separate coordinating mind. It requires:

1. The steward decides a result is high-stakes
2. The steward launches a critic worker (possibly on a different model)
3. The critic reviews the result and writes findings to msg/
4. The steward integrates the critique

The critic is still an ephemeral worker. The steward is still the coordinator.
The pattern is map-reduce with a review step, not distributed coordination.

---

## 11. Module Decomposition

### 11.1 Steward Split

Replace `src/lib/persistent-steward.ts` with:

```
src/lib/steward/
  turn.ts        — session lifecycle, streaming, interrupts, completion
  runtime.ts     — provider/model resolution, auth policy
  prompts.ts     — system prompt, bootstrap message, refresh message
  context.ts     — load steward context from compiled working set
  usage.ts       — token usage summarization
  tools/
    index.ts     — tool registration
    bash.ts      — shell command execution
    files.ts     — read, write, edit
    search.ts    — grep, find, ls
```

This is a mechanical refactor. The seams are already visible.

### 11.2 Working-Set Compiler

```
src/lib/cognition/
  workbench.ts   — task registry, scheduler, cache, budget
  packets.ts     — packet type, helpers, fingerprinting
  tasks/
    run-compression.ts    — existing: compressCompletedRunOutput
    diff-triage.ts        — existing: triageRunDiffForSteward
    message-preprocess.ts — existing: preprocessHumanMessage
    board-health.ts       — new: board + runs + messages summary
    worker-brief.ts       — new: assignment context for workers
    log-rollup.ts         — new: idle log compression
    memory-hotset.ts      — new: idle memory relevance ranking
```

Start with one file for the workbench (registry + scheduler + cache). Split
when it earns the split, not before.

### 11.3 Consumer Rebase

After the workbench exists:

- `loadPersistentStewardContext` → reads working set, not raw state
- `hive ask` → reads `board-health` + `log-rollup` packets
- worker prompt assembly → reads `worker-brief` packet
- gateway `/api/cognition` → reads cached packets

Prompt construction gets thinner and more uniform.

---

## 12. Migration Plan

### Phase 1: Split the Steward

Move tool implementations, runtime resolution, and prompt construction out
of `persistent-steward.ts`. Keep turn lifecycle focused.

**Outcome:** The steward code is small enough to reason about. Clear seams
exist for the compiler.

### Phase 2: Introduce the Workbench

Create the packet type. Create the task registry. Create the scheduler with
bounded concurrency. Move the three existing tier-1 consumers into compile
tasks.

**Outcome:** HIVE has one place where tier-1 compaction lives. The serial
triage loop in the supervisor becomes concurrent.

### Phase 3: Materialize Working Sets

Emit packet files to derived state. Emit a working-set aggregate. Update the
state refresh path to integrate packet generation.

**Outcome:** Compiled context is a real inspectable artifact on disk.

### Phase 4: Rebase Consumers

Update steward bootstrap/refresh, `hive ask`, `hive console`, and worker
prompt assembly to consume compiled working sets.

**Outcome:** Most reasoning surfaces consume compiled state first. Token
spend drops for high-context operations.

### Phase 5: Idle Compilation

Add log rollups, phase summaries, memory hotset refresh, and stale-memory
detection as idle compile tasks.

**Outcome:** Bootstrap context shrinks over time. Memory gets hotter and more
useful. The hive gets smarter while idle.

---

## 13. Future Directions

### Shared Coordination Substrate

The file substrate works today. As HIVE scales — more workers, longer sessions,
cross-project coordination — files may become a bottleneck for real-time state.
Projects like [Agent-MCP](https://github.com/rinadelph/Agent-MCP) explore
shared knowledge graphs and message-passing protocols over MCP as an
alternative coordination substrate.

The relevant question isn't "files vs. database" but "what is the fastest way
for multiple processes to share truth?" The compiler architecture is substrate-
agnostic: packets can be materialized as files, stored in a shared memory
service, or served over MCP. The workbench abstraction isolates consumers from
the answer.

### Cross-Model Review

When the compiler and consumer rebase are stable, the natural next experiment
is systematic adversarial review: a different model reviewing high-stakes
steward decisions. This is the lightest form of "multi-mind" — not distributed
coordination, but epistemic diversity within the same coordinator topology.

### Continuous Compilation

The idle compiler could eventually become continuous: a background process that
watches file changes, updates packets incrementally, and keeps the working set
warm at all times. The steward would never pay cold-start cost. This depends
on the workbench being cheap enough to run continuously — which depends on
local models being fast and the cache hit rate being high.

---

## 14. What This Does Not Do

- **No distributed coordination.** The steward is the single coordinator.
  Workers communicate through messages and run results, not shared mutable
  state. This is deliberate — coherence requires one writer to coordination
  state.

- **No seat/lease/pod runtime.** Coordination authority lives in the steward,
  not in a distributed lease system. Workers get scoped assignments, not
  coordination leases.

- **No hidden database.** Derived state (including packets) remains disposable.
  Files remain source of truth.

- **No persona theater.** Personas are cognitive lenses, not separate entities.
  The steward adopts different stances. Workers are launched with a lens.
  There is one HIVE.

---

## 15. Success Criteria

1. The steward consumes compiled working sets instead of raw state.
2. Tier-1 compaction is expressed as reusable compile tasks in one registry.
3. Steward, console, `hive ask`, and worker prompts all consume the same
   compiled packets.
4. Idle compilation keeps bootstrap context from growing without bound.
5. Token spend drops for repeated high-context operations.
6. The user experiences one HIVE, not a bag of agents.
7. `persistent-steward.ts` is no longer a 1,757-line monolith.

---

## 16. The Essence

The shift is simple:

**The prompt is not the unit of intelligence. The compiled working set is.**

HIVE's file substrate is its memory. The compiler is the thing that reads
memory and prepares it for reasoning. The steward is the thing that reasons.
Workers are the things that act. Tier-1 models are the things that compile.

One soul. One coordinator. Cheap compilation. Ephemeral execution. That's
the whole architecture.
