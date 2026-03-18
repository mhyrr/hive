import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMessage } from "../src/lib/messages";
import {
  ensureHiveScaffold,
  ensureProjectScaffold,
  getProjectPaths,
  type HivePaths,
} from "../src/lib/paths";
import {
  createRunDraft,
  finalizeRun,
  markRunActive,
  writeRunResult,
} from "../src/lib/runs";
import { appendTurn, createSession } from "../src/lib/sessions";
import { refreshProjectRuntimeState } from "../src/lib/state";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
  paths: HivePaths;
};

let context: TestContext;

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-state-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-12T14:00:00Z";

  const paths = await ensureHiveScaffold(hiveHome);

  await ensureProjectScaffold(paths, {
    projectId: "myproject",
    projectName: "MyProject",
    repoPath: repo,
  });

  return { root, repo, hiveHome, paths };
}

beforeEach(async () => {
  context = await setupContext();
});

afterEach(async () => {
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  await rm(context.root, { recursive: true, force: true });
});

describe("project runtime state", () => {
  test("creates derived state files and preserves revision when nothing changed", async () => {
    const projectPaths = getProjectPaths(context.paths, "myproject");

    const first = await refreshProjectRuntimeState({
      hivePaths: context.paths,
      projectId: "myproject",
      projectPaths,
    });

    expect(first.changed).toBe(true);
    expect(first.revision.revision).toBe(1);
    expect(await Bun.file(projectPaths.stateRevision).exists()).toBeTrue();
    expect(await Bun.file(projectPaths.stateBoardSummary).exists()).toBeTrue();
    expect(await Bun.file(projectPaths.stateOpenMessages).exists()).toBeTrue();
    expect(await Bun.file(projectPaths.stateRecentResults).exists()).toBeTrue();
    expect(await Bun.file(projectPaths.stateActiveRuns).exists()).toBeTrue();
    expect(await Bun.file(projectPaths.stateHumanInbox).exists()).toBeTrue();
    expect(await Bun.file(projectPaths.stateStewardDelta).exists()).toBeTrue();
    expect(await Bun.file(projectPaths.stateDeltaHistory).exists()).toBeTrue();
    expect(await Bun.file(projectPaths.stateSessionContext).exists()).toBeTrue();

    const second = await refreshProjectRuntimeState({
      hivePaths: context.paths,
      projectId: "myproject",
      projectPaths,
    });

    expect(second.changed).toBe(false);
    expect(second.revision.revision).toBe(1);
  });

  test("increments revision and emits delta packets for board, messages, runs, results, and session context", async () => {
    const projectPaths = getProjectPaths(context.paths, "myproject");

    await refreshProjectRuntimeState({
      hivePaths: context.paths,
      projectId: "myproject",
      projectPaths,
    });

    await Bun.write(
      projectPaths.board,
      `# Board

## Tasks
- HIVE-101 | state monitor | active

## Agents
- alpha | status: active on HIVE-101 | last-active: 14:00

## Blockers
(none)
`,
    );

    const message = await createMessage(context.paths.msgDir, {
      from: "human",
      to: "steward",
      type: "nudge",
      project: "myproject",
      body: "Implement the persistent steward runtime.",
    });

    const session = await createSession({
      sessionsDir: context.paths.sessionsDir,
      project: "myproject",
      runtime: "claude",
      model: null,
      systemPrompt: "HIVE console session",
    });
    await appendTurn({
      sessionsDir: context.paths.sessionsDir,
      sessionId: session.sessionId,
      role: "human",
      content: "Track this restructuring in the live session.",
    });

    let run = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "Implement the state monitor.",
      source: "test",
      sourceMessage: message.filename,
      taskId: "HIVE-101",
      scope: ["src/lib"],
    });
    run = await markRunActive(projectPaths, run, 4242);

    const activeState = await refreshProjectRuntimeState({
      hivePaths: context.paths,
      projectId: "myproject",
      projectPaths,
    });

    expect(activeState.revision.revision).toBe(2);
    expect(activeState.delta.changes.some((change) => change.type === "board-change")).toBeTrue();
    expect(activeState.delta.changes.some((change) => change.type === "human-message")).toBeTrue();
    expect(activeState.delta.changes.some((change) => change.type === "run-started")).toBeTrue();
    expect(activeState.delta.changes.some((change) => change.type === "session-update")).toBeTrue();

    run = await finalizeRun({
      projectPaths,
      run,
      status: "exited",
      exitCode: 0,
    });
    await writeRunResult(run, {
      assignmentStatusAfterExit: "open",
      assignmentResolvedByWorker: false,
      changedFiles: ["src/lib/state.ts"],
      gitSummaryLines: ["Added derived state and revision tracking."],
      finalVisibleOutput: "State monitor landed.",
      cognitiveDigest: {
        provider: "ollama",
        model: "qwen3:4b",
        summary: "State monitor landed and derived state revisions now update correctly.",
        outcome: "success",
        keyDecisions: ["Derived state writes happen after run completion."],
        filesChanged: ["src/lib/state.ts"],
        inputTokens: 92,
        outputTokens: 24,
        totalTokens: 116,
        durationMs: 1200,
      },
    });

    const completedState = await refreshProjectRuntimeState({
      hivePaths: context.paths,
      projectId: "myproject",
      projectPaths,
    });

    expect(completedState.revision.revision).toBe(3);
    expect(completedState.delta.changes.some((change) => change.type === "worker-result")).toBeTrue();
    expect(completedState.delta.changes.some((change) => change.type === "run-finished")).toBeTrue();
    expect(completedState.recentResultsSummary.items[0]?.summary).toBe(
      "State monitor landed and derived state revisions now update correctly.",
    );
    expect(completedState.delta.changes.some((change) =>
      change.summary.includes("State monitor landed and derived state revisions now update correctly."),
    )).toBeTrue();

    const revision = await Bun.file(projectPaths.stateRevision).json() as {
      revision: number;
    };
    const delta = await Bun.file(projectPaths.stateStewardDelta).json() as {
      changes: Array<{ type: string }>;
    };
    const deltaHistory = (await Bun.file(projectPaths.stateDeltaHistory).text()).trim().split("\n");
    const sessionContext = await Bun.file(projectPaths.stateSessionContext).json() as {
      activeSession: { sessionId: string } | null;
      recentTurns: Array<{ role: string }>;
    };

    expect(revision.revision).toBe(3);
    expect(delta.changes.some((change) => change.type === "worker-result")).toBeTrue();
    expect(deltaHistory.length).toBeGreaterThanOrEqual(3);
    expect(sessionContext.activeSession?.sessionId).toBe(session.sessionId);
    expect(sessionContext.recentTurns.some((turn) => turn.role === "human")).toBeTrue();
  });
});
