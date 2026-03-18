# Codebase Archaeology Report

Generated: 2026-03-17

Full audit of accumulated debt, naming inconsistencies, dead code, and structural issues across the HIVE codebase.

---

## 1. Orchestrator vs Steward Naming

The codebase has two names for the same role. "Steward" is the conceptual/persona name (what the agent *is*). "Orchestrator" is the operational/agent-id name (what the system calls it in data structures). Both are used inconsistently, creating confusion about whether they refer to the same thing.

### Where "orchestrator" appears as agent ID / operational identifier

These are legitimate uses where "orchestrator" is the `agentId` value in run records, messages, and board entries:

| Location | Usage |
|----------|-------|
| `src/lib/supervisor.ts:145,148,151,165,208` | `run.agentId === "orchestrator"`, `message.attributes.to === "orchestrator"` |
| `src/lib/orchestrator.ts:194,234,336,396` | Messages addressed `to: "orchestrator"`, resolve commands with `orchestrator` |
| `src/commands/supervise.ts:302-387` | Checks for orchestrator runs, launches `agentId: "orchestrator"` |
| `src/commands/launch.ts:136-205` | Special handling for `agentId !== "orchestrator"` |
| `src/gateway/routes.ts:1040,1532,1569,1601,1607,1691-1692,2088,2139,2152,2171` | Extensive orchestrator agent checks |
| `templates/project-config.md:18` | `orchestrator: steward` (team definition) |
| `templates/BOARD.md:16` | `orchestrator | active | task: monitoring...` |
| `templates/PLAN.md:12` | `### orchestrator (steward)` |
| `templates/LOG.md:7` | `## 2026-03-13T14:22:00Z -- orchestrator` |

### Where "steward" appears as the conceptual role name

| Location | Usage |
|----------|-------|
| `src/lib/orchestrator.ts:350` | `# HIVE Steward Prompt` (the prompt for the "orchestrator" agent is titled "Steward") |
| `src/lib/orchestrator.ts:352` | `You are the steward/orchestrator for project...` |
| `src/lib/orchestrator.ts:393` | `## Steward Rules` |
| `src/lib/steward.ts` (entire file) | `runDirectStewardTurn`, `buildStewardTurnPrompt`, `StewardTurnResult` |
| `src/lib/persistent-steward.ts` (entire file) | `runPersistentStewardTurn`, persistent steward session logic |
| `src/lib/supervisor.ts:10,15,133,143-146` | `DEFAULT_STEWARD_REASSESS_SECONDS`, `StewardAssessment`, `assessStewardLaunch` |
| `src/lib/state.ts:189-213` | `StewardDeltaChange`, `StewardDeltaPacket` |
| `src/lib/cognitive-routing.ts:13,806-807` | `STEWARD_ESSENTIAL_SKILL_NAMES`, `current steward lane`, `default steward lane` |
| `src/lib/tier1.ts:286,587,724-727` | `shouldUseTier1Compression` checks `"steward"`, `isStewardKeyFile`, `stewardWorthy` |
| `templates/config.md:13` | `orchestrator: steward` |
| `templates/AGENTS.md:8,86` | `BOARD.md is steward-owned`, `Trust the orchestrator` |
| `templates/personas/steward.md` | The persona file for this role |

### Assessment

**The canonical *persona* name is "steward"** (it has its own persona file, the prompts call it steward). **The canonical *agent-id* is "orchestrator"** (used in run records, message routing, board entries). This dual naming is the root cause of confusion.

### Recommended fix

Pick one name and use it everywhere. "Steward" is the stronger choice because:
- It is the persona name.
- All three prompt-building files (`orchestrator.ts`, `steward.ts`, `persistent-steward.ts`) refer to it as steward in user-facing text.
- The filename `orchestrator.ts` is misleading -- it builds the steward prompt, not an "orchestrator".

Changes needed:
1. Rename `src/lib/orchestrator.ts` to `src/lib/steward-prompt.ts` (or merge into `steward.ts`)
2. Change the agent-id from `"orchestrator"` to `"steward"` in all operational code (supervisor, runs, messages, board templates)
3. Update templates: `project-config.md`, `BOARD.md`, `PLAN.md`, `LOG.md`, `AGENTS.md`
4. Add a migration note or alias so existing hive homes with `orchestrator` agent-ids still work

**Priority: HIGH** -- actively confusing. New contributors cannot tell if orchestrator and steward are different agents.
**Safety: MEDIUM** -- the agent-id change requires data migration for existing hive homes (message `to:` fields, run records, board entries). A compatibility shim (`"orchestrator"` as alias for `"steward"`) would reduce risk.

---

## 2. Dead Code and Unused Exports

### Fully unused exports

| Export | File | Evidence | Priority |
|--------|------|----------|----------|
| `listPiProviders()` | `src/lib/pi.ts:29` | Not imported anywhere outside its own file | LOW |
| `RuntimeName` type | `src/lib/runtime.ts:535` | Only used in `runs.ts` as `RuntimeName = string` -- a type alias for `string` with no semantic enforcement. Could be inlined. | LOW |
| `RuntimeAuthPolicy` type | `src/lib/runtime.ts:576` | Only used within `runtime.ts` and `cognitive-routing.ts` -- the export is correct but the type is also independently defined in cognitive-routing.ts | LOW |

### Duplicate `DeltaHistoryEntry` type

Defined identically in both:
- `src/lib/steward.ts:41-44`
- `src/lib/persistent-steward.ts:60-63`

Both have the exact same shape `{ revision: number; changes: string[] }`. Should be extracted to a shared location (e.g., `state.ts` which already defines `StewardDeltaPacket`).

**Priority: MEDIUM** -- duplication that will drift.

### Duplicate `renderDeltaHistory` function

Nearly identical implementations in:
- `src/lib/steward.ts:181-191`
- `src/lib/persistent-steward.ts:297-311`

Both render delta history entries in the same format. Should be shared.

**Priority: MEDIUM**

### Duplicate `renderRecentResultsDigest` and `renderHumanInboxDigest`

These exist in `src/lib/steward.ts:193-217` and are not shared with `persistent-steward.ts`, which has its own similar rendering logic.

**Priority: LOW**

---

## 3. Duplicate Logic

### 3a. `parseTaskStatus` -- EXACT duplicate

- `src/lib/digest.ts:5-35`
- `src/lib/state.ts:258-290`

Nearly identical logic. The `state.ts` version includes `"pending"` in its status list while `digest.ts` does not (minor divergence that could cause bugs).

**Fix:** Extract to `board.ts` alongside `parseBoard()`. Both files already import from `board.ts`.
**Priority: HIGH** -- the subtle `"pending"` divergence is a latent bug.

### 3b. `isRealBlocker` -- EXACT duplicate

- `src/lib/digest.ts:37-39`
- `src/lib/state.ts:299-301`

Identical one-liner. Extract to `board.ts`.
**Priority: LOW** -- cosmetic.

### 3c. `extractConfigValue` -- TRIPLICATE

- `src/lib/runtime.ts:610-613`
- `src/lib/cognitive-routing.ts:124-128`
- `src/lib/cognitive-usage.ts:47-51`

Identical function (regex match for `key: value` in config text). Should be extracted to a shared `config.ts` utility or added to an existing utility file.

**Priority: MEDIUM** -- three copies means three places to fix any parsing bug.

### 3d. `extractConfigValueAlias` -- DUPLICATE

- `src/lib/cognitive-routing.ts:130-140`
- `src/lib/cognitive-usage.ts:53-63`

Identical. Should share with `extractConfigValue`.
**Priority: LOW**

### 3e. `parsePositiveInt` -- DUPLICATE

- `src/lib/cognitive-routing.ts:158-166`
- `src/lib/cognitive-usage.ts:65-73`

Identical.
**Priority: LOW**

### 3f. `isProcessAlive` -- TRIPLICATE

- `src/lib/supervisor.ts:62-83` (exported, the "canonical" version)
- `src/lib/runs.ts:107-128` (private copy)
- `src/commands/gateway.ts:15-?` (private copy)

The `supervisor.ts` version is exported and used by `detached-supervisor.ts`. The other two are private copies. `runs.ts` and `gateway.ts` should import from `supervisor.ts`.

**Priority: MEDIUM** -- divergence risk. The `runs.ts` copy is slightly different (accepts `number | null`).

### 3g. `toNullableNumber` -- TRIPLICATE

- `src/lib/runtime.ts:55-57` (takes `unknown`)
- `src/lib/runs.ts:130-138` (takes `string | undefined`)
- `src/lib/detached-supervisor.ts:105-112` (takes `string | undefined`)

Different signatures but same purpose. Should be unified in a shared utility.
**Priority: LOW**

### 3h. `readJson` / `writeJson` -- DUPLICATE

- `src/lib/state.ts:498-514`
- `src/lib/memory.ts:214-231`

Both are `async function readJson<T>(path: string)` and `async function writeJson(path: string, value: unknown)`. Nearly identical except `memory.ts` version calls `ensureDirectory(dirname(path))` before writing. Should be shared.

**Priority: MEDIUM**

### 3i. Steward prompt construction -- TRIPLICATE

Three files build steward/orchestrator prompts with substantial overlap:

| File | Function | Lines |
|------|----------|-------|
| `src/lib/orchestrator.ts` | `buildOrchestratorPrompt()` | 295-466 (172 lines) |
| `src/lib/steward.ts` | `buildStewardTurnPrompt()` | 219-306 (88 lines) |
| `src/lib/persistent-steward.ts` | `buildPersistentStewardTurnPrompt()` | ~same as steward.ts variant |

All three render the same conceptual sections (soul, identity, board, messages, runs, memory, cognitive routing policy) with slightly different formats. `orchestrator.ts` is the "bootstrap" prompt (used for disposable orchestrator passes). `steward.ts` and `persistent-steward.ts` are for the "session" prompt (continuing conversation).

The steward.ts and persistent-steward.ts prompts are structurally identical with different rendering details. They should share a common prompt builder.

**Priority: HIGH** -- any prompt section added to one must be manually replicated to the other two.

---

## 4. File Size Analysis

### Files over 400 lines (candidates for splitting)

| File | Lines | Assessment |
|------|-------|------------|
| `src/gateway/routes.ts` | 3584 | **Urgently needs splitting.** Contains all API route handlers, the steward turn orchestration logic, the session drain pipeline, and the live snapshot builder. Natural seams: (1) route definitions, (2) console/steward turn logic (~lines 1500-2400), (3) live/queue/timeline snapshot builders. |
| `src/lib/persistent-steward.ts` | 1757 | Large but cohesive -- it's the Pi-based persistent steward implementation. Could split out the tool definitions (~600 lines of tool schemas) into a separate file. |
| `src/lib/runtime.ts` | 1180 | Has clear seams: (1) adapter interface + built-in adapters (lines 1-530), (2) config/policy/hints resolution (lines 530-865), (3) launch/spawn mechanics (lines 865-1180). |
| `src/lib/state.ts` | 986 | Cohesive. The summarize/refresh logic is all interrelated. Could extract the delta-building functions. |
| `src/lib/cognitive-routing.ts` | 906 | Somewhat cohesive. The `discoverLocalModels` function and its cache (lines 610-742) could live in a separate `local-models.ts`. |
| `src/lib/tier1.ts` | 843 | Has clear seams: (1) compression (~lines 1-558), (2) human message preprocessing (~lines 560-684), (3) diff triage (~lines 686-843). |
| `src/lib/runs.ts` | 868 | Cohesive -- all run lifecycle management. |
| `src/lib/sessions.ts` | 803 | Cohesive -- all session management. |
| `src/lib/memory.ts` | 779 | Has a seam between entity memory operations and the global extract/journal logic. |
| `src/commands/supervise.ts` | 627 | Reasonable for a command handler with embedded supervisor loop logic. |
| `src/lib/steward.ts` | 592 | Cohesive. |
| `src/lib/orchestrator.ts` | 466 | Could be merged into steward.ts since it builds the "bootstrap steward prompt." |
| `src/lib/supervisor.ts` | 415 | Cohesive. |
| `src/commands/console.ts` | 406 | Reasonable. |

### Files under 50 lines (candidates for merging)

| File | Lines | Assessment |
|------|-------|------------|
| `src/lib/errors.ts` | 6 | Single `UsageError` class. Could merge into any utility file, but it's imported by ~15 files. Keeping it separate is fine for import cleanliness. **Leave as-is.** |
| `src/lib/log.ts` | 12 | `appendLogEntry` only. Could merge into `feed.ts` or a shared `io.ts`, but the separation is clean. **Leave as-is.** |
| `src/lib/format.ts` | 37 | ANSI color helpers. Standalone utility. **Leave as-is.** |
| `src/commands/sync.ts` | 36 | Thin command. **Leave as-is.** |
| `src/commands/log.ts` | 30 | Thin command wrapper. **Leave as-is.** |
| `src/commands/init.ts` | 21 | Thin command. **Leave as-is.** |
| `src/commands/cognition.ts` | 43 | Thin command. **Leave as-is.** |
| `src/commands/work.ts` | 45 | Thin command. **Leave as-is.** |
| `src/lib/time.ts` | 49 | Core utility. **Leave as-is.** |

None of the small files are problematic. They are appropriately scoped single-responsibility modules.

---

## 5. Template and Config Staleness

### config.md template (`templates/config.md`)

The template is current. All keys documented in the template are read by the code:
- `runtime`, `model` -- read by `runtime.ts:readRuntimeAccessPolicy()`
- `orchestrator: steward` -- read by project config parser
- `pi-provider-claude`, `pi-model-claude`, `pi-auth-anthropic` -- read by `runtime.ts`
- `cognitive-bias`, `cognitive-max-fanout`, `cognitive-max-parallel` -- read by `cognitive-routing.ts`
- `cognitive-window-hours`, `cognitive-budget-*` -- read by `cognitive-usage.ts`
- `tier1-local`, `tier1-cloud`, `tier1-fallback`, `ollama-base-url` -- read by `cognitive-routing.ts:readCognitiveTier1Config()`

**One issue:** The template references `ollama-base-url` (line 40) which only matters for tier-1 local model discovery via Ollama. This is current and correct.

### project-config.md template

Current. The `## Default Team` section with `- orchestrator: steward` should be updated when the naming is unified (see Section 1).

### AGENTS.md template

Lines 8 and 86 use both "steward" and "orchestrator" in the same document, which reinforces the naming confusion:
- Line 8: "BOARD.md is steward-owned. In the default team, that means the orchestrator."
- Line 86: "Trust the orchestrator. The steward sees the whole board."

**Fix:** Unify to one term after the naming decision.
**Priority: MEDIUM**

### BOARD.md template

Line 16 uses `orchestrator` as agent name. Update when naming is unified.

### Persona templates

`templates/personas/steward.md` is current and well-written. No staleness issues.

### Skill templates

All three skill templates (`state-efficient-ops.md`, `autonomous-ops.md`, `cognitive-resource-routing.md`) are current and referenced by the code.

### Missing template references

No references to removed features or dead agent names were found. The Ollama references are legitimate (tier-1 local models use Ollama).

**Overall template staleness: LOW** -- templates are reasonably current. The main issue is the orchestrator/steward naming split.

---

## 6. Test Coverage Gaps

### src/lib/ modules WITH tests

| Module | Test File |
|--------|-----------|
| `approvals` | `tests/approval.test.ts` |
| `cognitive-routing` | `tests/cognitive-routing.test.ts` |
| `cognitive-usage` | `tests/cognitive-usage.test.ts` |
| `digest` | `tests/digest.test.ts` |
| `events` | `tests/events.test.ts` |
| `feed` | `tests/feed.test.ts` |
| `memory` | `tests/memory.test.ts` |
| `runs` | `tests/runs.test.ts` |
| `runtime` | `tests/runtime.test.ts`, `tests/runtime-adapters.test.ts` |
| `sessions` | `tests/sessions.test.ts` |
| `state` | `tests/state.test.ts` |
| `supervisor` | `tests/supervisor.test.ts`, `tests/supervisor-safety.test.ts` |
| `tier1` | `tests/tier1.test.ts` |

### src/lib/ modules WITHOUT tests

| Module | Lines | Risk |
|--------|-------|------|
| `board` | 231 | **HIGH** -- core parsing logic used by digest, state, supervisor, orchestrator. `parseBoard()`, `minutesSince()`, `parseLooseTimestamp()` are all untested directly (only tested indirectly through digest tests). |
| `detached-supervisor` | 373 | **MEDIUM** -- spawn/lifecycle logic that is hard to test but has real failure modes. `tests/supervise.test.ts` covers the supervise command but not the detached supervisor state machine. |
| `errors` | 6 | LOW -- trivial. |
| `format` | 37 | LOW -- ANSI utilities. |
| `frontmatter` | 57 | **MEDIUM** -- foundational parser used by messages, runs, sessions. Any bug here propagates everywhere. Should have direct unit tests. |
| `git` | 105 | LOW -- thin wrapper around git commands. |
| `log` | 12 | LOW -- single function. |
| `messages` | 244 | **MEDIUM** -- message creation, resolution, finding. Core coordination primitive. |
| `orchestrator` | 466 | **MEDIUM** -- prompt building. Could have snapshot tests for prompt structure. |
| `paths` | 304 | LOW -- mostly directory structure definitions. |
| `persistent-steward` | 1757 | **HIGH** -- complex Pi integration, tool definitions, session management. No dedicated test file. |
| `pi` | 84 | LOW -- thin wrapper around external lib. |
| `project` | 231 | LOW -- config parsing utilities. |
| `steward` | 592 | **MEDIUM** -- direct steward turn orchestration. |
| `templates` | 109 | LOW -- template rendering. |
| `time` | 49 | LOW -- date utilities. |

### Test files that test things that may not exist

- `tests/runtime-adapters.test.ts` -- Tests runtime adapters. All adapters still exist (claude, codex, gemini). **Current.**
- `tests/hive.test.ts` -- Integration tests. **Current.**
- `tests/gateway.test.ts` -- Gateway API tests. **Current.**
- `tests/supervise.test.ts` -- Tests the supervise command flow. **Current.**

No test files test removed/dead code.

---

## 7. Gateway Static Files vs Routes

### API endpoints defined in routes.ts

```
/api/status
/api/feed
/api/live
/api/queue
/api/timeline
/api/file
/api/ps
/api/projects
/api/process-logs
/api/runtimes
/api/cognition
/api/console/history
/api/sessions
/api/say
/api/console/send
/api/console/new
/api/supervisor/restart
/api/nudge
/api/msg
/api/log
/api/open
```

### API endpoints called by app.js

```
/open              (apiPost)
/console/new       (apiPost)
/sessions/{id}     (apiGet -- pattern, not in routes table as static key)
/sessions          (apiGet)
/live              (apiGet)
/queue             (apiGet)
/timeline          (apiGet)
/process-logs      (apiGet)
/cognition         (apiGet)
/status            (apiGet)
/console/send      (apiPost)
/console/history   (apiGet)
/supervisor/restart (apiPost)
```

### Endpoints in routes.ts NOT called by app.js

| Endpoint | Purpose | Assessment |
|----------|---------|------------|
| `/api/feed` | Feed entries | Not called from UI. The UI has a feed section but may get data through `/api/live` instead. **Possibly unused from web UI but may be used by CLI.** |
| `/api/ps` | Process status | Not directly called. May be embedded in `/api/live`. **Check if this is dead.** |
| `/api/projects` | Project listing | Not called from app.js. **May be dead from web UI.** |
| `/api/runtimes` | Runtime listing | Not called from app.js. **May be dead from web UI.** |
| `/api/say` | Send message | Not called from app.js (app.js uses `/console/send` instead). **Possibly dead from web UI.** |
| `/api/nudge` | Send nudge | Not called from app.js. **Possibly dead from web UI.** |
| `/api/msg` | Message operations | Not called from app.js. **Possibly dead from web UI.** |
| `/api/log` | Log entry | Not called from app.js. **Possibly dead from web UI.** |
| `/api/file` | File reading | Not called from app.js. **Possibly dead from web UI.** |

Note: Several of these endpoints may be intentionally kept for programmatic/CLI access even if the web UI does not use them. They are not strictly dead -- they are API surface that the web UI does not consume.

### Endpoints called by app.js NOT in routes table

- `/sessions/{sessionId}` -- This is a dynamic route. It is likely handled by a pattern match in routes.ts rather than a static key. **Needs verification.**

**Priority: LOW** -- the API surface is broader than the web UI needs, but the extra endpoints are harmless and may serve CLI/integration use cases.

---

## 8. Import Graph Issues

### Circular import risk

No actual circular imports were found. The import graph is generally clean:

```
time, errors, frontmatter, format  (leaf utilities, no internal deps)
  |
board, messages, feed, log, git, pi  (use only leaf utilities)
  |
digest, project, runs  (use board, messages, etc.)
  |
paths, templates  (use templates/)
  |
sessions, events, approvals  (use frontmatter, time, paths)
  |
memory, state  (use paths, sessions, runs, messages, events, feed, digest)
  |
runtime, cognitive-routing, cognitive-usage  (use paths, runs, state)
  |
supervisor, tier1  (use cognitive-routing, runs, pi)
  |
orchestrator, steward, persistent-steward  (use everything above)
  |
detached-supervisor  (uses supervisor, paths)
  |
commands/*  (use lib/*)
  |
gateway/routes.ts  (uses commands/* and lib/*)
```

The deepest chain is approximately 7 levels, which is acceptable but worth noting:
`routes.ts -> steward.ts -> state.ts -> sessions.ts -> frontmatter.ts -> (leaf)`

### One architectural concern

`src/gateway/routes.ts` at 3584 lines imports from 25 different modules. It is the single largest coupling point in the codebase. If it were split (see Section 4), the import graph would be cleaner.

**Priority: MEDIUM** -- no circular imports, but `routes.ts` is a god-file.

---

## Summary of Recommendations by Priority

### HIGH priority

1. **Unify orchestrator/steward naming** (Section 1) -- Pick "steward" everywhere, add migration shim for existing data.
2. **Extract `parseTaskStatus` from duplicate** (Section 3a) -- The `"pending"` divergence between `digest.ts` and `state.ts` is a latent bug.
3. **Consolidate prompt construction** (Section 3i) -- Three files build steward prompts independently. Any prompt change requires triple updates.
4. **Split `routes.ts`** (Section 4) -- 3584 lines with 25 imports is unmaintainable.
5. **Add tests for `board.ts` and `frontmatter.ts`** (Section 6) -- Foundational parsers used everywhere, no direct tests.

### MEDIUM priority

6. **Extract shared `DeltaHistoryEntry` type and `renderDeltaHistory`** (Section 2) -- Duplicate between `steward.ts` and `persistent-steward.ts`.
7. **Extract `extractConfigValue` family to shared utility** (Section 3c) -- Triplicated across three files.
8. **Consolidate `isProcessAlive`** (Section 3f) -- Three copies with subtle signature differences.
9. **Consolidate `readJson`/`writeJson`** (Section 3h) -- Duplicate between `state.ts` and `memory.ts`.
10. **Add tests for `persistent-steward.ts`** (Section 6) -- 1757 lines with no tests.
11. **Clarify AGENTS.md dual naming** (Section 5) -- "Trust the orchestrator. The steward sees the whole board" is confusing.

### LOW priority

12. Remove unused `listPiProviders` export from `pi.ts` (Section 2).
13. Consolidate `toNullableNumber` variants (Section 3g).
14. Consolidate `parsePositiveInt` and `extractConfigValueAlias` duplicates (Sections 3d, 3e).
15. Consider splitting `runtime.ts` at its natural seams (Section 4).
16. Audit which `/api/` endpoints are actually needed by the web UI (Section 7).
