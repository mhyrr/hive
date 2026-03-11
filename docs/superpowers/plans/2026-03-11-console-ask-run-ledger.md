# Console & Ask Run-Ledger Integration

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold `hive console` into the run ledger as a tracked session, make the supervisor ignore console runs for scope conflicts, handle console gracefully in `hive stop`, and make `hive ask <question>` answer the actual question via a single-turn LLM call.

**Architecture:** Console sessions become run records with `source: "console"` and a reserved agent ID `"console"`. The supervisor filters these out when computing scope conflicts and parallel limits. The `ask` command gains a dual path: no question = fast synthesized status (current behavior), with question = single-turn LLM call using the state as context.

**Design decisions:**
- Console uses `agentId: "console"` — one active console session per project (the duplicate check is scoped to the active project via `readActiveRun`). Multiple projects can have simultaneous console sessions.
- Console `scope: null` but the supervisor ignores it — the human operates at a different level than agents.

**Tech Stack:** TypeScript, Bun, existing run/supervisor/runtime infrastructure

---

## File Map

- **Modify:** `src/commands/console.ts` — Add run record lifecycle (create draft, mark active, finalize)
- **Modify:** `src/lib/supervisor.ts` — Filter console runs from worker/steward assessments
- **Modify:** `src/commands/stop.ts` — Advisory handling for console-source runs
- **Modify:** `src/commands/ask.ts` — Add LLM-powered question answering
- **Modify:** `src/commands/ps.ts` — Display console sessions distinctly
- **Test:** `tests/runs.test.ts` — Console run lifecycle + ps visibility + stop advisory
- **Test:** `tests/supervisor.test.ts` — Console runs ignored for scope/parallel limits

---

## Chunk 1: Console Session Tracking

### Task 1: Test that console sessions are tracked in the run ledger

**Files:**
- Test: `tests/runs.test.ts`

- [ ] **Step 1: Write failing tests for console run lifecycle**

Add to `tests/runs.test.ts` inside the `"run state"` describe block:

```typescript
test("console session creates a tracked run record and cleans up on finalize", async () => {
  await runCli(["init"]);
  await runCli(["project", "add", "DealSplit", context.repo]);

  const paths = await ensureHiveScaffold();
  const projectPaths = getProjectPaths(paths, "dealsplit");

  let run = await createRunDraft({
    projectId: "dealsplit",
    projectPaths,
    agentId: "console",
    runtime: "claude",
    model: null,
    prompt: "# Console Session",
    source: "console",
  });

  expect(run.source).toBe("console");
  expect(run.agentId).toBe("console");
  expect(await Bun.file(run.path).text()).toContain("status: starting");

  run = await markRunActive(projectPaths, run, 99999);

  const activeRaw = await Bun.file(join(projectPaths.runsActiveDir, "console.md")).text();
  expect(activeRaw).toContain("status: active");
  expect(activeRaw).toContain("source: console");

  run = await finalizeRun({
    projectPaths,
    run,
    status: "exited",
    exitCode: 0,
  });

  expect(await Bun.file(join(projectPaths.runsActiveDir, "console.md")).exists()).toBeFalse();
  expect(await Bun.file(run.path).text()).toContain("status: exited");
});
```

- [ ] **Step 2: Run test to verify it passes (run infrastructure already supports this)**

Run: `bun test tests/runs.test.ts`
Expected: PASS — the run infrastructure is generic enough that `source: "console"` and `agentId: "console"` work without any code changes to `runs.ts`.

- [ ] **Step 3: Write test that hive ps shows console sessions**

Add to `tests/runs.test.ts`:

```typescript
test("hive ps shows console sessions alongside agent runs", async () => {
  await runCli(["init"]);
  await runCli(["project", "add", "DealSplit", context.repo]);

  const paths = await ensureHiveScaffold();
  const projectPaths = getProjectPaths(paths, "dealsplit");

  const consoleRun = await createRunDraft({
    projectId: "dealsplit",
    projectPaths,
    agentId: "console",
    runtime: "claude",
    model: null,
    prompt: "# Console",
    source: "console",
  });
  await markRunActive(projectPaths, consoleRun, 88888);

  const agentRun = await createRunDraft({
    projectId: "dealsplit",
    projectPaths,
    agentId: "alpha",
    runtime: "codex",
    model: null,
    prompt: "# Agent",
    source: "hive launch",
  });
  await markRunActive(projectPaths, agentRun, 77777);

  const output = await runCli(["ps"]);

  expect(output).toContain("console | active");
  expect(output).toContain("source: console");
  expect(output).toContain("alpha | active");
  expect(output).toContain("Active runs: 2");
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/runs.test.ts`
Expected: PASS — `hive ps` already renders all active runs from `listActiveRuns()`.

- [ ] **Step 5: Commit**

```bash
git add tests/runs.test.ts
git commit -m "test: add console session tracking tests for run ledger"
```

### Task 2: Wire console.ts to create and finalize run records

**Files:**
- Modify: `src/commands/console.ts`

- [ ] **Step 1: Add run record imports to console.ts**

Add these imports to the existing import block at the top of `console.ts`:

```typescript
import {
  createRunDraft,
  finalizeRun,
  markRunActive,
  readActiveRun,
} from "../lib/runs";
```

- [ ] **Step 2: Add duplicate console check and run lifecycle to consoleCommand**

In `consoleCommand()`, after the `repoPath` check (line 207) and before `const board = ...` (line 209), add the duplicate console check:

```typescript
const existingConsole = await readActiveRun(projectPaths, "console");
if (existingConsole) {
  throw new UsageError(
    `A console session is already active (${existingConsole.runId}). Use \`hive ps\` to inspect it.`,
  );
}
```

Then replace the block from `const promptPath = join(...)` (line 268) through the end of the function (line 312) with the run-tracked version. The new flow:

1. Create run draft (replaces manual prompt file write)
2. Start the interactive session
3. Mark run active with PID
4. Wait for exit
5. Finalize run

```typescript
let run = await createRunDraft({
  projectId: activeProject,
  projectPaths,
  agentId: "console",
  runtime: spec.runtime,
  model: spec.model,
  prompt,
  source: "console",
});

if (options.dryRun) {
  await finalizeRun({ projectPaths, run, status: "cancelled", exitCode: null });
  return `Console dry run
Project: ${activeProject}
Runtime: ${spec.runtime}
Model: ${spec.model ?? "(default)"}
Prompt: ${run.promptPath}
Command: ${renderLaunchPreview(spec)}`;
}

await appendLogEntry(projectPaths.log, "human → hive console", "Interactive session started");
await appendFeedEntry(paths, {
  project: activeProject,
  headline: `Console session started`,
  details: [`runtime: ${spec.runtime}`, `model: ${spec.model ?? "(default)"}`],
});

const handle = startInteractiveSession(spec, repoPath);
run = await markRunActive(projectPaths, run, handle.pid);
const result = await handle.wait();

const stopRequested = Boolean(
  (await Bun.file(run.path).text()).includes("stop-requested-at:"),
);

await finalizeRun({
  projectPaths,
  run,
  status: stopRequested
    ? "cancelled"
    : result.signal || (result.code !== null && result.code !== 0)
      ? "failed"
      : "exited",
  exitCode: result.code,
});

await appendFeedEntry(paths, {
  project: activeProject,
  headline: `Console session ended`,
  details: [
    `runtime: ${spec.runtime}`,
    `exit: ${result.code ?? "unknown"}${result.signal ? ` | signal: ${result.signal}` : ""}`,
  ],
});

if (result.signal) {
  throw new UsageError(`Console runtime exited due to ${result.signal}`);
}

if (result.code !== null && result.code !== 0) {
  throw new UsageError(`Console runtime exited with status ${result.code}`);
}

return `Hive console session completed via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""}`;
```

- [ ] **Step 3: Remove the old manual prompt file write**

The `const promptPath = join(...)` and `await Bun.write(promptPath, ...)` lines are no longer needed — `createRunDraft` handles prompt artifact storage. Remove them.

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All 86+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/console.ts
git commit -m "feat: track console sessions in the run ledger"
```

---

## Chunk 2: Supervisor & Stop Awareness

### Task 3: Supervisor ignores console sessions for scope conflicts and parallel limits

**Files:**
- Modify: `src/lib/supervisor.ts`
- Test: `tests/supervisor.test.ts`

- [ ] **Step 1: Write failing test — console run does not block worker launches**

Add to `tests/supervisor.test.ts` inside the `"supervisor assessment"` describe block:

```typescript
test("console session does not block worker launches via scope conflict", () => {
  const assessment = selectWorkerLaunches({
    projectConfig: `# Project\n\nlaunch-default: auto\n`,
    plan: `# Plan\n\n## Agents\n### alpha (craftsman -> src/api/**)\nTask: Build the API.\n`,
    openMessages: [
      {
        path: "/tmp/alpha.md",
        filename: "alpha.md",
        attributes: {
          from: "orchestrator",
          to: "alpha",
          type: "assign",
          status: "open",
          project: "dealsplit",
          task: "HIVE-011",
        },
        body: "Build the API.",
        raw: "",
      },
    ],
    activeRuns: [
      {
        runId: "20260310-140000Z-console",
        projectId: "dealsplit",
        agentId: "console",
        status: "active",
        runtime: "claude",
        model: null,
        started: "2026-03-10T14:00:00Z",
        ended: null,
        exitCode: null,
        pid: 99999,
        promptPath: "/tmp/console.prompt.md",
        source: "console",
        sourceMessage: null,
        taskId: null,
        scope: null,
        stopRequestedAt: null,
        stopRequestedBy: null,
        path: "/tmp/console/run.md",
      },
    ],
    historicalRuns: [],
    maxParallel: 2,
  });

  expect(assessment.launches.map((l) => l.agentId)).toEqual(["alpha"]);
  expect(assessment.skipped).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/supervisor.test.ts`
Expected: FAIL — currently the console run's null scope will conflict with alpha's scope.

- [ ] **Step 3: Write failing test — console run does not count toward parallel limit**

Add to `tests/supervisor.test.ts`:

```typescript
test("console session does not count toward parallel worker limit", () => {
  const assessment = selectWorkerLaunches({
    projectConfig: `# Project\n\nlaunch-default: auto\n`,
    plan: `# Plan\n\n## Agents\n### alpha (craftsman -> src/api/**)\nTask: Build the API.\n`,
    openMessages: [
      {
        path: "/tmp/alpha.md",
        filename: "alpha.md",
        attributes: {
          from: "orchestrator",
          to: "alpha",
          type: "assign",
          status: "open",
          project: "dealsplit",
          task: "HIVE-012",
        },
        body: "Build the API.",
        raw: "",
      },
    ],
    activeRuns: [
      {
        runId: "20260310-140000Z-console",
        projectId: "dealsplit",
        agentId: "console",
        status: "active",
        runtime: "claude",
        model: null,
        started: "2026-03-10T14:00:00Z",
        ended: null,
        exitCode: null,
        pid: 99999,
        promptPath: "/tmp/console.prompt.md",
        source: "console",
        sourceMessage: null,
        taskId: null,
        scope: null,
        stopRequestedAt: null,
        stopRequestedBy: null,
        path: "/tmp/console/run.md",
      },
    ],
    historicalRuns: [],
    maxParallel: 1,
  });

  // maxParallel is 1, but console shouldn't count — alpha should still launch
  expect(assessment.launches.map((l) => l.agentId)).toEqual(["alpha"]);
});
```

- [ ] **Step 4: Run tests to confirm failures**

Run: `bun test tests/supervisor.test.ts`
Expected: Both new tests FAIL.

- [ ] **Step 5: Filter console runs in selectWorkerLaunches**

In `src/lib/supervisor.ts`, modify `selectWorkerLaunches` (line 201):

Change:
```typescript
const activeWorkerRuns = input.activeRuns.filter((run) => run.agentId !== "orchestrator");
```

To:
```typescript
const activeWorkerRuns = input.activeRuns.filter(
  (run) => run.agentId !== "orchestrator" && run.source !== "console",
);
```

- [ ] **Step 6: Filter console runs in assessStewardLaunch**

In `src/lib/supervisor.ts`, modify `assessStewardLaunch` (line 148):

Change:
```typescript
const workerActiveRuns = input.activeRuns.filter((run) => run.agentId !== "orchestrator");
```

To:
```typescript
const workerActiveRuns = input.activeRuns.filter(
  (run) => run.agentId !== "orchestrator" && run.source !== "console",
);
```

This ensures a console session doesn't prevent the "board shows active agents but no active worker runs" trigger from firing.

- [ ] **Step 6b: Filter console runs in assessRecoveredRuns**

In `src/lib/supervisor.ts`, modify `assessRecoveredRuns` (line 284):

Change:
```typescript
for (const run of activeRuns) {
```

To:
```typescript
for (const run of activeRuns) {
  if (run.source === "console") {
    continue;
  }
```

This prevents a race condition where the supervisor's recovery loop could finalize a console session as "failed" if the supervisor loop runs between the interactive process exiting and `consoleCommand` reaching its own `finalizeRun` call. Console sessions manage their own lifecycle.

- [ ] **Step 7: Run tests**

Run: `bun test tests/supervisor.test.ts`
Expected: All tests PASS including the two new ones.

- [ ] **Step 8: Commit**

```bash
git add src/lib/supervisor.ts tests/supervisor.test.ts
git commit -m "feat: supervisor ignores console sessions for scope and parallel limits"
```

### Task 4: Stop command handles console gracefully

**Files:**
- Modify: `src/commands/stop.ts`
- Test: `tests/runs.test.ts`

- [ ] **Step 1: Write failing test for stop + console**

Add to `tests/runs.test.ts`:

```typescript
test("hive stop returns advisory message for console sessions", async () => {
  await runCli(["init"]);
  await runCli(["project", "add", "DealSplit", context.repo]);

  const paths = await ensureHiveScaffold();
  const projectPaths = getProjectPaths(paths, "dealsplit");

  let run = await createRunDraft({
    projectId: "dealsplit",
    projectPaths,
    agentId: "console",
    runtime: "claude",
    model: null,
    prompt: "# Console",
    source: "console",
  });
  run = await markRunActive(projectPaths, run, 88888);

  const output = await runCli(["stop", "console"]);

  expect(output).toContain("Console session is interactive");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/runs.test.ts`
Expected: FAIL — currently stop would try to SIGTERM the process.

- [ ] **Step 3: Add console guard in stop.ts**

In `src/commands/stop.ts`, after the `!run.pid` check (line 57-59), add:

```typescript
if (run.source === "console") {
  return `Console session is interactive — exit from within the session. (${run.runId}, pid ${run.pid})`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/stop.ts tests/runs.test.ts
git commit -m "feat: hive stop returns advisory for interactive console sessions"
```

---

## Chunk 3: LLM-Powered Ask

### Task 5: Make hive ask answer the actual question

**Files:**
- Modify: `src/commands/ask.ts`

The approach: `hive ask` (no args) returns the existing fast status digest. `hive ask <question>` makes a single-turn LLM call with the state as context.

- [ ] **Step 1: Add runtime/LLM imports to ask.ts**

Add to imports:

```typescript
import {
  buildLaunchSpec,
  resolveRuntimeHints,
  runLaunchSpec,
} from "../lib/runtime";
import { extractRepoPath } from "../lib/project";
```

- [ ] **Step 2: Extract buildAskDigest as a helper**

Refactor the existing synthesis logic into a pure function at the top of the file. This lets us reuse it for both paths (status-only and LLM).

```typescript
function buildStatusDigest(input: {
  activeProject: string;
  supervisorSection: string;
  boardText: string;
  activeRuns: Awaited<ReturnType<typeof listActiveRuns>>;
  nonAssignMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
  feedBody: string;
}): string {
  return [
    `Project: ${input.activeProject}`,
    section("Supervisor", input.supervisorSection),
    section("Board", input.boardText.trim() ? digestBoard(input.boardText) : "(no board yet)"),
    section("Active Runs", digestRuns(input.activeRuns)),
    section("Open Messages", digestMessages(input.nonAssignMessages)),
    section("Recent Feed", input.feedBody),
  ].join("\n\n");
}
```

- [ ] **Step 3: Add buildAskPrompt for the LLM path**

```typescript
function buildAskPrompt(stateDigest: string, question: string): string {
  return `You are the hive mind — the intelligence managing a team of coding agents. A human operator is asking you a question. Answer based on the system state below.

Be direct and concise. Focus on actionable information. If the state doesn't contain enough information to answer, say so.

## Current System State

${stateDigest}

## Question

${question}`;
}
```

- [ ] **Step 4: Rewrite askCommand to support both paths**

Replace the body of `askCommand` with:

```typescript
export async function askCommand(args: string[]): Promise<string> {
  const question = args.join(" ").trim();
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  const [supervisorState, boardText, openMessages, activeRuns, feedText] = await Promise.all([
    reconcileDetachedSupervisorState(projectPaths),
    Bun.file(projectPaths.board).text().catch(() => ""),
    listOpenProjectMessages(paths.msgDir, activeProject),
    listActiveRuns(projectPaths),
    Bun.file(paths.feed).text().catch(() => ""),
  ]);

  const supervisorRunning =
    supervisorState?.status === "active" && isProcessAlive(supervisorState.pid);
  const supervisorSection = supervisorRunning
    ? `running (pid ${supervisorState.pid}, interval ${supervisorState.intervalSeconds}s, last-pass: ${supervisorState.lastPassAt ?? "none yet"})`
    : "not running";

  const nonAssignMessages = openMessages.filter(
    (m) => m.attributes.type !== "assign",
  );

  const feedSection = formatFeed(feedText, 5);
  const feedBody = feedSection
    .split("\n")
    .filter((line) => !line.startsWith("# "))
    .join("\n")
    .trim() || "(none yet)";

  const digest = buildStatusDigest({
    activeProject,
    supervisorSection,
    boardText,
    activeRuns,
    nonAssignMessages,
    feedBody,
  });

  // No question: return fast synthesized status
  if (!question) {
    return digest;
  }

  // With question: make a single-turn LLM call
  const projectConfig = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const globalConfig = await Bun.file(paths.config).text();
  const hints = resolveRuntimeHints({ globalConfig });
  const prompt = buildAskPrompt(digest, question);
  const spec = buildLaunchSpec({
    runtime: hints.runtime,
    model: hints.model,
    repoPath,
    hiveHome: paths.home,
    prompt,
  });

  const result = await runLaunchSpec(spec, repoPath);

  if (result.code !== null && result.code !== 0) {
    throw new UsageError(`Ask runtime exited with status ${result.code}`);
  }

  return result.visibleOutput || digest;
}
```

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All tests pass. The existing tests don't call `hive ask` with a question that would trigger the LLM path.

- [ ] **Step 6: Commit**

```bash
git add src/commands/ask.ts
git commit -m "feat: hive ask answers questions via single-turn LLM call"
```

---

## Chunk 4: Final Integration Test

### Task 6: Verify the full integration

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 2: Manual verification checklist**

Verify these scenarios work correctly:

1. `hive console` — should start and show in `hive ps` from another terminal
2. `hive console` while one is running — should refuse with duplicate error
3. `hive stop console` — should return advisory message
4. `hive ps` with console + agents — should show both
5. `hive ask` (no args) — should return status digest (fast, no LLM)
6. `hive ask "what needs attention?"` — should return LLM-generated answer
7. `hive run` with console active — supervisor should still launch workers normally

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: integrate console sessions into run ledger, LLM-powered ask

Console sessions are now tracked as run records (source: console) visible
to hive ps. The supervisor ignores them for scope conflicts and parallel
limits. hive stop returns an advisory for console sessions.

hive ask with a question now makes a single-turn LLM call using the
synthesized state as context. Without a question, it returns the fast
status digest as before."
```
