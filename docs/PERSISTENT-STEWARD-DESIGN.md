# HIVE Persistent Steward Design

Design document. March 2026.

---

## 1. Purpose

HIVE already has the right core abstraction:

- files are the API
- markdown is the durable human-readable source of truth
- workers are disposable
- the hive is multi-perspective, not mono-agent
- coordination intelligence lives in prompts and conventions

What HIVE lacks today is a first-class living head.

The current hot path is:

1. human sends a message via the gateway
2. gateway calls `runDirectStewardTurn()`
3. the steward prompt is rebuilt from disk — every time
4. a fresh runtime process launches, reasons, exits
5. the human eventually sees the result

This creates three failures:

1. Human latency is tied to a full cold-start steward pass.
2. The head of the hive is not persistent, so every turn rehydrates context.
3. The gateway session is not a true conversation with the head agent.

The goal of this design is to make HIVE feel like a continuously alive steward
the user can talk to at any time, without destroying the multi-agent
architecture that makes HIVE what it is.

---

## 2. Design Principles

1. **Persistent agenthood.** The human should experience HIVE as one coherent
   interlocutor that knows what's going on and remembers the conversation.

2. **Token efficiency.** Persistent does not mean constantly inferencing.
   Expensive reasoning should happen only when warranted.

3. **Multi-model operation.** Route work across frontier models, small models,
   and deterministic processes. Not everything needs the best model.

4. **File-native continuity.** Durable truth stays in SOUL.md, IDENTITY.md,
   SELF.md, PLAN.md, BOARD.md, LOG.md, memory, and messages.

5. **Hive integrity.** The steward is the head of a hive, not a replacement
   for the hive's multiple minds.

6. **No new daemons.** The gateway is already the long-lived process. Build on
   it rather than adding separate background services.

---

## 3. Architecture Layers

### Layer A: Durable Hive Substrate

The existing file system of record. Unchanged.

- SOUL.md, IDENTITY.md, SELF.md, AGENTS.md
- PLAN.md, BOARD.md, LOG.md
- project memory, message files, project config
- run records, feed, sessions

This remains the durable truth. Nothing in this design changes it.

### Layer B: Deterministic Runtime Fabric

Cheap, non-LLM processes that already exist or are straightforward to add.

- State monitor: parses file state, tracks revisions, computes compact
  summaries, emits delta packets for the steward
- Supervisor: launches and stops worker runs, enforces scope and parallel
  rules, maintains the run ledger, recovers stale runs
- Derived state: machine-readable JSON under a project state directory,
  disposable and rebuildable from markdown

The state monitor already has a partial implementation in
`refreshProjectRuntimeState()`. The supervisor already runs as a detached
process managed by the gateway. This layer extends what exists.

### Layer C: Persistent Steward

A long-lived session that embodies the steward. Lives inside the gateway
process.

Responsibilities:

- converse with the human directly
- maintain hot working context across turns
- decide what matters and what to ignore
- wake workers through assignment messages
- synthesize worker outcomes into coherent updates
- commit durable changes back to files

The steward is one identity with two operating modes:

**Control mode** — orchestration. Inspect deltas, assign work, track blockers,
manage priority, decide when a human decision is needed.

**Synthesis mode** — editorial integration. Compress worker results, reconcile
disagreement, produce clear updates, propose next steps, maintain continuity
for the user.

These are modes, not separate agents. The human experiences one voice.

### Layer D: Transient Execution Fleet

A mixed pool of workers, unchanged from today:

- Frontier-model workers (architect, craftsman, critic, scout)
- Any runtime adapter (Claude, Codex, Gemini, etc.)
- Launched by the supervisor on steward request
- Scoped, disposable, report outcomes through files

---

## 4. Where Pi Fits

Pi is the session engine for the persistent steward.

### 4.1 The Packages

Two Pi packages matter for HIVE:

**`@mariozechner/pi-ai`** — unified multi-provider LLM API. Provides
`getModel()`, `stream()`, `complete()`, and a serializable `Context` object.
Handles token/cost tracking, tool schemas (TypeBox), and works across 20+
providers including Ollama for local models. This is what HIVE uses for all
model calls — steward, tier-1, and potentially workers.

**`@mariozechner/pi-agent-core`** — agent runtime with tool calling and state
management. Provides the `Agent` class: persistent message history, streaming
events, tool execution, context transformation, steering/follow-up queues,
and abort control. This is what HIVE uses for the persistent steward session.

### 4.2 What Pi Provides

**Session continuity.** The `Agent` class maintains message history across
turns. No prompt rebuild. The steward's context grows incrementally with each
human message and delta packet, exactly matching our context contract.

**Context transformation.** `transformContext()` runs before every LLM call.
This is where HIVE injects delta packets, prunes stale context, and enforces
the bootstrap/refresh contract. The agent's full message history stays in
memory, but the LLM only sees what the transform passes through.

**Streaming.** `agent.subscribe()` emits granular events (`text_delta`,
`tool_execution_start`, `tool_execution_end`, etc.) that map directly to
WebSocket broadcasts in the gateway console. The human sees the steward
thinking in real time.

**Tool calling.** The steward's tools (read board, assign worker, check
status, read file, update plan) are registered as `AgentTool` objects with
TypeBox schemas. Pi handles argument validation, parallel/sequential
execution, and result injection.

**Steering.** If the human sends a message while the steward is mid-tool-call,
`agent.steer()` interrupts cleanly — remaining tools get skipped, the
steering message injects, and the steward responds to the interruption. This
is critical for the conversational feel.

**Model swapping.** `agent.setModel()` can change the underlying model
mid-session. If budget pressure requires downgrading the steward temporarily,
or if a specific turn benefits from a different model, this is a single call.

**Provider routing.** `getModel()` works across Anthropic, OpenAI, Google,
Ollama, and 15+ other providers. HIVE's tier-1 calls use the same API
regardless of whether they hit a local Qwen model or cloud Haiku.

### 4.3 What Pi Does Not Become

- the durable memory system (HIVE files)
- the project state system (HIVE substrate)
- the worker coordination substrate (HIVE supervisor)
- the universal runtime for all agents (workers use whatever runtime fits)

**The boundary is sharp: Pi owns one live steward session. HIVE owns
everything else.**

This preserves HIVE's runtime-agnostic stance. Workers still launch via any
adapter. Only the steward uses Pi, because only the steward needs persistent
sessions and fast interactive response.

### 4.4 Runtime Access Policy

The important distinction is that **Pi is the session engine, not the
authority on account policy**.

HIVE should explicitly describe two separate lanes in `~/.hive/config.md`:

- the direct runtime lane for one-shot worker and fallback launches
- the Pi route for the persistent steward

That policy needs to answer:

- which direct CLI runtime is the default (`claude`, `codex`, `gemini`)
- what auth lane that runtime is expected to use (`subscription`, `cli`,
  `api`, `unknown`)
- which Pi provider/model should back a given session runtime
- what auth policy Pi should enforce for that provider

For example:

```md
direct-auth-claude: subscription
direct-auth-codex: cli
direct-auth-gemini: cli

pi-provider-claude: anthropic
pi-model-claude: claude-sonnet-4-6
pi-auth-anthropic: oauth-only

pi-provider-codex: openai
pi-model-codex: gpt-5
pi-auth-openai: env

pi-provider-gemini: google
pi-model-gemini: gemini-2.5-pro
pi-auth-google: env
```

This keeps the design honest:

- the direct `claude` lane can remain subscription-backed through Claude Code
- the persistent steward can still be Pi-first
- Pi's Anthropic lane can be forced onto OAuth/subscription instead of silently
  consuming API credits
- Codex and Gemini can remain on their direct CLI-backed lanes by default, and
  only become Pi provider routes when explicitly configured

Environment variables such as `HIVE_PI_PROVIDER` and `HIVE_PI_MODEL` remain
valid as explicit overrides, but the file-backed policy should be the default
source of truth because it is inspectable and versionable.

### 4.5 Concrete Mapping

```
HIVE Concept                  Pi Implementation
─────────────────────────────────────────────────────
Persistent steward session    Agent instance in gateway
Bootstrap context             initialState.systemPrompt + messages
Delta packets                 Custom AgentMessage via declaration merging
Context contract              transformContext() callback
Steward tools                 AgentTool[] with TypeBox schemas
Live console streaming        agent.subscribe() → WebSocket broadcast
Human interrupts steward      agent.steer()
Human follow-up               agent.followUp()
Steward crash recovery        Re-create Agent from derived state + history
Tier-1 task calls             complete() / stream() from pi-ai directly
Model tiering                 getModel('anthropic', 'haiku') vs
                              getModel('ollama', 'qwen3.5:4b') vs
                              getModel('anthropic', 'opus')
Token/cost tracking           message.usage.{input,output,cost}
```

### 4.6 The Steward Agent Skeleton

```typescript
import { Agent, AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, Type } from "@mariozechner/pi-ai";

// Extend AgentMessage for HIVE-specific message types
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    hiveDelta: {
      role: "hiveDelta";
      delta: HiveDeltaPacket;
      timestamp: number;
    };
  }
}

// --- Tools the steward can call ---

const readBoardTool: AgentTool<typeof readBoardSchema> = {
  name: "read_board",
  description: "Read the current BOARD.md state",
  parameters: Type.Object({}),
  execute: async () => {
    const board = await readFile(paths.board());
    return { result: board };
  },
};

const assignWorkerTool: AgentTool<typeof assignWorkerSchema> = {
  name: "assign_worker",
  description: "Create an assignment message for a worker agent",
  parameters: Type.Object({
    agent: Type.String({ description: "Target agent (architect, craftsman, critic, scout)" }),
    task: Type.String({ description: "The assignment body" }),
    priority: Type.Optional(Type.String({ description: "high, normal, low" })),
  }),
  execute: async ({ agent, task, priority }) => {
    await createAssignmentMessage(agent, task, priority);
    return { result: `Assignment created for ${agent}` };
  },
};

const readFileTool: AgentTool<typeof readFileSchema> = {
  name: "read_file",
  description: "Read a specific hive file when deeper context is needed",
  parameters: Type.Object({
    path: Type.String({ description: "Path relative to ~/.hive/" }),
  }),
  execute: async ({ path }) => {
    const content = await readFile(resolve(paths.hiveHome(), path));
    return { result: content };
  },
};

// --- The steward agent ---

function createStewardAgent(bootstrap: BootstrapContext): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt: buildStewardSystemPrompt(bootstrap),
      model: getModel("anthropic", "claude-opus-4-20250514"),
      tools: [readBoardTool, assignWorkerTool, readFileTool, checkStatusTool, updatePlanTool],
      messages: bootstrap.conversationTail ?? [],
    },

    // The context contract: prune and inject deltas before each LLM call
    transformContext: async (messages, signal) => {
      const delta = await getLatestDelta();
      const llmMessages = messages
        .filter(m => m.role !== "hiveDelta")  // strip raw deltas
        .slice(-MAX_CONTEXT_MESSAGES);        // keep recent window

      // Inject current delta as a system-like user message
      if (delta.hasChanges) {
        llmMessages.push({
          role: "user",
          content: formatDeltaForSteward(delta),
          timestamp: Date.now(),
        });
      }

      return llmMessages;
    },
  });

  return agent;
}
```

### 4.7 Gateway Integration

```typescript
// In gateway startup
let steward: Agent | null = null;

async function ensureSteward(): Promise<Agent> {
  if (steward) return steward;

  const bootstrap = await buildBootstrapContext(activeProject);
  steward = createStewardAgent(bootstrap);

  // Wire streaming to WebSocket
  steward.subscribe((event) => {
    if (event.type === "message_update") {
      broadcast({
        type: "console-response",
        data: {
          delta: event.assistantMessageEvent,
          model: steward!.state.model.name,
        },
      });
    }
    if (event.type === "tool_execution_start") {
      broadcast({
        type: "steward-tool",
        data: { tool: event.toolName, status: "started" },
      });
    }
  });

  return steward;
}

// Replace runDirectStewardTurn in POST /api/console/send
async function handleConsoleSend(message: string) {
  try {
    const agent = await ensureSteward();

    // Record the delta for this turn
    await recordDeltaCheckpoint();

    // Prompt the steward (streams via subscribe above)
    await agent.prompt(message);

    // Extract usage for tracking
    const lastMsg = agent.state.messages.at(-1);
    if (lastMsg?.usage) {
      await recordUsage("tier3", lastMsg.usage);
    }
  } catch (err) {
    // Steward died — fall back to one-shot
    steward = null;
    return runDirectStewardTurn(message);
  }
}

// Human sends while steward is working
async function handleSteeringMessage(message: string) {
  const agent = await ensureSteward();
  agent.steer({
    role: "user",
    content: message,
    timestamp: Date.now(),
  });
}
```

### 4.8 Tier-1 via pi-ai Directly

Tier-1 tasks don't need the full Agent. They use `complete()` from pi-ai:

```typescript
import { getModel, complete } from "@mariozechner/pi-ai";

async function runTier1Task(task: {
  prompt: string;
  context: string;
  preferLocal: boolean;
}): Promise<{ result: string; model: string; tokens: number }> {
  // Pick model based on availability
  const model = task.preferLocal && ollamaAvailable
    ? getModel("ollama", config.tier1_local)     // e.g. qwen3.5:4b
    : getModel("anthropic", "claude-haiku-4-5-20251001");

  const response = await complete(model, {
    systemPrompt: "You are a concise summarization assistant. Respond with JSON only.",
    messages: [
      { role: "user", content: `${task.prompt}\n\n${task.context}`, timestamp: Date.now() },
    ],
  });

  return {
    result: response.content.find(b => b.type === "text")?.text ?? "",
    model: model.name,
    tokens: (response.usage?.input ?? 0) + (response.usage?.output ?? 0),
  };
}

// Example: compress worker output after run completion
async function compressWorkerOutput(runRecord: RunRecord): Promise<string> {
  const { result } = await runTier1Task({
    prompt: `Summarize this worker output as JSON: { "summary": "...", "outcome": "success|partial|blocked|failed", "key_decisions": [...], "files_changed": [...] }`,
    context: runRecord.visibleOutput,
    preferLocal: true,
  });
  return result;
}
```

---

## 5. The Token-Efficient Runtime Model

The key principle: **persistent does not mean constantly inferencing.**

The steward should be continuous but mostly idle. Three layers control cost:

### 5.1 Always-On Cheap State

The state monitor (deterministic, no LLM) runs as part of the gateway's
existing event loop:

- watch for file changes (gateway's watcher already does this)
- track revision hashes on key files
- compute compact board/message/run summaries
- debounce noisy changes
- produce delta packets when meaningful state changes

### 5.2 Activation Gate

Before waking the steward, a deterministic check decides whether the event
is worth a model call.

Wake for:

- direct human message
- high-priority worker completion
- conflict between workers
- blocking error or plan transition
- scheduled checkpoint (configurable)

Do not wake for:

- routine file churn
- worker heartbeats
- low-value telemetry
- every log append

### 5.3 Steward Turn

When activated, the steward receives only:

- the human message (if any)
- a compact delta packet (what changed since last turn)
- relevant worker completion summaries
- unresolved questions or escalation items

The steward should not reread the whole hive. Deep reads happen only when:

- the state monitor marks something as changed and relevant
- the human asks a question requiring inspection
- the steward explicitly requests context expansion

---

## 6. Model Tiering

Not everything needs the frontier model. This should be explicit policy, not
afterthought.

### Tier 0: Deterministic

No model. Use for file watching, revision tracking, process management, git
status, run ledger maintenance, threshold checks, stale-run detection, routing
rules.

This is the default whenever possible.

### Tier 1: Small Model

Use a cheap/fast model for narrow interpretation and compression.

Examples: summarize worker logs, classify a result as success/blocker/ambiguous,
compress telemetry into a one-line digest, judge whether a delta is
steward-worthy, extract decisions from recent activity.

These are not "full minds." They are limited cognition modules. Pi's
role-based model routing (the `smol` role) maps directly to this tier.

### Tier 2: Specialist Workers

Use strong models when actual reasoning is needed. Architect for design
tradeoffs, craftsman for implementation, critic for adversarial review, scout
for option generation.

This is the existing HIVE worker model. Unchanged.

### Tier 3: Persistent Steward

The best available model budget, used when the head of the hive needs to
reason, synthesize, or converse. This is the scarce intelligence budget and
should be protected by the activation gate.

---

## 7. Context Contract

### Bootstrap (steward startup)

On first activation, provide:

- compact SOUL.md
- compact IDENTITY.md and SELF.md
- compact AGENTS.md
- project identity and config
- board summary digest
- active assignments summary
- recent worker results summary
- recent decisions summary
- recent conversation tail
- file paths for deeper reads

This is the only heavy load.

### Refresh (subsequent turns)

After bootstrap, the steward receives only delta packets:

- human messages
- state changes since last turn
- worker completion summaries
- escalation events

### Deep Reads

On explicit request only. The steward asks for a specific file or context
expansion when it decides it needs more.

This contract already exists in embryonic form in `buildStewardTurnPrompt()`,
which assembles digests rather than full files. The persistent steward
formalizes the delta path so the bootstrap only happens once.

---

## 8. Derived State

The existing `refreshProjectRuntimeState()` already computes board summaries,
open message summaries, active runs summaries, and recent results. Formalize
this as a project-local state directory:

```
~/.hive/projects/<project>/state/
  revision.json           # content hashes for key files
  board-summary.json      # compact board digest
  open-messages.json      # pending message summary
  recent-results.json     # recent worker outcomes
  active-runs.json        # what's running now
  steward-delta.json      # changes since steward last looked
```

These are not source of truth. They are fast runtime derivatives, disposable
and rebuildable from markdown at any time.

---

## 9. Implementation in the Gateway

The gateway is already the right home. It's the long-lived process that manages
the supervisor, serves the web console, and handles human conversation. Adding
the persistent steward means changing how the gateway handles
`/api/console/send`, not adding new infrastructure.

### Today

```
POST /api/console/send
  → runDirectStewardTurn()
    → rebuild prompt from disk
    → launch fresh runtime process
    → wait for completion
    → capture output
    → return to human
```

### After

```
POST /api/console/send
  → feed message to persistent steward session
    → steward receives message + latest delta
    → steward responds from hot context
    → steward may dispatch workers via assignment messages
    → return response to human immediately
```

The gateway keeps its existing responsibilities (supervisor management,
WebSocket broadcast, session tracking, static assets). The persistent steward
session is one more long-lived resource alongside the supervisor.

### 9.1 Runtime Resolution in Practice

At turn time, the gateway should resolve the steward session in this order:

1. Determine the HIVE session runtime/model (`claude`, `codex`, `gemini`, etc.)
2. Read `~/.hive/config.md` runtime-access policy
3. Resolve the Pi route for that session runtime
4. Spawn or reuse the live Pi session with that provider/model/auth policy
5. If Pi fails, fall back to `runDirectStewardTurn()` using the direct runtime
   lane

This means the direct runtime and the Pi route are related, but not identical.
A `claude` session may mean:

- direct fallback uses the Claude Code CLI lane
- persistent Pi route uses `anthropic`
- Pi auth policy for Anthropic is `oauth-only`

Likewise:

- a `codex` session should stay on the direct Codex CLI lane unless
  `pi-provider-codex` is explicitly configured
- a `gemini` session should stay on the direct Gemini CLI lane unless
  `pi-provider-gemini` is explicitly configured

The key architectural rule is that **the mapping is explicit**. HIVE should be
able to print the resolved direct auth lane and the resolved Pi route on
demand. If the operator cannot inspect it, the design is too implicit.

### Fallback

If the steward session dies (crash, OOM, provider error), fall back to the
existing `runDirectStewardTurn()` one-shot path. The human sees a slightly
slower response, not a broken system. On next gateway restart, a fresh steward
session bootstraps from derived state + markdown.

This makes the persistent steward a progressive enhancement, not a hard
requirement.

---

## 10. Skills Evolution

Today, HIVE skills are markdown files that shape how agents think
(`state-efficient-ops.md`, `autonomous-ops.md`). These are cognitive skills —
prompt-level guidance.

The natural next step is capability skills: skills that bundle instructions
with callable scripts or tools. A capability skill might include a markdown
file describing the capability plus a script that executes it.

Example: a `workspace-health` skill that includes a shell script to check repo
state and a markdown description of when and how to use it.

The third step is sensor skills: lightweight processes that periodically
observe some aspect of the environment and produce structured output for the
state monitor.

This evolution should be demand-driven. Start with cognitive skills (already
working). Add capability skills when a specific capability needs a script. Add
sensor skills when a specific environmental signal proves valuable enough to
automate.

Do not build a universal skill manifest format, a capability runner daemon, or
a sensor bus until there are enough concrete skills to justify the abstraction.

---

## 11. Rollout

### Phase 1: Derived State and Deltas

Formalize `refreshProjectRuntimeState()` into the state directory. Add
revision tracking and delta generation so the system can answer "what changed
since the steward last looked" cheaply.

This is prerequisite infrastructure. It makes the existing one-shot path
faster too, because `runDirectStewardTurn()` can use deltas instead of full
rebuilds.

### Phase 2: Persistent Steward Session

Replace `runDirectStewardTurn()` in the gateway with a Pi-backed persistent
session. Bootstrap once on gateway start. Feed delta packets and human
messages into the live session. Fall back to one-shot on failure.

### Phase 3: Model Tiering

Add routing policy so the steward can dispatch tier-1 (small model) work for
triage and compression tasks. Use Pi's role-based model selection to route
cheap operations to fast models and expensive operations to frontier models.

### Phase 4: Capability and Sensor Skills

Driven by pain. When a specific script or environmental sensor proves
valuable, package it as a skill. Build whatever minimal infrastructure those
concrete skills require.

---

## 12. What Could Go Wrong

**Pi takes over too much.** Mitigation: the boundary is explicit. Pi owns one
session. If Pi starts accumulating HIVE-level responsibilities (memory, board
management, worker coordination), that's a design violation.

**The steward becomes expensive again.** Mitigation: activation gating, delta
discipline, deep-read restrictions, and model tiering. If the steward is
burning tokens on every file change, the activation gate is too loose.

**Loss of hive pluralism.** Mitigation: keep architect, craftsman, critic, and
scout as genuine independent worker minds for important tasks. The steward
coordinates; it does not replace the team.

**Steward recovery is disorienting.** Mitigation: on crash, the steward
rebuilds from derived state + markdown + conversation history. The human may
notice a brief delay but should not lose context. This needs explicit testing
during phase 2.

**Sensor/skill sprawl.** Mitigation: don't build the abstraction until the
concrete instances justify it. Two scripts don't need a framework.

---

## 13. Success Criteria

The design is working when:

1. `hey` gets a near-immediate response from the live steward.
2. Human follow-up questions do not trigger full prompt rebuilds.
3. The session shows live work updates without forcing the user to read feed.
4. The steward only rereads markdown when relevant state has changed.
5. Worker launches remain deterministic and supervised.
6. Killing the steward does not lose durable project state.
7. The system runs on a laptop without constant token spend.

---

## 14. What This Design Does Not Do

- Replace markdown with a database.
- Require a central daemon beyond the existing gateway.
- Make every loop an LLM loop.
- Require all workers to use Pi.
- Build infrastructure ahead of concrete need.

The steward is the mouth, memory of the moment, and coordinator of the hive.
The hive remains plural. The steward is the singular conversational vessel of
that plurality.
