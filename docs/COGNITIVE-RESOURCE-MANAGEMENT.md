# HIVE Cognitive Resource Management

Phase 2 design. March 2026.

Depends on: [Persistent Steward Design](./PERSISTENT-STEWARD-DESIGN.md)

---

## 1. The Problem

Phase 1 gives HIVE a persistent steward: a long-lived session that converses
with humans and coordinates workers. But the steward currently runs every task
through the same expensive model. Meanwhile, most of the cognitive work in a
hive session is routine — summarization, classification, triage, compression —
work that does not need frontier reasoning.

HIVE operates in an environment with heterogeneous compute:

- deterministic processes (free, instant)
- local small models (free after hardware, fast, private)
- cheap cloud models like Haiku (pennies, low latency)
- strong cloud models like Sonnet (moderate cost, strong reasoning)
- frontier models like Opus (expensive, best reasoning)

Without explicit policy, the system wastes expensive tokens on cheap work,
or worse, routes everything through one tier because that's all it knows how
to do.

Phase 2 introduces routing policy so the right intelligence handles the right
work.

---

## 2. Design Principles

1. **Default to the cheapest tier that works.** Escalate only when needed.
2. **Local models are free.** Use them aggressively for routine cognition.
3. **The steward is the scarcest resource.** Protect it from noise.
4. **Policy, not infrastructure.** Routing decisions are configuration, not a
   distributed scheduler.
5. **Track what you spend.** You can't manage what you don't measure.

---

## 3. The Model Landscape

### 3.1 What's Available Now

HIVE's runtime adapter system (`src/lib/runtime.ts`) already supports
multiple runtimes (Claude, Codex, Gemini) with per-agent model selection via
team descriptors and plan agents. Token metadata (input, output, cache, cost)
is already captured per run in `RuntimeMetadata`.

What's missing is:

- local model adapters
- a concept of model tiers in routing decisions
- aggregated usage tracking across runs

### 3.2 Local Models Worth Running

Two families stand out for local deployment on a dev laptop or home server:

**Qwen 2.5 (3B / 7B)** — Alibaba's small models. Strong at code
understanding, summarization, and structured output. The 3B fits comfortably
in ~4GB VRAM. The 7B is the sweet spot for quality/speed on a decent GPU.
Runs well under Ollama or llama.cpp.

**Gemma 2 (2B / 9B)** — Google's open models. The 2B is remarkably capable
for classification and extraction tasks given its size. The 9B competes with
much larger models on reasoning benchmarks. Good llama.cpp support.

Both run via Ollama, which provides an OpenAI-compatible API that makes
integration straightforward.

### 3.3 Haiku

Claude Haiku deserves special mention. It's not local, but it's fast (~200ms
TTFT) and cheap (~$0.25/MTok input, $1.25/MTok output). For cloud-based
routine cognition — summarization, classification, triage — Haiku is the
default choice when local models aren't available or when the task benefits
from Claude's instruction following.

Haiku is the cloud tier-1 default. Local models are the local tier-1 default.
The system should prefer local when available, fall back to Haiku when not.

---

## 4. Cognitive Tiers

### Tier 0: Deterministic

No model. File watching, revision hashing, state diffing, run supervision,
process management, threshold checks, stale-run detection.

This is where most of the activation gate lives. It should handle the
majority of events.

### Tier 1: Routine Cognition

Small, fast, cheap models handling narrow tasks that need language
understanding but not deep reasoning.

**Local options:** Qwen 2.5 3B, Gemma 2 2B, Qwen 2.5 7B, Gemma 2 9B
**Cloud option:** Claude Haiku

Tasks:

- summarize worker output into a one-line digest
- classify a worker result as success / partial / blocked / failed
- compress a run log into key decisions and outcomes
- triage a file diff: is this steward-worthy or routine?
- extract action items from a worker's output
- prepare compact delta packets for the steward
- judge whether a human message needs the steward or can be answered directly

These are not "full minds." They are narrow cognition modules. A 3B model
can summarize a 2000-token worker log into 50 tokens perfectly well. There is
no reason to spend Opus tokens on this.

### Tier 2: Worker Cognition

Strong models powering the disposable worker fleet. This is the existing HIVE
worker model, unchanged.

**Typical models:** Claude Sonnet, strong local models (Qwen 32B, etc.),
domain-tuned models

Tasks: architecture, implementation, critique, research, code generation,
design review — anything requiring real reasoning within a scoped assignment.

### Tier 3: Steward Cognition

The persistent steward session. Best available model. Used for synthesis,
arbitration, planning, human conversation, cross-agent coordination.

**Typical model:** Claude Opus

This is the most expensive tier and should be invoked least frequently.

---

## 5. The Escalation Ladder

For every event or task, the system asks:

1. Can it be ignored entirely? → drop it
2. Can deterministic logic handle it? → tier 0
3. Can a small model resolve it? → tier 1
4. Does it need a scoped worker? → tier 2
5. Does the steward need to reason about it? → tier 3

This is a policy, not a pipeline. Most events exit at step 1 or 2. The
ladder is a decision framework, not a sequence every event traverses.

### Routing Factors

When deciding tier:

- **Complexity**: simple classification vs. multi-step reasoning
- **Urgency**: can it wait for a batch, or does the human need it now?
- **Ambiguity**: clear-cut vs. conflicting signals requiring judgment
- **Stakes**: routine housekeeping vs. something affecting the user or plan

These factors are evaluated by the activation gate (deterministic) and
optionally by a tier-1 model for borderline cases.

---

## 6. Local Model Integration

### 6.1 Runtime Adapter

Add an `ollama` runtime adapter to HIVE's existing adapter registry. Ollama
exposes an OpenAI-compatible API, so the adapter is thin:

- `command`: `ollama`
- `detectInstalled`: check for `ollama` binary
- model selection via the existing `model:` field in agent descriptors
- output parsing via the OpenAI-compatible JSON response format

This gives HIVE local model support through the same interface it already uses
for Claude, Codex, and Gemini.

### 6.2 Discovery

On gateway startup, probe for available local models:

```
ollama list → available models and their sizes
```

Store the result in derived state. The routing policy uses this to know what's
locally available. If Ollama isn't running or has no models, tier-1 falls back
to Haiku seamlessly.

### 6.3 Model Selection Heuristics

For tier-1 tasks, prefer:

1. Local model if available and task fits context window
2. Haiku if no local model or task benefits from stronger instruction following
3. Both in parallel if the task is ambiguous and we want agreement

Keep this simple. A config file maps task types to preferred models:

```
tier1_local: qwen2.5:7b
tier1_cloud: haiku
tier1_fallback: haiku
```

Don't build a dynamic model marketplace. A static config that the user can
edit is the right level of complexity for phase 2.

---

## 7. Concrete Tier-1 Use Cases

### 7.1 Worker Output Compression

Today, when a worker finishes, its full output goes into the run record and
eventually into the steward's context. Most of this is noise.

After phase 2:

```
worker completes
  → tier-1 model reads the output
  → produces: { summary: "...", outcome: "success|partial|blocked|failed",
                 key_decisions: [...], files_changed: [...] }
  → this compact digest is what the steward sees
```

The steward can always request the full output if needed. But by default, it
gets a 50-100 token summary instead of a 5000-token raw dump.

### 7.2 Diff Triage

When files change, the state monitor detects it. But should the steward care?

```
file changed
  → deterministic: is it a key file (PLAN.md, BOARD.md, etc.)? → yes: wake steward
  → deterministic: is it a run artifact? → yes: skip
  → ambiguous: tier-1 model reads the diff
  → tier-1: "this is a routine test file update, no steward attention needed"
  → or: "this modifies the API contract, steward should review"
```

### 7.3 Message Pre-Processing

Not every human message needs the full steward. "What time is it?" doesn't
need Opus.

```
human message arrives
  → tier-1 model classifies: simple_query | status_check | directive | complex
  → simple_query: tier-1 answers directly
  → status_check: tier-0 generates status from derived state
  → directive | complex: wake the steward
```

This is optional and should be conservative. When in doubt, wake the steward.
The user should never feel like they're talking to a lesser model when they
expect the steward.

### 7.4 Log and Memory Compression

Periodic background task (when idle):

```
tier-1 model compresses old log entries
tier-1 model summarizes completed plan phases
tier-1 model identifies stale memory entries
```

Results go to derived state. The steward's bootstrap context gets smaller
over time instead of growing unboundedly.

---

## 8. Usage Tracking

HIVE already captures per-run token metadata in `RuntimeMetadata`. Phase 2
extends this with aggregated tracking.

### 8.1 What to Track

Per window (rolling 24h, configurable):

- tokens consumed by tier (tier-1, tier-2, tier-3)
- number of steward activations
- number of worker runs
- number of tier-1 invocations
- estimated cost

### 8.2 Where to Store It

In derived state alongside the other runtime state files:

```
~/.hive/projects/<project>/state/usage.json
```

This is disposable derived state, not source of truth. If deleted, it
rebuilds from run records.

### 8.3 What to Do With It

Simple policies:

- **Warn** when approaching budget thresholds
- **Downgrade** tier-2 workers to cheaper models when budget is tight
- **Defer** non-urgent tier-1 background tasks when budget is tight
- **Report** usage to the human on request ("how much have we spent?")

Do not build automatic budget enforcement that silently degrades the system.
Surface the information and let the human or steward decide. Automatic
downgrade should be conservative and transparent.

---

## 9. Implementation Plan

### Step 1: Ollama Adapter

Add an `ollama` runtime adapter to the existing adapter registry. Test with
Qwen 2.5 7B and Gemma 2 9B. Verify output parsing and model selection work
through the standard HIVE flow.

### Step 2: Tier-1 Task Runner

Add a lightweight function that routes a tier-1 task (prompt + context) to
either a local model or Haiku based on availability. This is not a new
daemon — it's a function the gateway and supervisor can call.

```typescript
async function runTier1Task(task: {
  prompt: string;
  context: string;
  preferLocal: boolean;
}): Promise<{ result: string; model: string; tokens: number }>
```

### Step 3: Worker Output Compression

After a worker run completes, pass its output through the tier-1 task runner
to produce a compact digest. Store the digest alongside the full output in
the run record. Feed the digest (not the full output) to the steward.

### Step 4: Usage Tracking

Aggregate `RuntimeMetadata` from completed runs into `usage.json`. Add a
gateway endpoint and console display for usage reporting.

### Step 5: Routing Policy

Add configuration for routing preferences:

```
# in project config or ~/.hive/config.md
tier1_local: qwen2.5:7b
tier1_cloud: haiku
tier2_default: sonnet
tier3_default: opus
```

The activation gate uses these preferences when deciding which tier handles
a task.

---

## 10. What This Does Not Do

- **No distributed scheduler.** Routing is policy-based configuration, not a
  resource auction or optimization algorithm.
- **No dynamic model evaluation.** The system doesn't benchmark models against
  each other at runtime. The user configures which models fill which tiers.
- **No automatic budget enforcement.** Usage tracking informs decisions; it
  doesn't silently degrade the system.
- **No universal model abstraction.** The runtime adapter interface stays as-is.
  Ollama is added as one more adapter, not a new abstraction layer.
- **No tier-1 gateway for all human messages.** The steward remains the
  default human interface. Tier-1 pre-processing is optional and conservative.

---

## 11. Where Pain Might Live (Future Work)

These are things we're deliberately not building now but should watch for:

**Tier-1 quality variance.** Local 3B models may produce inconsistent
summaries. If worker output compression proves unreliable, we may need
validation (run two models, compare) or a quality threshold that falls back
to Haiku. Watch for cases where the steward asks for full output because
the summary was inadequate.

**Context window pressure on local models.** Small models have 4K-8K context
windows. Worker outputs that exceed this need chunked summarization or
selective extraction. If this becomes common, we'll need a chunking strategy.

**Ollama cold start.** First inference after model load is slow. If HIVE
frequently switches between local models, load times may hurt. May need a
keep-alive policy or a single preferred model that stays hot.

**Cross-tier coherence.** When tier-1 summaries feed tier-3 reasoning,
information loss compounds. If the steward consistently makes worse decisions
because it's working from compressed inputs, we may need to rethink which
summaries are lossy vs. lossless.

**Budget contention across projects.** If multiple HIVE projects share the
same API keys, per-project budgets need coordination. Not a problem until
someone runs multiple projects simultaneously.

**Model freshness.** Local models get stale. Qwen 2.5 is great today; Qwen 3
may be better in six months. Need a low-friction way to swap models without
reconfiguring everything. The tier-based config makes this easy (change one
line), but we should watch for cases where model-specific prompt tuning
creates lock-in.

---

## 12. Success Criteria

1. Routine summarization and classification run on local models or Haiku,
   not the steward's model.
2. The steward receives compact digests instead of raw worker output.
3. Token spend on tier-3 drops meaningfully without degrading steward quality.
4. `hive status` (or equivalent) shows usage by tier.
5. Adding a new local model is a one-line config change.
6. The system works fine with no local models — Haiku fills tier-1 seamlessly.
7. The user can see what's being routed where and override it.
