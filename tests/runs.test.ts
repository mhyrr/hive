import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { createMessage, listMessages } from "../src/lib/messages";
import { ensureHiveScaffold, getProjectPaths } from "../src/lib/paths";
import { parseModelPool } from "../src/lib/project";
import {
  createRunDraft,
  finalizeRun,
  getRunOutputPath,
  listRecentRunResults,
  markRunActive,
  readActiveRun,
  readRunOutputTail,
  reconcileActiveConsoleRun,
  writeRunResult,
} from "../src/lib/runs";
import { createDelegationTools } from "../src/lib/steward/tools/delegate";

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
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");
    let run = await createRunDraft({
      projectId: "myproject",
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
      cognitiveDigest: {
        provider: "ollama",
        model: "qwen3:4b",
        summary: "Auth endpoint shipped with the handler and tests updated.",
        outcome: "success",
        keyDecisions: ["Kept the existing auth boundary intact."],
        filesChanged: ["src/api/auth.ts"],
        inputTokens: 88,
        outputTokens: 22,
        totalTokens: 110,
        durationMs: 1400,
      },
      authMode: "subscription",
      inputTokens: 1200,
      outputTokens: 220,
      cacheReadInputTokens: 80,
      totalTokens: 1500,
    });
    const recentResults = await listRecentRunResults(projectPaths, 5);

    expect(result.assignmentStatusAfterExit).toBe("resolved");
    expect(result.assignmentResolvedByWorker).toBeTrue();
    expect(result.changedFiles).toEqual(["src/api/auth.ts"]);
    expect(result.authMode).toBe("subscription");
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(220);
    expect(result.cacheReadInputTokens).toBe(80);
    expect(result.totalTokens).toBe(1500);
    expect(result.cognitiveDigest?.model).toBe("qwen3:4b");
    expect(result.cognitiveDigest?.summary).toContain("Auth endpoint shipped");
    expect(recentResults[0]?.finalVisibleOutput).toContain("Completed auth endpoint work.");
    expect(recentResults[0]?.authMode).toBe("subscription");
    expect(recentResults[0]?.totalTokens).toBe(1500);
    expect(recentResults[0]?.cognitiveDigest?.summary).toContain("Auth endpoint shipped");
  });

  test("hive ps shows active and recent runs for the active project", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");
    const activeRun = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Active Prompt",
      source: "hive launch",
    });

    await markRunActive(projectPaths, activeRun, 81234);

    let recentRun = await createRunDraft({
      projectId: "myproject",
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

    expect(output).toContain("Project: myproject");
    expect(output).toContain("Active runs: 1");
    expect(output).toContain("alpha | active");
    expect(output).toContain("pid: 81234");
    expect(output).toContain("Recent Runs");
    expect(output).toContain("beta | exited");
    expect(output).toContain("exit: 0");
  });

  test("hive stop signals an active run by agent id", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);

    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");
    let run = await createRunDraft({
      projectId: "myproject",
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
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");

    let run = await createRunDraft({
      projectId: "myproject",
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

  test("stale console sessions are reconciled and stop blocking new turns", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");

    let run = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "console",
      runtime: "claude",
      model: null,
      prompt: "# Console",
      source: "console",
    });
    run = await markRunActive(projectPaths, run, 99999);
    await Bun.write(getRunOutputPath(run), "Planning the reply\nChecking the latest context\n");

    const reconciled = await reconcileActiveConsoleRun(projectPaths);
    const recentResults = await listRecentRunResults(projectPaths, 5);
    const activeRun = await readActiveRun(projectPaths, "console");

    expect(reconciled).toBeNull();
    expect(activeRun).toBeNull();
    expect(await Bun.file(join(projectPaths.runsActiveDir, "console.md")).exists()).toBeFalse();
    expect((await Bun.file(run.path).text())).toContain("status: failed");
    expect(recentResults[0]?.agentId).toBe("console");
    expect(recentResults[0]?.status).toBe("failed");
    expect(recentResults[0]?.finalVisibleOutput).toContain("Checking the latest context");
  });

  test("hive ps shows console sessions alongside agent runs", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");

    const consoleRun = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "console",
      runtime: "claude",
      model: null,
      prompt: "# Console",
      source: "console",
    });
    await markRunActive(projectPaths, consoleRun, process.pid);

    const agentRun = await createRunDraft({
      projectId: "myproject",
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
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");

    let run = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "console",
      runtime: "claude",
      model: null,
      prompt: "# Console",
      source: "console",
    });
    run = await markRunActive(projectPaths, run, process.pid);

    const output = await runCli(["stop", "console"]);

    expect(output).toContain("Console session is interactive");
  });

  test("worker-runtime and worker-model propagate from RunRecord to RunResult", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");

    // Create a run that simulates a codex worker
    let run = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "critic-codex-a1b2",
      runtime: "codex",
      model: "codex",
      prompt: "# Review the cog branch",
      source: "hive launch",
    });
    run = await markRunActive(projectPaths, run, 55555);
    run = await finalizeRun({
      projectPaths,
      run,
      status: "exited",
      exitCode: 0,
    });

    // Write result with a cognitive digest that uses haiku (the Tier-1 summarizer)
    const result = await writeRunResult(run, {
      changedFiles: [],
      gitSummaryLines: [],
      finalVisibleOutput: "Approved with notes.",
      cognitiveDigest: {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        summary: "Critic approved the cog branch cleanup.",
        outcome: "success",
        keyDecisions: [],
        filesChanged: [],
        inputTokens: 50,
        outputTokens: 20,
        totalTokens: 70,
        durationMs: 800,
      },
    });

    // The execution model must be codex, NOT the cognitive digest model
    expect(result.runtime).toBe("codex");
    expect(result.model).toBe("codex");

    // The cognitive digest model is the Tier-1 summarizer — distinct from the worker
    expect(result.cognitiveDigest?.model).toBe("claude-haiku-4-5-20251001");
    expect(result.cognitiveDigest?.provider).toBe("anthropic");

    // Verify persistence: re-read from disk
    const persisted = (await listRecentRunResults(projectPaths, 1))[0];
    expect(persisted?.runtime).toBe("codex");
    expect(persisted?.model).toBe("codex");
    expect(persisted?.cognitiveDigest?.model).toBe("claude-haiku-4-5-20251001");
  });

  test("delegate tool writes assignment with model pool runtime and model", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();

    const globalConfig = `# HIVE Config

## Model Pool
- opus: claude, claude-opus-4-1-20250805, High-quality reasoning
- codex: codex, codex, OpenAI Codex CLI
- haiku: claude, claude-haiku-4-5-20251001, Fast triage
`;

    const tools = createDelegationTools({
      msgDir: paths.msgDir,
      projectId: "myproject",
      globalConfig,
    });

    const delegateTool = tools.find((t) => t.name === "delegate")!;

    // Steward delegates a critic with "codex" from the pool
    const output = await delegateTool.execute("call-1", {
      model: "codex",
      persona: "critic",
      task: "review-cog-branch",
      scope: "src/lib",
      brief: "Review the cog branch cleanup for correctness.",
    });

    // The output should confirm the pool entry was used
    expect(output).toContain("codex (codex, codex)");
    expect(output).toContain("persona: critic");

    // Read back the assignment message and verify attributes
    const messages = await listMessages(paths.msgDir);
    const assignment = messages.find((m) => m.attributes.type === "assign");
    expect(assignment).toBeDefined();
    expect(assignment!.attributes.runtime).toBe("codex");
    expect(assignment!.attributes.model).toBe("codex");
    expect(assignment!.attributes.persona).toBe("critic");

    // Now simulate what launch.ts does: read assignment, create run, write result
    const projectPaths = getProjectPaths(paths, "myproject");
    let run = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: assignment!.attributes.to,
      runtime: assignment!.attributes.runtime as "codex",
      model: assignment!.attributes.model,
      prompt: "# Prompt from assignment",
      source: "hive launch",
      sourceMessage: assignment!.filename,
    });
    run = await markRunActive(projectPaths, run, 44444);
    run = await finalizeRun({
      projectPaths,
      run,
      status: "exited",
      exitCode: 0,
    });

    const result = await writeRunResult(run, {
      changedFiles: [],
      gitSummaryLines: [],
      finalVisibleOutput: "Approved.",
    });

    // Full chain verified: pool entry → assignment → run → result
    expect(result.runtime).toBe("codex");
    expect(result.model).toBe("codex");
    expect(result.agentId).toContain("critic-codex-");
  });

  test("delegate tool rejects unknown model pool names", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();

    const globalConfig = `# HIVE Config

## Model Pool
- opus: claude, claude-opus-4-1-20250805, High-quality reasoning
`;

    const tools = createDelegationTools({
      msgDir: paths.msgDir,
      projectId: "myproject",
      globalConfig,
    });

    const delegateTool = tools.find((t) => t.name === "delegate")!;

    // Requesting a model not in the pool should throw
    await expect(
      delegateTool.execute("call-2", {
        model: "gpt-9000",
        persona: "scout",
        task: "explore",
        scope: "*",
        brief: "Look around.",
      }),
    ).rejects.toThrow("Unknown model 'gpt-9000'");
  });

  test("hive watch renders active agents and their visible output tail", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");
    let run = await createRunDraft({
      projectId: "myproject",
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
