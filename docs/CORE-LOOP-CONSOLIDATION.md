# Core Loop Consolidation

Status: **Active** — this is the current design direction.

## Goal

Make the core loop — human speaks → steward responds → workers execute →
steward synthesizes → human sees results — fast, event-driven, and tight.

The system should feel like talking to someone who's already in the room,
not someone you have to brief from scratch every time.

## The Core Loop

```
Human speaks
  → Steward responds immediately (warm context)
  → If work needed: writes assignment message
  → Watcher fires (~200ms) → dispatch → worker launches
  → Worker completes → run watcher fires (~200ms) → steward gets delta
  → Steward synthesizes → responds to human / assigns next task
  → Loop continues
```

Total coordination latency per hop: ~400ms instead of ~30-60s.

## Design Decisions

### 1. Event-Driven Coordination

The supervisor poll loop (30s) is replaced by file system watchers as the
primary coordination mechanism.

**Assignment watcher** (already exists):
- Steward writes `msg/assign-*.md`
- Watcher detects → triggers `dispatchWorkerLaunchPass()` within 200ms
- Worker launches immediately

**Run-completion watcher** (new):
- Worker finishes → run status changes in `runs/`
- Watcher detects → triggers steward delta injection
- Steward wakes with: "Worker X completed task Y. Result: Z."
- Steward responds to human or assigns next work

**Supervisor poll becomes safety net**:
- Interval moves from 30s to 120s
- Handles: zombie reconciliation, health checks, idle tasks
- Not the primary coordination path

### 2. Watcher as Core Infrastructure

The watcher pattern moves from `gateway/watcher.ts` to `lib/watcher.ts`.
It becomes reusable infrastructure — the gateway, supervisor, and any
future consumer can create watchers.

```typescript
interface HiveWatcher {
  onAssignment(handler: (msg: HiveMessage) => void): void;
  onRunComplete(handler: (result: RunResult) => void): void;
  onBoardChange(handler: () => void): void;
  onFeedEntry(handler: () => void): void;
  stop(): void;
}
```

The gateway watcher adds WebSocket broadcasting on top.
The supervisor watcher adds dispatch triggering.

### 3. Single Steward Path

One steward, one path: the persistent Pi-agent session.

**Removed**:
- `buildOrchestratorPrompt()` (cold-start one-shot)
- Direct steward mode in `workflow.ts`
- Separate context assembly paths for chat/ask/orchestrate

**Kept**:
- Persistent session via Pi-agent SDK
- Bootstrap context (full, once per session)
- Delta context (cheap, per turn)

**Context assembly**:
```typescript
// Full context for session start
buildBootstrapContext(project: string): string

// Minimal delta for subsequent turns
buildDeltaContext(session: SessionMeta, changes: DeltaChange[]): string
```

`DeltaChange` is a discriminated union:
- `{ type: "human-message", content: string }`
- `{ type: "run-completed", runId: string, agentId: string, summary: string }`
- `{ type: "message-resolved", messageId: string, answer: string }`
- `{ type: "board-changed" }`

### 4. Command Consolidation

**Two ways to talk to HIVE:**
- `hive say <message>` — one-shot steward turn
- `hive console` — interactive streaming session

**Removed as separate commands**: `chat`, `ask`, `orchestrate`.
The steward decides depth (direct answer vs. delegation vs. fan-out).
That's intelligence, not a CLI flag.

**Operational commands stay**: `launch`, `supervise`, `status`, `ps`,
`stop`, `msg`, `prompt`, `memory`, `feed`, `events`, `inbox`, `log`,
`approval`, `runtimes`, `cognition`, `gateway`, `init`, `project`,
`work`, `archive`, `sync`, `help`, `run`, `nudge`, `watch`.

### 5. Cognition Simplification

The `cognition/` directory (packets, workbench, materialize, working-set,
idle) is replaced by:

- `lib/context.ts` — `buildBootstrapContext()` + `buildDeltaContext()`
- `lib/worker-brief.ts` — moved from `cognition/worker-brief.ts`, builds
  worker prompts from assignment + persona + scope

**Removed**: `packets.ts`, `materialize.ts`, `working-set.ts`,
`workbench.ts`, `default-workbench.ts`, `idle.ts`, `index.ts`.

The packet/fingerprint/caching system was solving a context-window
optimization problem the system hasn't earned yet. If context assembly
becomes a bottleneck after the core loop is fast, add caching then.

### 6. Supervisor Controller

The managed supervisor controller moves from `gateway/server.ts` to
`lib/supervisor-controller.ts`. The gateway uses it but doesn't own it.

This makes the supervisor lifecycle (start, stop, health check, restart)
available to any consumer — CLI commands, tests, or future tooling.

## What Doesn't Change

- File substrate (`~/.hive/`, paths, config, frontmatter)
- Runtime adapters (claude, codex, gemini)
- Message format and lifecycle
- Run lifecycle (draft → active → finalized)
- Persona templates (steward, architect, craftsman, critic, scout)
- Dispatch lease system (safe parallel launches)
- Session tracking
- Memory system
- Gateway UI (updated separately)

## File Changes

### New
- `src/lib/watcher.ts` — core file-system event loop
- `src/lib/context.ts` — bootstrap + delta context builder
- `src/lib/supervisor-controller.ts` — supervisor lifecycle management

### Moved
- `src/lib/cognition/worker-brief.ts` → `src/lib/worker-brief.ts`

### Removed
- `src/commands/chat.ts`
- `src/commands/ask.ts`
- `src/commands/orchestrate.ts`
- `src/lib/cognition/packets.ts`
- `src/lib/cognition/materialize.ts`
- `src/lib/cognition/working-set.ts`
- `src/lib/cognition/workbench.ts`
- `src/lib/cognition/default-workbench.ts`
- `src/lib/cognition/idle.ts`
- `src/lib/cognition/index.ts`
- `docs/HIVE-LEADERSHIP-UI.md` (deleted)

### Moved to docs/future/
- `docs/HIVE-AUTONOMOUS-PIPELINES.md`
- `docs/HIVE-EVENTS-AND-HOOKS.md`
- `docs/HIVE-WORKING-SET-COMPILER.md`
- `docs/HIVE-TRUST-LADDER.md`

### Modified
- `src/cli.ts` — remove chat/ask/orchestrate cases
- `src/commands/say.ts` — absorbs steward one-shot logic
- `src/commands/supervise.ts` — watcher-driven, poll as safety net
- `src/gateway/server.ts` — uses lib/watcher.ts, lib/supervisor-controller.ts
- `src/gateway/watcher.ts` — thin wrapper over lib/watcher.ts adding WS broadcast
- `src/lib/steward/workflow.ts` — remove direct steward path
- `src/lib/steward/prompts.ts` — remove buildOrchestratorPrompt, simplify
- `src/lib/steward/turn.ts` — accept delta injections from watcher
- All files that imported from cognition/ — update imports

## Speed Budget

| Hop | Target | Current |
|-----|--------|---------|
| Human → steward response | <2s | <2s (already ok) |
| Steward assigns → worker starts | <500ms | <500ms (watcher path) |
| Worker completes → steward knows | <500ms | 0-30s (poll) |
| Steward synthesizes → human sees | <2s | <2s (already ok) |
| Full round-trip (assign+execute+synthesize) | worker time + ~3s overhead | worker time + 30-60s overhead |

## Future Work (Not This Phase)

- Cognitive tier optimization (tier-0/1 preprocessing)
- Packet caching for context assembly (if context becomes bottleneck)
- External event integration (webhooks, CI, Sentry)
- Autonomous pipelines (trigger → triage → work → verify)
- Trust ladder / approval gating
- Gateway UI updates for consolidated commands
