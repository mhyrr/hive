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

### 3.2 Local Models Worth Running (March 2026)

The small model landscape moved fast in early 2026. Two families lead for
HIVE's tier-1 use cases:

**Qwen 3.5 (4B / 9B)** — Alibaba's latest small series (released Feb/Mar
2026). The 4B is the standout: it rivals Qwen 2.5 72B on many benchmarks
despite being 18x smaller. Supports tool calling, thinking mode, and
multimodal input natively. The 4B runs in ~3GB VRAM (Q4 quantized). The 9B
is ~5GB and competitive with models 13x its size. Both support structured
output, which matters for producing JSON digests. Apache 2.0 licensed.

**Gemma 3 (1B / 4B / 12B)** — Google's third-generation open models (released
early 2026). The 4B is multimodal (text + vision), has QAT quantization
support for efficient inference, and excels at structured output and
instruction following. The 1B is text-only but extremely fast — good for
the simplest classification tasks where latency matters more than nuance.
The 12B is strong enough to blur into tier-2 territory.

Both families run via Ollama, which has become the de facto standard for
local model deployment. Ollama provides an OpenAI-compatible API that makes
integration straightforward.

**Other notable options:**

- **Phi-4 Mini (3.8B)** — Microsoft. Exceptional reasoning and math for its
  size. Good for analytical tasks like deciding whether a diff is significant.
- **SmolLM3 3B** — Hugging Face. Outperforms Llama 3.2 3B and Qwen 2.5 3B
  at the 3B scale. Fully open, instruct-tuned with reasoning support.
- **Llama 3.2 3B** — Meta. 128k context window is the largest in this class.
  Good when worker output is long and needs single-pass summarization.

The recommended default pairing for HIVE tier-1 is **Qwen 3.5 4B** (primary,
best all-around) with **Gemma 3 4B** as an alternative (strongest structured
output, multimodal if we ever want vision). Either fits comfortably on a
laptop GPU or even CPU-only with acceptable latency for background tasks.

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

**Local options:** Qwen 3.5 4B, Gemma 3 4B, Phi-4 Mini, SmolLM3 3B
**Cloud option:** Claude Haiku

Tasks:

- summarize worker output into a one-line digest
- classify a worker result as success / partial / blocked / failed
- compress a run log into key decisions and outcomes
- triage a file diff: is this steward-worthy or routine?
- extract action items from a worker's output
- prepare compact delta packets for the steward
- judge whether a human message needs the steward or can be answered directly

These are not "full minds." They are narrow cognition modules. A 4B model
can summarize a 2000-token worker log into 50 tokens perfectly well. There is
no reason to spend Opus tokens on this.

### Tier 2: Worker Cognition

Strong models powering the disposable worker fleet. This is the existing HIVE
worker model, unchanged.

**Typical models:** Claude Sonnet, strong local models (Gemma 3 27B, Qwen 3.5
32B, etc.), domain-tuned models

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

## 6. Local Model Integration via Pi

### 6.1 pi-ai Instead of a New Adapter

The Phase 1 design doc establishes that the persistent steward uses Pi's
`Agent` class from `@mariozechner/pi-agent-core`. Pi's underlying LLM
library, `@mariozechner/pi-ai`, already supports Ollama as a provider via
its OpenAI-compatible API support:

```typescript
import { getModel, complete } from "@mariozechner/pi-ai";

// Local model via Ollama
const local = getModel("ollama", "qwen3.5:4b");

// Cloud model via Anthropic
const cloud = getModel("anthropic", "claude-haiku-4-5-20251001");
```

This means tier-1 tasks use the same `complete()` / `stream()` API
regardless of whether they hit a local model or a cloud model. No separate
"ollama adapter" in HIVE's runtime registry is needed for tier-1 work —
pi-ai handles the provider abstraction.

HIVE's existing runtime adapter system (`src/lib/runtime.ts`) remains for
launching disposable worker processes (tier-2). An Ollama adapter there is
still useful for workers that run locally, but it's a separate concern from
tier-1 routing.

### 6.2 Discovery

On gateway startup, probe for available local models:

```typescript
import { getModel } from "@mariozechner/pi-ai";

// Check if Ollama is available and which models are loaded
async function discoverLocalModels(): Promise<string[]> {
  try {
    const response = await fetch("http://localhost:11434/api/tags");
    const data = await response.json();
    return data.models.map((m: any) => m.name);
  } catch {
    return []; // Ollama not running
  }
}
```

Store the result in derived state. The routing policy uses this to know
what's locally available. If Ollama isn't running or has no models, tier-1
falls back to Haiku seamlessly.

### 6.3 Model Selection Heuristics

For tier-1 tasks, prefer:

1. Local model if available and task fits context window
2. Haiku if no local model or task benefits from stronger instruction following
3. Both in parallel if the task is ambiguous and we want agreement

Keep this simple. A config file maps tiers to preferred models:

```
tier1_local: qwen3.5:4b
tier1_cloud: haiku
tier1_fallback: haiku
```

In code, this becomes:

```typescript
function getTier1Model(config: TierConfig): Model {
  if (config.tier1_local && localModels.includes(config.tier1_local)) {
    return getModel("ollama", config.tier1_local);
  }
  return getModel("anthropic", "claude-haiku-4-5-20251001");
}
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

HIVE already captures per-run token metadata in `RuntimeMetadata` for
worker processes. Pi's `message.usage` provides the same data (input tokens,
output tokens, cost) for steward and tier-1 calls. Phase 2 unifies these
into aggregated tracking.

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

## 9. Console UI

Cognitive resource management should be visible but not intrusive. The user
should be able to ignore it entirely during normal operation but find the
information immediately when they want it. Three layers, from least to most
detailed:

### 9.1 Topbar Budget Chip

Add a small chip to the existing topbar, between the agent count and the
connection indicator:

```
HIVE │ myproject │ ● active ↻ │ 3 agents ▾ │ ⚡ 14k T3 │ ● connected
```

The chip shows tier-3 (steward) token consumption for the current window.
This is the single most important number — it tells you whether the steward
is burning through budget or running efficiently.

**States:**

- `⚡ 14k T3` — normal, showing tier-3 tokens used
- `⚡ 45k/50k T3` — approaching budget threshold (amber)
- `⚡ 52k/50k T3` — over budget (red)
- `⚡ — T3` — no usage data yet

Click to expand a dropdown (same pattern as the existing agents dropdown)
showing per-tier breakdown:

```
┌─────────────────────────────┐
│  Cognition (24h)            │
│                             │
│  T3  steward     14,200 tk  │
│  T2  workers     83,400 tk  │
│  T1  local/haiku 41,800 tk  │
│  T0  deterministic    —     │
│                             │
│  est. cost        $0.42     │
│  steward wakes    7         │
│  worker runs      12        │
│  tier-1 calls     34        │
└─────────────────────────────┘
```

This mirrors the agents dropdown pattern: a topbar chip with a details
flyout. No new UI paradigm.

### 9.2 Console Turn Chips

Console turns already display detail chips (clickable metadata). Extend
these to show which model/tier handled the response:

```
┌──────────────────────────────────────────────┐
│ ASSISTANT  12:34                             │
│ The refactoring is complete. I assigned the  │
│ architect to review the API boundary...      │
│                                              │
│ [opus] [1,240 tk] [detail]                   │
└──────────────────────────────────────────────┘
```

For tier-1 responses (if message pre-processing answers directly):

```
┌──────────────────────────────────────────────┐
│ ASSISTANT  12:35                             │
│ 3 workers are currently active.              │
│                                              │
│ [haiku] [82 tk] [detail]                     │
└──────────────────────────────────────────────┘
```

This tells the user *per response* what did the work. It also makes routing
tangible — when the user sees `[qwen3.5:4b]` on a summary vs. `[opus]` on a
synthesis, the tiering stops being abstract.

The model chip is always visible. Token count and detail are secondary chips
that follow the existing pattern.

### 9.3 Feed Panel Cognition Section

Add a collapsible section to the feed panel, between Process Logs and the
event Feed:

```
┌────────────────────────────┐
│  Process Logs       Refresh│
│  ...                       │
├────────────────────────────┤
│  Cognition            ▾    │
│                            │
│  local   qwen3.5:4b  ●    │
│  cloud   haiku        ●    │
│  steward opus              │
│                            │
│  T3: ████░░░░░ 14k/50k    │
│  T2: ██████░░░ 83k/200k   │
│  T1: █░░░░░░░░ 42k/500k   │
│                            │
│  last steward wake: 4m ago │
│  tier-1 calls today: 34   │
├────────────────────────────┤
│  Feed                      │
│  ...                       │
└────────────────────────────┘
```

This section shows:

- which models are active per tier (with a green dot if Ollama is responding)
- simple bar charts for budget consumption by tier
- recency of steward activation
- tier-1 call volume

Collapsed by default. The user opens it when tuning routing or investigating
token spend. It's a diagnostic view, not a primary interaction surface.

### 9.4 Design Constraints

**No new pages or modals.** Everything fits within the existing three-panel
layout (topbar, console, feed).

**No required interaction.** The user never has to look at any of this for
the hive to work. The topbar chip is passive. The turn chips are additive
metadata. The feed section is collapsed.

**Progressive disclosure.** Topbar chip → dropdown breakdown → turn-level
detail → feed panel diagnostics. Each level adds detail for users who want
it. Most users will only ever notice the topbar chip.

**Consistent with existing patterns.** The topbar chip follows the agents
dropdown pattern. The turn chips follow the existing detail chip pattern.
The feed section follows the process logs / feed section pattern. No new
UI components, just new data in existing containers.

---

## 10. Implementation Plan

### Step 1: Add pi-ai and pi-agent-core Dependencies

Add `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` to the project.
Verify basic operation:

```typescript
import { getModel, complete } from "@mariozechner/pi-ai";

// Test cloud
const haiku = getModel("anthropic", "claude-haiku-4-5-20251001");
const response = await complete(haiku, {
  messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
});

// Test local (if Ollama running)
const local = getModel("ollama", "qwen3.5:4b");
const localResponse = await complete(local, {
  messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
});
```

This also validates Ollama connectivity. If Ollama isn't available, tier-1
falls back to Haiku — test that path too.

### Step 2: Tier-1 Task Runner

Add a lightweight function that routes a tier-1 task (prompt + context) to
either a local model or Haiku based on availability. Uses `complete()` from
pi-ai directly — no Agent needed for stateless tasks.

```typescript
import { getModel, complete } from "@mariozechner/pi-ai";

async function runTier1Task(task: {
  prompt: string;
  context: string;
  preferLocal: boolean;
}): Promise<{ result: string; model: string; tokens: number }> {
  const model = task.preferLocal && localModels.length > 0
    ? getModel("ollama", config.tier1_local)
    : getModel("anthropic", "claude-haiku-4-5-20251001");

  const response = await complete(model, {
    systemPrompt: task.prompt,
    messages: [{ role: "user", content: task.context, timestamp: Date.now() }],
  });

  const text = response.content.find(b => b.type === "text")?.text ?? "";
  const tokens = (response.usage?.input ?? 0) + (response.usage?.output ?? 0);

  return { result: text, model: model.name, tokens };
}
```

This is not a daemon — it's a function the gateway and supervisor can call.

### Step 3: Worker Output Compression

After a worker run completes, pass its output through the tier-1 task runner
to produce a compact digest. Store the digest alongside the full output in
the run record. Feed the digest (not the full output) to the steward.

### Step 4: Usage Tracking

Unify token tracking from two sources:

- `RuntimeMetadata` from worker process runs (existing)
- `message.usage` from pi-ai calls (steward + tier-1)

Aggregate into `usage.json`. Add a `GET /api/cognition` gateway endpoint
that returns per-tier token counts, model availability, and budget status.

### Step 5: Console UI

Add the three UI layers:

1. Topbar budget chip — wire to `/api/cognition` endpoint, update on
   `run-completed` and `supervisor-tick` WebSocket events.
2. Turn model chips — extend the existing detail chip rendering in `app.js`
   to include model name and token count from the response metadata.
   The steward's `agent.subscribe()` events include model info; pass it
   through the WebSocket `console-response` payload.
3. Feed cognition section — collapsible panel reading from `/api/cognition`,
   showing tier bars and model status. Collapsed by default.

These are purely additive to the existing `index.html`, `style.css`, and
`app.js`. No new files.

### Step 6: Routing Policy

Add configuration for routing preferences:

```
# in project config or ~/.hive/config.md
tier1_local: qwen3.5:4b
tier1_cloud: haiku
tier2_default: sonnet
tier3_default: opus
```

The activation gate uses these preferences when deciding which tier handles
a task.

---

## 11. What This Does Not Do

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

## 12. Where Pain Might Live (Future Work)

These are things we're deliberately not building now but should watch for:

**Tier-1 quality variance.** Even good 4B models produce inconsistent output
on edge cases. If worker output compression proves unreliable, we may need
validation (run two models, compare) or a quality threshold that falls back
to Haiku. Watch for cases where the steward asks for full output because
the summary was inadequate.

**Context window pressure on local models.** Qwen 3.5 4B and Gemma 3 4B
support 32K+ context, which is generous for most tier-1 tasks. But very long
worker outputs may still need chunked summarization. Llama 3.2 3B's 128K
window is an option if this becomes a pattern.

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

**Model freshness.** Local models improve fast. Qwen 3.5 is the best 4B
today; something better will exist in six months. The tier-based config makes
swapping easy (change one line), but watch for cases where model-specific
prompt tuning creates lock-in. Keep tier-1 prompts generic.

---

## 13. Success Criteria

1. Routine summarization and classification run on local models or Haiku,
   not the steward's model.
2. The steward receives compact digests instead of raw worker output.
3. Token spend on tier-3 drops meaningfully without degrading steward quality.
4. `hive status` (or equivalent) shows usage by tier.
5. Adding a new local model is a one-line config change.
6. The system works fine with no local models — Haiku fills tier-1 seamlessly.
7. The user can see what's being routed where and override it.
8. The topbar chip shows tier-3 budget at a glance without requiring interaction.
9. Each console turn shows which model produced it.
