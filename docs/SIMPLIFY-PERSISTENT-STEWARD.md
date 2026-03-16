# Persistent Steward: Reimagination

Design document. March 2026.

Builds on PERSISTENT-STEWARD-RUNTIME.md and PERSISTENT-STEWARD-DESIGN.md.

---

## Current State

The persistent steward works. It runs as a Pi subprocess spawned by the
gateway, communicates via JSON-over-stdout RPC, manages session files,
handles streaming events, idle timeouts, retry logic, and crash recovery.

It is also the most fragile piece of critical infrastructure in HIVE.

`persistent-steward.ts` is 1,391 lines. The core complexity is not in the
steward's *thinking* — it's in managing a child process:

- `handlePiLine`: 140-line switch statement parsing JSON events from stdout
- `wirePersistentStewardStreams`: manual stdout buffering and line splitting
- `sendPiCommand` / `waitForPersistentTurnCompletion`: custom RPC with
  timeout management and command correlation via IDs
- `acquirePersistentStewardHandle`: process lifecycle, spawn, retry on
  permission errors, global handle maps
- `disposePersistentStewardHandle`: cleanup, pending command rejection
- `scheduleIdleShutdown` / `clearIdleTimer`: idle timeout scheduling

~600 lines of this file are child process management. The actual steward
intelligence — context loading, prompt building, delta handling — is
~400 lines (and much of that is duplicated from `steward.ts`).

### What's Fragile

1. **String protocol parsing.** The Pi RPC protocol is JSON-over-stdout
   with manual line buffering. If Pi changes its event format, HIVE breaks
   silently. There are no schema checks — just `as` casts on parsed JSON.

2. **Global mutable state.** `persistentStewardHandles` is a module-level
   Map of live process handles keyed by project+session. Multiple code paths
   read and mutate these handles concurrently.

3. **Recovery is manual.** If the Pi process crashes, the handle is cleaned
   up and the next request falls back to one-shot. But there's no automatic
   re-bootstrap — the steward loses its conversation context.

4. **Tight coupling to Pi's CLI.** The spawn args (`--mode rpc`,
   `--session`, `--system-prompt`, `--tools`, `--no-extensions`, etc.) and
   the event types (`agent_start`, `agent_end`, `turn_end`,
   `message_update`, `auto_retry_start`) are hardcoded to Pi's current
   interface. This is an implicit contract with no version negotiation.

5. **The steward is not disposable.** HIVE's core principle is that agents
   are disposable. But the persistent steward is the one agent that
   accumulates session state in a subprocess and can't be trivially
   restarted. This contradicts the architecture.

---

## The Core Insight

The PERSISTENT-STEWARD-DESIGN.md identifies the right architecture:

> Pi is the session engine for the persistent steward.
> The boundary is sharp: Pi owns one live steward session.
> HIVE owns everything else.

But the current implementation inverts this. HIVE owns the process
lifecycle, the stream parsing, the RPC protocol, the error recovery. Pi is
treated as a dumb subprocess, not a session engine. HIVE does Pi's job
badly instead of letting Pi do it well.

The design doc also shows the right integration pattern:

```typescript
const agent = new Agent({
  initialState: { systemPrompt, model, tools, messages },
  transformContext: async (messages, signal) => { ... },
});
agent.subscribe((event) => { ... });
await agent.prompt(message);
```

This is in-process. No subprocess. No stdout parsing. No RPC. The Agent
class from `@mariozechner/pi-agent-core` is a library, not a CLI.

---

## Proposed Architecture

### Use Pi as a Library, Not a Subprocess

Replace the child process spawn with direct in-process usage of
`@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

This eliminates:
- All stdout/stderr buffering and line parsing
- The entire RPC command/response correlation system
- Process lifecycle management (spawn, exit handlers, idle timers)
- The global `persistentStewardHandles` map
- Retry-on-permission-error logic for process spawning
- ~600 lines of process management code

What remains:
- A `StewardSession` object that wraps a Pi `Agent` instance
- Context loading via shared `steward-context.ts`
- Gateway integration via `agent.subscribe()` → WebSocket broadcast
- Clean model swapping, steering, and follow-up via the Agent API

### The New `persistent-steward.ts`

After this change plus the steward-context unification, the file should be
~300-400 lines:

```typescript
import { Agent, AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { loadStewardContext, renderStewardIdentityBlock } from "./steward-context";

type StewardSession = {
  agent: Agent;
  projectId: string;
  sessionId: string;
  revision: number;
  createdAt: number;
};

// One live session per project
const sessions = new Map<string, StewardSession>();

export async function ensureStewardSession(
  paths: HivePaths,
  projectId: string,
  sessionId: string,
): Promise<StewardSession> {
  const existing = sessions.get(projectId);
  if (existing?.sessionId === sessionId) return existing;

  const ctx = await loadStewardContext(paths, projectId, sessionId);
  const model = resolveModel(ctx);

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(ctx),
      model,
      tools: buildStewardTools(paths, projectId),
      messages: ctx.recentTurns.length
        ? reconstructConversation(ctx.recentTurns)
        : [],
    },
    transformContext: async (messages) => {
      // Inject latest delta, prune old context
      const delta = await loadStewardRefreshDelta(paths, projectId, ctx.revision);
      return applyContextContract(messages, delta);
    },
  });

  const session: StewardSession = {
    agent,
    projectId,
    sessionId,
    revision: ctx.revision,
    createdAt: Date.now(),
  };

  sessions.set(projectId, session);
  return session;
}

export async function runPersistentStewardTurn(
  session: StewardSession,
  humanMessage: string,
  onEvent?: (event: AgentEvent) => void,
): Promise<StewardTurnResult> {
  if (onEvent) {
    session.agent.subscribe(onEvent);
  }

  await session.agent.prompt(humanMessage);

  const lastMessage = session.agent.state.messages.at(-1);
  // ... extract text, usage, record turn
}

export function disposeStewardSession(projectId: string): void {
  const session = sessions.get(projectId);
  if (session) {
    session.agent.abort();
    sessions.delete(projectId);
  }
}
```

### Steward Tools

The steward's tools become Pi `AgentTool` objects registered at session
creation. These replace the runtime CLI's built-in tools with HIVE-aware
equivalents:

```typescript
function buildStewardTools(paths: HivePaths, projectId: string): AgentTool[] {
  return [
    {
      name: "read_board",
      description: "Read current BOARD.md",
      parameters: Type.Object({}),
      execute: async () => ({
        result: await Bun.file(getProjectPaths(paths, projectId).board).text(),
      }),
    },
    {
      name: "assign_worker",
      description: "Create a worker assignment",
      parameters: Type.Object({
        agent: Type.String(),
        task: Type.String(),
        scope: Type.Optional(Type.String()),
      }),
      execute: async ({ agent, task, scope }) => {
        await createMessage({ from: "steward", to: agent, type: "assignment", body: task, scope });
        return { result: `Assigned to ${agent}` };
      },
    },
    {
      name: "read_file",
      description: "Read a hive or project file",
      parameters: Type.Object({ path: Type.String() }),
      execute: async ({ path }) => ({
        result: await Bun.file(path).text(),
      }),
    },
    {
      name: "update_board",
      description: "Write updated BOARD.md content",
      parameters: Type.Object({ content: Type.String() }),
      execute: async ({ content }) => {
        await Bun.write(getProjectPaths(paths, projectId).board, content);
        return { result: "Board updated" };
      },
    },
  ];
}
```

### Context Contract via `transformContext`

This is where the bootstrap/refresh distinction lives:

```typescript
transformContext: async (messages) => {
  // Keep system prompt and recent conversation window
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES);

  // Check for state changes since last turn
  const delta = await loadStewardRefreshDelta(paths, projectId, session.revision);

  if (delta.changes.length > 0) {
    // Inject compact delta as a system-like message
    recent.push({
      role: "user",
      content: `[HIVE state update — revision ${delta.revision}]\n${formatDelta(delta)}`,
      timestamp: Date.now(),
    });
    session.revision = delta.revision;
  }

  return recent;
}
```

The first turn gets the full bootstrap context (via systemPrompt + initial
messages). Subsequent turns get only deltas via `transformContext`. This
matches the design doc's context contract exactly.

### Gateway Integration

The gateway wiring becomes straightforward:

```typescript
// In /api/console/send handler
async function handleConsoleSend(message: string, sessionId: string, projectId: string) {
  try {
    const session = await ensureStewardSession(paths, projectId, sessionId);

    await runPersistentStewardTurn(session, message, (event) => {
      // Stream events to WebSocket clients
      if (event.type === "text_delta") {
        broadcast({ type: "console-response", data: { delta: event.text } });
      }
      if (event.type === "tool_execution_start") {
        broadcast({ type: "steward-tool", data: { tool: event.toolName } });
      }
    });
  } catch (err) {
    // Session died — dispose and fall back to one-shot
    disposeStewardSession(projectId);
    return runDirectStewardTurn(message);
  }
}

// Human interrupts mid-turn
async function handleSteeringMessage(message: string, projectId: string) {
  const session = sessions.get(projectId);
  if (session) {
    session.agent.steer({ role: "user", content: message, timestamp: Date.now() });
  }
}
```

No process management. No stdout parsing. No RPC timeouts.

### Crash Recovery

When the steward session fails (provider error, OOM, bug):

1. `disposeStewardSession` cleans up the Agent instance
2. Next request calls `ensureStewardSession` which re-bootstraps
3. Bootstrap loads conversation tail from session history files
4. The steward picks up where it left off

This is genuinely disposable. The steward can die and restart without
losing durable state because all durable state is in files — exactly
matching HIVE's core principle.

---

## What Changes

| Aspect                    | Current (subprocess)        | Proposed (in-process)        |
|--------------------------|---------------------------- |------------------------------|
| Pi integration           | Child process + RPC         | Library import               |
| Streaming                | stdout line parsing         | `agent.subscribe()`          |
| Session lifecycle        | Global handle map           | Simple Map of Agent objects  |
| Crash recovery           | Manual, lossy               | Automatic re-bootstrap       |
| Process management       | 600 lines                   | 0 lines                     |
| Idle timeout             | Timer-based process kill    | Agent garbage collection     |
| Auth/model routing       | CLI args to subprocess      | `getModel()` API call        |
| Steering/interrupts      | RPC command                 | `agent.steer()` method       |
| Tool execution           | Pi's built-in tools         | HIVE-registered AgentTools   |
| Total file size          | ~1,400 lines                | ~300-400 lines               |

---

## Dependencies

### Required First

1. **Steward context unification** (SIMPLIFY-STEWARD-UNIFICATION.md) —
   shared context loading must exist before both steward modes can consume
   it cleanly.

2. **Pi library availability** — confirm `@mariozechner/pi-agent-core` and
   `@mariozechner/pi-ai` can be used as direct imports in a Bun project
   without the CLI wrapper.

### Nice to Have First

3. **State decomposition** (SIMPLIFY-STATE-DECOMPOSITION.md) — cleaner
   delta loading makes the `transformContext` callback simpler.

---

## Migration Path

### Phase 1: Verify Pi Library Integration

Add `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` as
dependencies. Write a minimal test: create an Agent, send a prompt, receive
a response. Confirm it works in Bun without the CLI.

This is the key risk gate. If the libraries don't work as in-process
imports (e.g., they assume CLI context, or have incompatible dependencies),
this approach needs adjustment.

### Phase 2: Build New Persistent Steward

Write the new `persistent-steward.ts` alongside the existing one (e.g., as
`persistent-steward-v2.ts`). Use the shared `steward-context.ts` for
context loading. Wire up gateway integration behind a feature flag
(`HIVE_STEWARD_V2=1`).

### Phase 3: Gateway Cutover

Switch the gateway from subprocess-based to in-process steward. Keep the
old code available as fallback behind the inverse flag.

### Phase 4: Remove Old Implementation

Once the new implementation is stable, delete the subprocess-based code
and the global handle maps.

---

## What This Does NOT Change

- The one-shot `steward.ts` path remains as fallback and for CLI usage
- Worker execution remains via runtime adapters (no Pi dependency)
- The file substrate, supervisor, and state monitor are unchanged
- The gateway's other responsibilities (supervisor, WebSocket, static
  assets) are unaffected

---

## Risk: Zero-Dependency Constraint

HIVE currently has zero npm dependencies. Adding Pi as a library dependency
breaks that constraint.

Options:

1. **Accept the dependency.** Pi is a known, controlled dependency
   (authored by a collaborator). It provides genuine value that would be
   expensive to reimplement. The zero-dep constraint was about avoiding
   dependency hell, not about purity.

2. **Vendor Pi.** Copy the relevant modules into HIVE's tree. Maintains
   zero external deps but creates a maintenance burden.

3. **Keep subprocess but clean it up.** If the zero-dep constraint is
   sacred, the alternative is to heavily refactor the existing subprocess
   approach — extract the RPC protocol into a clean module, add schema
   validation, reduce the handle management complexity. This is less
   transformative but preserves the constraint.

Recommendation: option 1. The zero-dep principle served its purpose during
bootstrap. Pi is a strategic dependency, not an incidental one.

---

## Success Criteria

1. The persistent steward runs in-process, not as a subprocess.
2. No stdout/stderr parsing anywhere in the steward path.
3. `persistent-steward.ts` is under 400 lines.
4. Steward crash → automatic re-bootstrap from files on next request.
5. Human-perceived latency for first response is faster (no process spawn).
6. All existing gateway console functionality works unchanged.
7. The steward is genuinely disposable — kill it, restart it, no state loss.
