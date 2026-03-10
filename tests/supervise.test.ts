import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { ensureHiveScaffold, getProjectPaths } from "../src/lib/paths";
import {
  createRunDraft,
  finalizeRun,
  listAllRuns,
  listRecentRunResults,
  markRunActive,
  markRunStopRequested,
} from "../src/lib/runs";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
  binDir: string;
  originalPath: string;
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

  return {
    root,
    repo,
    hiveHome,
    binDir,
    originalPath: process.env.PATH ?? "",
  };
}

beforeEach(async () => {
  context = await setupContext();
});

afterEach(async () => {
  process.env.PATH = context.originalPath;
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
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
  test("auto-launches ready worker assignments and records the consumed run", async () => {
    await installFakeCodex();
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);
    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
runtime: codex
`,
    );
    await Bun.write(
      join(context.hiveHome, "projects", "dealsplit", "PLAN.md"),
      `# Plan: DealSplit

## Goal
Ship the auth flow.

## Agents
### orchestrator (steward)
Task: Keep the board current.

### alpha (craftsman -> src/api/**, tests/**)
Task: Build the auth endpoint.
`,
    );
    await Bun.write(
      join(context.hiveHome, "msg", "20260309-150000Z-orchestrator-to-alpha-HIVE-006.md"),
      `---
from: orchestrator
to: alpha
type: assign
status: open
project: dealsplit
task: HIVE-006
launch: auto
scope: src/api,tests
ts: 2026-03-09T15:00:00Z
---

Build the auth endpoint.
`,
    );

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");
    let stewardRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "orchestrator",
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

    expect(output).toContain("Project: dealsplit");
    expect(output).toContain("Worker Launches");
    expect(output).toContain("Completed alpha via codex");
    expect(output).toContain("max-parallel: 2");
    expect(alphaRuns).toHaveLength(1);
    expect(alphaRuns[0]?.sourceMessage).toBe(
      "20260309-150000Z-orchestrator-to-alpha-HIVE-006.md",
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
    await runCli(["project", "add", "DealSplit", context.repo]);
    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
runtime: codex
`,
    );
    await Bun.write(
      join(context.hiveHome, "projects", "dealsplit", "PLAN.md"),
      `# Plan: DealSplit

## Goal
Recover stale runs.

## Agents
### orchestrator (steward)
Task: Keep the board current.
`,
    );

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");
    let stewardRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "orchestrator",
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
      projectId: "dealsplit",
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
      projectId: "dealsplit",
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
});
