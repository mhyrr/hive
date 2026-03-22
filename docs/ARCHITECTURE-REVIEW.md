# Architecture Review

March 2026. Review against the positioning: lightweight, multi-model,
crash-resilient agent orchestration.

---

## Verdict

The architecture is sound. The core loop works. The file substrate is
durable. Multi-model dispatch functions across four runtime adapters.
There is no fundamental redesign needed.

What follows is an honest assessment of what is clean, what has
accumulated cruft, and what needs to change to make the differentiators
real rather than structural.

---

## What Is Clean (Preserve)

### The Core Loop

The steward → assignment → worker → result loop is traceable end-to-end.
A human message enters through the gateway or CLI. The steward processes
it. If work is needed, the steward writes an assignment file. The watcher
fires within 200ms. The supervisor launches the worker. The worker runs,
completes, and writes its result. The watcher fires again. The steward
wakes with a delta. Clean, event-driven, fast.

### The File Substrate

Path resolution is centralized in `paths.ts`. Every file has a
predictable location. All persistent state is human-readable markdown or
JSON. The frontmatter parser is minimal and dependency-free. Formats are
stable. There is no hidden database layer. `cat BOARD.md` tells you what
is happening.

### The Steward Tool Interface

The `PersistentStewardTool` type is clean and well-separated. Six tool
families (file, search, bash, delegation, elicitation, inspection) with
consistent `execute` signatures. The tool set is composable — inspection
tools are conditionally included based on available paths.

### Worker Brief Assembly

Smart context selection. Scope-matching to pull relevant prior results.
Sensible limits (6 open messages, 5 relevant results). The brief gives
a worker exactly what it needs without flooding it.

### Board Parsing

Handles multiple formats. Extracts tasks, agents, blockers, decisions,
and dependencies. No over-engineering.

### Delta State Tracking

The fingerprint-based change detection and delta history pattern is
efficient. The steward gets a compact diff of what changed since its last
turn, not a full state dump every time.

---

## What Needs Attention

### 1. Runtime Adapters Are Claude-Centric

Multi-model dispatch is the core differentiator, but the adapter
implementations are uneven.

| Adapter | Output Capture | Error Classification | Metadata Extraction |
|---------|---------------|---------------------|-------------------|
| Claude  | Streaming JSON deltas | Partial | Full (tokens, cost, turns) |
| Codex   | None (file-based hack) | Generic exit code | Empty |
| Gemini  | None | Generic exit code | Empty |
| Ollama  | None (delegates to Codex) | Generic exit code | Empty |

Only Claude has `createOutputCapture()` and `parseOutput()`. The other
three adapters return empty metadata. If multi-model is the bet, this gap
needs closing — at minimum, Codex and Gemini should extract token counts
and costs from their output.

**The Ollama adapter is not a real Ollama integration.** It invokes
`codex --oss`. There is no direct HTTP connection to an Ollama server.
The `discoverLocalModels()` function in cognitive-routing.ts detects
what is available locally but is not wired into dispatch. For a system
that claims token arbitrage through local models, this is the most
important gap to close.

**Recommendation:** Decide whether Ollama is a first-class runtime or a
Codex variant. If first-class, give it a direct HTTP client, model
discovery at startup, and real output parsing. If a variant, document it
honestly and remove the separate adapter.

### 2. Cognitive Routing Is Prompt Guidance, Not Code

The cognitive routing system defines a clean policy structure — bias
modes (latency/balanced/quality), max fanout, max parallel, model tiers.
But this policy is rendered into the steward's system prompt as text. No
code reads `readCognitiveRoutingPolicy()` and uses it to automatically
select a runtime.

The steward decides what to delegate based on LLM judgment, not routing
logic. This is fine for now — LLM-driven routing is actually more
flexible than hardcoded rules. But if you want deterministic token
arbitrage (tier-1 local for triage, tier-2 cloud for coding), that
decision should happen in code, not in a prompt that the model may or
may not follow.

**Recommendation:** Keep LLM-driven routing for complex decisions. Add
deterministic routing for the easy ones: state monitoring is always
tier-1, code generation is always tier-2+, triage classification is
always the cheapest available model.

### 3. Dead Code in orchestrator.ts

`src/lib/orchestrator.ts` re-exports four symbols from
`steward/prompts.ts`. Three of them (`buildOrchestratorPrompt`,
`OrchestrateMode`, `OrchestrateOptions`) do not exist in the target
module. Nothing imports from `orchestrator.ts`. This is a vestige of the
pre-steward design.

**Recommendation:** Delete the file.

### 4. turn.ts Is Too Large

`src/lib/steward/turn.ts` is 1400+ lines handling message extraction,
handle lifecycle, Pi SDK integration, notification draining, and output
formatting. This is the most complex file in the codebase and the
hardest to reason about.

**Recommendation:** Split into layers:
- `turn-handle.ts` — lifecycle (start, dispose, idle timeout)
- `turn-messages.ts` — message extraction and formatting
- `turn-pi.ts` — Pi SDK integration
- `turn-notifications.ts` — notification drain and delta injection

### 5. Active Run Recovery Is Incomplete

Run recovery via `reconcileActiveConsoleRun()` only handles console runs.
Other agent types with orphaned active entries are not automatically
recovered. The run lifecycle stores state in two places — `runs/active/`
and `runs/{year}/{month}/{runId}/run.md` — and sync between them is
implicit.

**Recommendation:** Generalize run reconciliation to all agent types.
The supervisor already checks PIDs; it should also clean up orphaned
active entries for non-console runs.

### 6. No Atomic Multi-File Writes

Derived state writes 8 separate JSON files in a loop. If the process
crashes midway, some files reflect the new state and others don't. The
next refresh may see inconsistent state.

This is acceptable for derived state (it gets recomputed anyway), but
worth noting as a limitation. The source-of-truth files (BOARD.md,
msg/, run.md) are single-file writes and are safe.

**Recommendation:** For derived state: write to `.tmp` files, then
rename atomically. Low priority — the system self-heals on next refresh.

### 7. Unbounded Log Growth

`feed.md` and per-project `LOG.md` grow indefinitely. `appendFeedEntry`
reads the entire file and rewrites it on every append (O(n) memory).
For long-running autonomous operations, this becomes a performance issue.

**Recommendation:** Implement log rotation when files exceed a size
threshold. Archive old entries to `archive/`.

---

## What Should Not Change

### The Steward as LLM Coordinator

The steward makes delegation decisions through LLM judgment guided by
system prompt rules. Do not replace this with a hardcoded router. The
LLM's ability to understand context, urgency, and scope makes it a
better coordinator than a rule engine. Add deterministic routing for
tier-1 triage work alongside it, not instead of it.

### Files as the API

The file substrate is the right abstraction for this system. Do not add
a database. Do not add a message broker. The inspectability and crash
resilience of plain files is worth the performance trade-off.

### Markdown as the Data Model

Keep frontmatter for metadata, markdown body for content. Do not switch
to JSON or YAML for primary state. Human readability is a feature.

### Zero Dependencies

The zero-npm-dependency constraint keeps the system simple and the binary
small. Keep it.

### Event-Driven Coordination

File watchers at 200ms are the right primary coordination mechanism. The
120s supervisor poll as safety net is correct. Do not go back to polling
as the primary path.

---

## Priority Order

If doing one thing: **close the Ollama gap**. A real local model
integration with direct HTTP dispatch is the most concrete way to make
token arbitrage real, not theoretical.

If doing two things: **unify output capture** across adapters so that
token counts and costs are tracked regardless of runtime.

If doing three things: **delete orchestrator.ts and split turn.ts** to
reduce accumulated complexity.

Everything else is incremental improvement on a sound foundation.
