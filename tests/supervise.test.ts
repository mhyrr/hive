import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { buildDetachedInvocation, readDetachedSupervisorState } from "../src/lib/detached-supervisor";
import { ensureHiveScaffold, getProjectPaths } from "../src/lib/paths";
import {
  createRunDraft,
  finalizeRun,
  listAllRuns,
  listRecentRunResults,
  markRunActive,
  markRunStopRequested,
  writeRunResult,
} from "../src/lib/runs";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
  binDir: string;
  originalPath: string;
  originalCwd: string;
};

let context: TestContext;

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-supervise-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");
  const binDir = join(root, "bin");

  await mkdir(repo, { recursive: true });
  await mkdir(binDir, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-09T15:08:00Z";
  process.env.HIVE_SCRIPT = join(import.meta.dir, "..", "bin", "hive.ts");

  return {
    root,
    repo,
    hiveHome,
    binDir,
    originalPath: process.env.PATH ?? "",
    originalCwd: process.cwd(),
  };
}

beforeEach(async () => {
  context = await setupContext();
});

afterEach(async () => {
  process.env.PATH = context.originalPath;
  process.chdir(context.originalCwd);
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  delete process.env.HIVE_SCRIPT;
  await rm(context.root, { recursive: true, force: true });
});

async function installFakeCodex(): Promise<void> {
  const codexPath = join(context.binDir, "codex");

  await Bun.write(
    codexPath,
    `#!/bin/sh
printf 'mock codex run complete\\n'
exit 0
`,
  );
  await chmod(codexPath, 0o755);
  process.env.PATH = `${context.binDir}:${context.originalPath}`;
}

describe("hive supervise", () => {
  test("detached supervisor invocation reuses the current script in Bun dev mode", () => {
    const invocation = buildDetachedInvocation(["supervise", "--detach"], {
      execPath: "/opt/homebrew/bin/bun",
      argv: ["/opt/homebrew/bin/bun", "/Users/mhyrr/work/hive/bin/hive.ts", "gateway"],
    });

    expect(invocation).toEqual({
      command: "/opt/homebrew/bin/bun",
      args: ["/Users/mhyrr/work/hive/bin/hive.ts", "supervise", "--detach"],
    });
  });

  test("detached supervisor invocation reuses the compiled binary in compiled mode", () => {
    const invocation = buildDetachedInvocation(["supervise", "--detach"], {
      execPath: "/Users/mhyrr/bin/hive",
      argv: ["/Users/mhyrr/bin/hive", "gateway"],
    });

    expect(invocation).toEqual({
      command: "/Users/mhyrr/bin/hive",
      args: ["supervise", "--detach"],
    });
  });

  test("detached supervisor start/status/stop persists state on disk", async () => {
    await installFakeCodex();
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);
    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
runtime: codex
`,
    );

    const startOutput = await runCli([
      "supervise",
      "--detach",
      "--interval",
      "1",
      "--max-parallel",
      "2",
    ]);

    expect(startOutput).toContain("Started detached supervisor for myproject");
    expect(startOutput).toContain("interval: 1s");
    expect(startOutput).toContain("max-parallel: 2");

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");

    let state = await readDetachedSupervisorState(projectPaths);
    let attempts = 0;

    while ((!state || state.status !== "active" || !state.lastPassAt) && attempts < 40) {
      await Bun.sleep(150);
      state = await readDetachedSupervisorState(projectPaths);
      attempts += 1;
    }

    expect(state).not.toBeNull();
    expect(state?.status).toBe("active");
    expect(state?.pid).toBeNumber();
    expect(state?.lastPassAt).not.toBeNull();
    expect(await Bun.file(join(projectPaths.supervisorDir, "detached.log")).exists()).toBeTrue();

    const statusOutput = await runCli(["supervise", "status"]);

    expect(statusOutput).toContain("Detached Supervisor");
    expect(statusOutput).toContain("status: active");
    expect(statusOutput).toContain("last-pass:");

    const stopOutput = await runCli(["supervise", "stop"]);

    expect(stopOutput).toContain("Signaled detached supervisor pid");

    attempts = 0;

    do {
      await Bun.sleep(150);
      state = await readDetachedSupervisorState(projectPaths);
      attempts += 1;
    } while (state?.status !== "stopped" && attempts < 20);

    expect(state?.status).toBe("stopped");
    expect(state?.pid).toBeNull();

    const stoppedOutput = await runCli(["supervise", "status"]);

    expect(stoppedOutput).toContain("status: stopped");
  });

  test("detached supervisor start works outside the repo-root cwd", async () => {
    await installFakeCodex();
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);
    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
runtime: codex
`,
    );
    process.chdir(context.root);

    const startOutput = await runCli([
      "supervise",
      "--detach",
      "--interval",
      "1",
      "--max-parallel",
      "1",
    ]);

    expect(startOutput).toContain("Started detached supervisor for myproject");

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");
    let state = await readDetachedSupervisorState(projectPaths);
    let attempts = 0;

    while ((!state || state.status !== "active" || !state.lastPassAt) && attempts < 40) {
      await Bun.sleep(150);
      state = await readDetachedSupervisorState(projectPaths);
      attempts += 1;
    }

    expect(state?.status).toBe("active");
    expect(state?.lastPassAt).not.toBeNull();

    await runCli(["supervise", "stop"]);
  });

  test("auto-launches ready worker assignments and records the consumed run", async () => {
    await installFakeCodex();
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);
    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
runtime: codex
`,
    );
    await Bun.write(
      join(context.hiveHome, "projects", "myproject", "PLAN.md"),
      `# Plan: MyProject

## Goal
Ship the auth flow.

## Agents
### steward (steward)
Task: Keep the board current.

### alpha (craftsman -> src/api/**, tests/**)
Task: Build the auth endpoint.
`,
    );
    await Bun.write(
      join(context.hiveHome, "msg", "20260309-150000Z-steward-to-alpha-HIVE-006.md"),
      `---
from: steward
to: alpha
type: assign
status: open
project: myproject
task: HIVE-006
launch: auto
scope: src/api,tests
ts: 2026-03-09T15:00:00Z
---

Build the auth endpoint.
`,
    );

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");
    let stewardRun = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "steward",
      runtime: "codex",
      model: null,
      prompt: "# Steward Prompt",
      source: "hive supervise",
      scope: null,
    });

    stewardRun = await finalizeRun({
      projectPaths,
      run: stewardRun,
      status: "exited",
      exitCode: 0,
    });

    const output = await runCli(["supervise", "--once", "--max-parallel", "2"]);
    const allRuns = await listAllRuns(projectPaths);
    const alphaRuns = allRuns.filter((run) => run.agentId === "alpha");

    expect(output).toContain("Project: myproject");
    expect(output).toContain("Worker Launches");
    expect(output).toContain("Completed alpha via codex");
    expect(output).toContain("max-parallel: 2");
    expect(alphaRuns).toHaveLength(1);
    expect(alphaRuns[0]?.sourceMessage).toBe(
      "20260309-150000Z-steward-to-alpha-HIVE-006.md",
    );
    expect(alphaRuns[0]?.scope).toEqual(["src/api", "tests"]);

    const secondOutput = await runCli(["supervise", "--once", "--max-parallel", "2"]);
    const secondRuns = (await listAllRuns(projectPaths)).filter((run) => run.agentId === "alpha");

    expect(secondRuns).toHaveLength(1);
    expect(secondOutput).toContain(
      "assignment already consumed its current launch attempt",
    );
  });

  test("recovers stale and cancelled active runs from on-disk state", async () => {
    await installFakeCodex();
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);
    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
runtime: codex
`,
    );
    await Bun.write(
      join(context.hiveHome, "projects", "myproject", "PLAN.md"),
      `# Plan: MyProject

## Goal
Recover stale runs.

## Agents
### steward (steward)
Task: Keep the board current.
`,
    );
    await Bun.write(
      join(context.hiveHome, "projects", "myproject", "BOARD.md"),
      `# Board: MyProject

## Agents
- steward | status: idle | role: steward
- alpha | status: idle | role: worker
`,
    );

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");
    let stewardRun = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "steward",
      runtime: "codex",
      model: null,
      prompt: "# Steward Prompt",
      source: "hive supervise",
      scope: null,
    });

    stewardRun = await finalizeRun({
      projectPaths,
      run: stewardRun,
      status: "exited",
      exitCode: 0,
    });

    let alphaRun = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Alpha Prompt",
      source: "hive launch",
      scope: ["src/api"],
    });

    alphaRun = await markRunActive(projectPaths, alphaRun, 999999);

    let betaRun = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "beta",
      runtime: "codex",
      model: null,
      prompt: "# Beta Prompt",
      source: "hive launch",
      scope: ["src/web"],
    });

    betaRun = await markRunActive(projectPaths, betaRun, 999998);
    await markRunStopRequested(betaRun, "human");

    const output = await runCli(["supervise", "--once"]);
    const allRuns = await listAllRuns(projectPaths);
    const results = await listRecentRunResults(projectPaths, 10);
    const recoveredAlpha = allRuns.find((run) => run.runId === alphaRun.runId);
    const recoveredBeta = allRuns.find((run) => run.runId === betaRun.runId);
    const alphaResult = results.find((result) => result.runId === alphaRun.runId);
    const betaResult = results.find((result) => result.runId === betaRun.runId);

    expect(output).toContain("Recovered Runs");
    expect(output).toContain(`alpha | failed | ${alphaRun.runId}`);
    expect(output).toContain(`beta | cancelled | ${betaRun.runId}`);
    expect(recoveredAlpha?.status).toBe("failed");
    expect(recoveredBeta?.status).toBe("cancelled");
    expect(alphaResult?.gitSummaryLines[0]).toContain("no longer alive");
    expect(betaResult?.finalVisibleOutput).toContain("cancelled run");
  });

  test("diff triage suppresses routine worker results before waking the steward", async () => {
    await installFakeCodex();
    await runCli(["init"]);
    await runCli(["project", "add", "MyProject", context.repo]);
    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
runtime: codex
`,
    );
    await Bun.write(
      join(context.hiveHome, "projects", "myproject", "PLAN.md"),
      `# Plan: MyProject

## Goal
Keep routine test churn from waking the steward.

## Agents
### steward (steward)
Task: Keep the board current.
`,
    );
    await Bun.write(
      join(context.hiveHome, "projects", "myproject", "BOARD.md"),
      `# Board: MyProject

## Agents
- steward | status: idle | role: steward
- alpha | status: idle | role: worker
`,
    );

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "myproject");

    process.env.HIVE_FIXED_NOW = "2026-03-09T15:04:00Z";
    let stewardRun = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "steward",
      runtime: "codex",
      model: null,
      prompt: "# Steward Prompt",
      source: "hive supervise",
      scope: null,
    });

    stewardRun = await finalizeRun({
      projectPaths,
      run: stewardRun,
      status: "exited",
      exitCode: 0,
    });

    process.env.HIVE_FIXED_NOW = "2026-03-09T15:05:00Z";
    let alphaRun = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Alpha Prompt",
      source: "hive launch",
      scope: ["tests"],
    });

    alphaRun = await finalizeRun({
      projectPaths,
      run: alphaRun,
      status: "exited",
      exitCode: 0,
    });

    await writeRunResult(alphaRun, {
      changedFiles: ["tests/state.test.ts"],
      gitSummaryLines: ["M tests/state.test.ts"],
      finalVisibleOutput: "Updated the regression coverage.",
    });

    process.env.HIVE_FIXED_NOW = "2026-03-09T15:05:30Z";
    const output = await runCli(["supervise", "--once"]);
    const allRuns = await listAllRuns(projectPaths);
    const orchestratorRuns = allRuns.filter((run) => run.agentId === "steward");

    expect(output).toContain("Decision: no action");
    expect(output).toContain("Diff Triage");
    expect(output).toContain("alpha | routine");
    expect(orchestratorRuns).toHaveLength(1);
  });
});
