# Steward Abstraction Unification

Design document. March 2026.

---

## Problem

The steward — the live head of the hive — is implemented twice:

- `steward.ts` (553 lines): direct one-shot steward turns via CLI runtime
- `persistent-steward.ts` (1,391 lines): Pi-backed persistent session

These files share the same goal (run a steward turn with full hive context)
but share almost no code. The result is:

1. **Duplicated rendering** — `renderRecentTurns`, `renderDeltaHistory`,
   `renderRecentResultsDigest`, `renderHumanInboxDigest`, and
   `loadDeltaHistory` are copy-pasted identically across both files.

2. **Duplicated context loading** — both files independently load soul,
   identity, board, messages, runs, sessions, memory, and cognitive routing
   policy. They produce slightly different context types
   (`StewardPromptContext` vs `PersistentStewardContext`) that carry the
   same data.

3. **Duplicated text utilities** — `normalizeInlineText` and `truncate` are
   redefined in `persistent-steward.ts` (addressed separately in the state
   decomposition doc).

4. **Divergent prompt assembly** — `buildStewardTurnPrompt` (steward.ts)
   and `buildPersistentStewardSystemPrompt` + bootstrap/refresh messages
   (persistent-steward.ts) encode the same steward identity and
   instructions in different formats. When one gets updated, the other
   drifts.

5. **No shared test coverage** — because the context loading is duplicated,
   there's no way to test "steward context is correct" once and know both
   paths get it right.

---

## Root Cause

The two files were built at different times for different execution models:

- `steward.ts` was built first for one-shot CLI execution
- `persistent-steward.ts` was built later for the Pi session model

Each assembled its own context because the persistent steward needed a
different delivery format (bootstrap + refresh deltas vs single prompt).
But the *content* of the context is the same. The difference is packaging,
not substance.

---

## Proposed Solution: Extract `steward-context.ts`

Create a shared layer that both execution modes consume.

### `src/lib/steward-context.ts`

This file owns:

1. **The canonical steward context type**
2. **Context loading** — one function that loads everything the steward needs
3. **Shared rendering** — digest/summary rendering used by both modes
4. **Prompt content blocks** — the reusable content sections that both prompt
   formats draw from

```typescript
// The unified context type
export type StewardContext = {
  // Identity
  soul: string;
  identity: string;
  selfContext: string;
  agents: string;

  // Project
  projectId: string;
  projectPath: string;
  boardDigest: string;
  boardSummary: BoardSummary;

  // Coordination state
  openMessages: OpenMessagesSummary;
  activeRuns: ActiveRunsSummary;
  recentResults: RecentResultsSummary;
  humanInbox: HumanInboxSummary;

  // Memory
  memory: PromptMemoryContext;

  // Session
  recentTurns: SessionTurn[];
  deltaHistory: DeltaHistoryEntry[];
  sessionState: SessionState | null;

  // Policy
  cognitivePolicy: string;
  skills: string[];

  // Derived
  revision: number;
};

// One function to load it all
export async function loadStewardContext(
  paths: HivePaths,
  projectId: string,
  sessionId?: string,
): Promise<StewardContext>;

// Shared rendering (currently duplicated in both files)
export function renderRecentTurns(turns: SessionTurn[], limit?: number): string;
export function renderDeltaHistory(entries: DeltaHistoryEntry[]): string;
export function renderRecentResultsDigest(summary: RecentResultsSummary): string;
export function renderHumanInboxDigest(summary: HumanInboxSummary): string;
export function loadDeltaHistory(paths: ProjectPaths, since?: number): DeltaHistoryEntry[];

// Reusable prompt content blocks
export function renderStewardIdentityBlock(ctx: StewardContext): string;
export function renderStewardStateBlock(ctx: StewardContext): string;
export function renderStewardInstructionsBlock(ctx: StewardContext): string;
```

### Refactored `steward.ts`

Becomes thin. Imports `StewardContext` and `loadStewardContext`, then:

1. Loads context
2. Assembles it into a single one-shot prompt using the content blocks
3. Launches runtime
4. Captures result

No context loading logic. No rendering functions. ~200 lines.

### Refactored `persistent-steward.ts`

Imports `StewardContext` and `loadStewardContext`, then:

1. Loads context for bootstrap
2. Packages content blocks into system prompt + bootstrap message
3. On refresh, loads only the delta and packages it as a refresh message
4. Manages the Pi session lifecycle

The Pi process management, streaming, and session lifecycle stay here.
Context loading and rendering move out. ~800 lines (down from 1,391).

---

## The Refresh Path

The persistent steward has a concept the one-shot steward doesn't: refresh
turns that send only deltas. This is a real difference, not artificial
duplication.

`steward-context.ts` should also export:

```typescript
export type StewardRefreshDelta = {
  revision: number;
  changes: StewardDeltaChange[];
  humanMessage: string | null;
  workerCompletions: RecentResultSummaryItem[];
};

export async function loadStewardRefreshDelta(
  paths: HivePaths,
  projectId: string,
  sinceRevision: number,
): Promise<StewardRefreshDelta>;
```

The one-shot steward ignores this (it always does a full load). The
persistent steward uses it for efficient subsequent turns.

---

## Migration Steps

1. **Create `steward-context.ts`** with the unified type and
   `loadStewardContext`. Initially, this can delegate to existing loading
   code — just centralize the call sites.

2. **Move shared rendering functions** from both files into
   `steward-context.ts`. Delete the duplicates.

3. **Refactor `steward.ts`** to import and use `loadStewardContext` +
   content blocks. Remove its internal context loading.

4. **Refactor `persistent-steward.ts`** to import and use
   `loadStewardContext` + content blocks. Remove its internal context
   loading and rendering duplicates.

5. **Extract prompt content blocks** — identify the shared prose
   (steward identity, instructions, initiative directives) that appears
   in both prompt builders. Make these shared functions that return
   markdown strings.

6. **Update tests** — add `steward-context.test.ts` that verifies
   context loading once. Existing steward tests become thinner.

---

## What Stays Separate

The execution models are genuinely different and should remain in their
own files:

| Concern                    | `steward.ts`        | `persistent-steward.ts` |
|---------------------------|---------------------|-------------------------|
| Session lifecycle          | None (one-shot)     | Pi process management   |
| Prompt format              | Single combined     | System + bootstrap + refresh |
| Streaming                  | Runtime adapter     | Pi subscribe events     |
| Context delivery           | Full every time     | Bootstrap once, then deltas |
| Run ledger integration     | Direct              | Gateway-managed         |

These are real architectural differences. Don't force them together.

---

## Success Criteria

1. `loadStewardContext` is called from exactly two places: `steward.ts`
   and `persistent-steward.ts`.
2. Zero rendering functions are duplicated across files.
3. Updating the steward's identity prose or instructions happens in one
   place and affects both execution modes.
4. `persistent-steward.ts` drops below 900 lines.
5. `steward.ts` drops below 300 lines.
6. All existing tests pass unchanged.
