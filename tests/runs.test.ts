import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { ensureHiveScaffold, getProjectPaths } from "../src/lib/paths";
import {
  createRunDraft,
  finalizeRun,
  getRunOutputPath,
  listRecentRunResults,
  markRunActive,
  readRunOutputTail,
  writeRunResult,
} from "../src/lib/runs";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
};

let context: TestContext;

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-runs-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-09T15:08:00Z";

  return { root, repo, hiveHome };
}

beforeEach(async () => {
  context = await setupContext();
});

afterEach(async () => {
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  await rm(context.root, { recursive: true, force: true });
});

describe("run state", () => {
  test("run helpers write lifecycle records and clear the active pointer on finalize", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");
    let run = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "# Prompt",
      source: "hive launch",
    });

    expect(await Bun.file(run.promptPath).exists()).toBeTrue();
    expect((await Bun.file(run.path).text())).toContain("status: starting");

    run = await markRunActive(projectPaths, run, 81234);

    const activeRaw = await Bun.file(join(projectPaths.runsActiveDir, "alpha.md")).text();

    expect(activeRaw).toContain("status: active");
    expect(activeRaw).toContain("pid: 81234");

    run = await finalizeRun({
      projectPaths,
      run,
      status: "exited",
      exitCode: 0,
    });

    const runRaw = await Bun.file(run.path).text();

    expect(runRaw).toContain("status: exited");
    expect(runRaw).toContain("exit-code: 0");
    expect(await Bun.file(join(projectPaths.runsActiveDir, "alpha.md")).exists()).toBeFalse();

    const result = await writeRunResult(run, {
      assignmentStatusAfterExit: "resolved",
      assignmentResolvedByWorker: true,
      changedFiles: ["src/api/auth.ts"],
      gitSummaryLines: ["M src/api/auth.ts"],
      finalVisibleOutput: "Completed auth endpoint work.",
    });
    const recentResults = await listRecentRunResults(projectPaths, 5);

    expect(result.assignmentStatusAfterExit).toBe("resolved");
    expect(result.assignmentResolvedByWorker).toBeTrue();
    expect(result.changedFiles).toEqual(["src/api/auth.ts"]);
    expect(recentResults[0]?.finalVisibleOutput).toContain("Completed auth endpoint work.");
  });

  test("hive ps shows active and recent runs for the active project", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");
    const activeRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Active Prompt",
      source: "hive launch",
    });

    await markRunActive(projectPaths, activeRun, 81234);

    let recentRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "beta",
      runtime: "claude",
      model: "opus",
      prompt: "# Recent Prompt",
      source: "hive launch",
    });

    recentRun = await finalizeRun({
      projectPaths,
      run: recentRun,
      status: "exited",
      exitCode: 0,
    });

    const output = await runCli(["ps"]);

    expect(output).toContain("Project: dealsplit");
    expect(output).toContain("Active runs: 1");
    expect(output).toContain("alpha | active");
    expect(output).toContain("pid: 81234");
    expect(output).toContain("Recent Runs");
    expect(output).toContain("beta | exited");
    expect(output).toContain("exit: 0");
  });

  test("hive stop signals an active run by agent id", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");
    let run = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Active Prompt",
      source: "hive supervise",
      scope: ["src/api"],
    });

    run = await markRunActive(projectPaths, run, child.pid ?? null);

    const output = await runCli(["stop", "alpha"]);
    const exit = await exitPromise;
    const runRaw = await Bun.file(run.path).text();

    expect(output).toContain(`Signaled alpha (${run.runId}) pid ${child.pid}`);
    expect(exit.signal).toBe("SIGTERM");
    expect(runRaw).toContain("stop-requested-by: human");
    expect(runRaw).toContain("stop-requested-at: 2026-03-09T15:08:00Z");
  });

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

  test("hive watch renders active agents and their visible output tail", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");
    let run = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Active Prompt",
      source: "hive supervise",
      taskId: "HIVE-123",
      scope: ["src/api"],
    });

    run = await markRunActive(projectPaths, run, 81234);
    await Bun.write(
      getRunOutputPath(run),
      ["thinking", "reading PLAN.md", "editing src/api/auth.ts"].join("\n"),
    );

    const outputTail = await readRunOutputTail(run, 2);
    const output = await runCli(["watch", "2", "--once"]);

    expect(outputTail).toEqual(["reading PLAN.md", "editing src/api/auth.ts"]);
    expect(output).toContain("active-agents: 1");
    expect(output).toContain("alpha | active | codex");
    expect(output).toContain("task: HIVE-123");
    expect(output).toContain("editing src/api/auth.ts");
  });
});
