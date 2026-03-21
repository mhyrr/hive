# State Module Decomposition

Design document. March 2026.

---

## Problem

`state.ts` is 983 lines and does eight jobs:

1. Define all summary types (BoardSummary, OpenMessagesSummary, etc.)
2. Parse task status from markdown lines
3. Summarize board, messages, runs, sessions, inbox
4. Read/write JSON state files
5. Compute content fingerprints for change detection
6. Build delta packets (what changed since last steward look)
7. Maintain delta history (append-only log)
8. Orchestrate the full refresh cycle (`refreshProjectRuntimeState`)

The main function `refreshProjectRuntimeState` is ~180 lines of interleaved
reads, summarization, fingerprinting, delta computation, and writes with no
clear boundaries between concerns. It's hard to test any piece in isolation.

Additionally, key functions are duplicated across files:

- `parseTaskStatus` exists in `state.ts`, `supervisor.ts`, and `digest.ts`
  with subtly different behavior (state.ts checks for "pending", digest.ts
  does not)
- `normalizeInlineText` and `truncate` are duplicated between `state.ts` and
  `persistent-steward.ts`
- `isRealBlocker` is duplicated between `state.ts` and `digest.ts`

This is a bug factory. Different parsing of the same task status format in
different files means the supervisor and the state monitor can disagree about
what's active.

---

## Proposed Decomposition

### New File: `src/lib/text.ts`

Shared text utilities. Single source of truth.

```
normalizeInlineText(value: string): string
truncate(value: string, max?: number): string
firstLine(value: string): string
```

Every file that needs text normalization imports from here.

### New File: `src/lib/board-parse.ts`

Consolidate all board/task parsing into one place. The existing `board.ts`
handles section extraction (tasks, agents, blockers, decisions). This new
file handles task-line parsing:

```
parseTaskStatus(line: string): string | null
parseTaskId(line: string): string | null
isRealBlocker(line: string): boolean
```

These are currently scattered across `state.ts`, `digest.ts`, and
`supervisor.ts`. One implementation, one set of tests, one behavior.

### Existing File: `src/lib/digest.ts` — Unchanged Role

Already exports `digestBoard`, `digestMessages`, `digestRuns`. These produce
human-readable markdown digests for prompts. Keep as-is, but have them
import from `board-parse.ts` instead of defining their own `parseTaskStatus`.

### Refactored: `src/lib/state.ts` — Narrowed to State I/O

After extraction, `state.ts` retains:

1. **Type definitions** — BoardSummary, OpenMessagesSummary, etc.
2. **Summarization functions** — `summarizeBoard`, `summarizeMessages`,
   `summarizeRuns`, `summarizeActiveRuns`, `summarizeInbox`,
   `summarizeSession`. Each is a pure function: raw data in, summary out.
3. **JSON I/O** — `readJson`, `writeJson`, `appendJsonLine`,
   `ensureStateFiles`. File system helpers for the state directory.

Removed from `state.ts`:

- Text utilities → `text.ts`
- Task parsing → `board-parse.ts`
- Fingerprinting → `state-delta.ts`
- Delta computation → `state-delta.ts`
- The refresh orchestrator → `state-refresh.ts`

### New File: `src/lib/state-delta.ts`

Owns change detection and delta computation:

```
hashJson(value: unknown): string
buildBoardChange(prev, next): StewardDeltaChange | null
buildMessageChanges(prev, next): StewardDeltaChange[]
buildResultChanges(prev, next): StewardDeltaChange[]
buildRunChanges(prev, next): StewardDeltaChange[]
buildSessionChanges(prev, next): StewardDeltaChange[]
buildDeltaPacket(prev, next): StewardDeltaPacket
```

All pure functions. Testable without file I/O.

### New File: `src/lib/state-refresh.ts`

The orchestrator. Imports from `state.ts`, `state-delta.ts`, and the raw
data loaders (`runs.ts`, `messages.ts`, `sessions.ts`, `board.ts`).

```
refreshProjectRuntimeState(paths, project, options?): ProjectRefreshResult
readStewardDeltaHistory(paths, project, since?): DeltaHistoryEntry[]
```

This is the only file that does I/O in the state subsystem. It:

1. Reads raw data from disk (board, messages, runs, sessions)
2. Calls summarizers from `state.ts`
3. Calls delta builders from `state-delta.ts`
4. Writes derived state JSON to the state directory
5. Returns the refresh result

---

## File Inventory After Decomposition

| File               | Lines (est.) | Responsibility              |
|--------------------|--------------|-----------------------------|
| `text.ts`          | ~20          | Text normalization          |
| `board-parse.ts`   | ~60          | Task line parsing           |
| `state.ts`         | ~400         | Types + summarizers + JSON  |
| `state-delta.ts`   | ~250         | Change detection            |
| `state-refresh.ts` | ~250         | Refresh orchestration       |
| `digest.ts`        | ~100         | Prompt digest rendering     |

Total: ~1080 lines across 6 files vs. 983 in one file. Slightly more code
from explicit imports, but each file has one job and is independently
testable.

---

## Migration Steps

1. **Extract `text.ts`** — move `normalizeInlineText`, `truncate`,
   `firstLine`. Update all importers. Delete duplicates in
   `persistent-steward.ts`.

2. **Extract `board-parse.ts`** — move `parseTaskStatus`, `parseTaskId`,
   `isRealBlocker`. Update `state.ts`, `digest.ts`, `supervisor.ts`.
   **Fix the "pending" divergence** — one canonical behavior.

3. **Extract `state-delta.ts`** — move `hashJson`, all `build*Change`
   functions, `buildDeltaPacket`, and the `StewardDeltaPacket` /
   `StewardDeltaChange` types.

4. **Extract `state-refresh.ts`** — move `refreshProjectRuntimeState`
   and `readStewardDeltaHistory`.

5. **Update tests** — existing `state.test.ts` should split into
   `state.test.ts` (summarizers), `state-delta.test.ts` (change detection),
   `state-refresh.test.ts` (integration).

---

## Success Criteria

1. `parseTaskStatus` exists in exactly one file.
2. `normalizeInlineText` and `truncate` exist in exactly one file.
3. Every summarizer is a pure function testable without disk I/O.
4. Every delta builder is a pure function testable without disk I/O.
5. `refreshProjectRuntimeState` is the only function that touches disk.
6. All existing tests pass unchanged.
