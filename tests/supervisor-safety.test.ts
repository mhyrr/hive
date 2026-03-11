import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { ensureHiveScaffold, getProjectPaths } from "../src/lib/paths";
import {
  createRunDraft,
  finalizeRun,
  listActiveRuns,
  markRunActive,
  RunRecord,
} from "../src/lib/runs";
import { scopesConflict, selectWorkerLaunches } from "../src/lib/supervisor";
import { HiveMessage } from "../src/lib/messages";

// ---------------------------------------------------------------------------
// 1. scopesConflict() — comprehensive unit tests
// ---------------------------------------------------------------------------

describe("scopesConflict comprehensive", () => {
  test("non-overlapping scopes do not conflict", () => {
    expect(scopesConflict(["src/api"], ["src/web"])).toBeFalse();
    expect(scopesConflict(["docs"], ["tests"])).toBeFalse();
    expect(scopesConflict(["src/api", "src/db"], ["src/web", "src/ui"])).toBeFalse();
  });

  test("identical scopes conflict", () => {
    expect(scopesConflict(["src/api"], ["src/api"])).toBeTrue();
    expect(scopesConflict(["src/api", "tests"], ["tests", "docs"])).toBeTrue();
  });

  test("parent/child paths conflict", () => {
    expect(scopesConflict(["src/lib"], ["src/lib/foo"])).toBeTrue();
    expect(scopesConflict(["src/lib/foo"], ["src/lib"])).toBeTrue();
    expect(scopesConflict(["src"], ["src/lib/foo/bar"])).toBeTrue();
  });

  test("path-boundary aware: src/lib vs src/lib-utils should NOT conflict", () => {
    expect(scopesConflict(["src/lib"], ["src/lib-utils"])).toBeFalse();
    expect(scopesConflict(["src/lib-utils"], ["src/lib"])).toBeFalse();
    expect(scopesConflict(["src/command"], ["src/commands"])).toBeFalse();
  });

  test("wildcard/exclusive scope (null) conflicts with everything", () => {
    expect(scopesConflict(null, ["src/api"])).toBeTrue();
    expect(scopesConflict(["src/api"], null)).toBeTrue();
    expect(scopesConflict(null, null)).toBeTrue();
  });

  test("empty scope arrays do not conflict with anything", () => {
    expect(scopesConflict([], ["src/api"])).toBeFalse();
    expect(scopesConflict(["src/api"], [])).toBeFalse();
    expect(scopesConflict([], [])).toBeFalse();
  });

  test("one scope empty, one non-empty does not conflict", () => {
    expect(scopesConflict([], ["src/lib"])).toBeFalse();
    expect(scopesConflict(["tests"], [])).toBeFalse();
  });

  test("one scope null, one empty — null is exclusive, conflicts", () => {
    // null means exclusive (no explicit scope), empty array means no roots
    // The function returns true when either is null
    expect(scopesConflict(null, [])).toBeTrue();
    expect(scopesConflict([], null)).toBeTrue();
  });

  test("multi-root scopes with partial overlap conflict", () => {
    expect(scopesConflict(["src/api", "src/db"], ["src/web", "src/db"])).toBeTrue();
  });

  test("multi-root scopes with no overlap do not conflict", () => {
    expect(scopesConflict(["src/api", "src/db"], ["src/web", "src/ui"])).toBeFalse();
  });

  test("trailing slashes are normalized", () => {
    expect(scopesConflict(["src/lib/"], ["src/lib"])).toBeTrue();
    expect(scopesConflict(["src/lib"], ["src/lib/"])).toBeTrue();
    expect(scopesConflict(["src/lib/"], ["src/lib-utils/"])).toBeFalse();
  });

  test("backslash paths are normalized to forward slashes", () => {
    expect(scopesConflict(["src\\lib"], ["src/lib"])).toBeTrue();
    expect(scopesConflict(["src\\lib"], ["src/lib/foo"])).toBeTrue();
    expect(scopesConflict(["src\\lib"], ["src/lib-utils"])).toBeFalse();
  });

  test("deeply nested parent/child still conflicts", () => {
    expect(scopesConflict(["a/b/c"], ["a/b/c/d/e/f"])).toBeTrue();
    expect(scopesConflict(["a/b/c/d/e/f"], ["a/b/c"])).toBeTrue();
  });

  test("sibling paths do not conflict", () => {
    expect(scopesConflict(["src/lib/auth"], ["src/lib/db"])).toBeFalse();
    expect(scopesConflict(["a/b/c"], ["a/b/d"])).toBeFalse();
  });
});

// ---------------------------------------------------------------------------
// 2. One-run-per-assignment safety tests via selectWorkerLaunches()
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<HiveMessage> & { filename: string }): HiveMessage {
  return {
    path: `/tmp/${overrides.filename}`,
    filename: overrides.filename,
    attributes: {
      from: "orchestrator",
      to: "alpha",
      type: "assign",
      status: "open",
      project: "dealsplit",
      task: "HIVE-100",
      ...overrides.attributes,
    },
    body: overrides.body ?? "Do the work.",
    raw: overrides.raw ?? "",
  };
}

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: "20260310-140000Z-alpha",
    projectId: "dealsplit",
    agentId: "alpha",
    status: "active",
    runtime: "codex",
    model: null,
    started: "2026-03-10T14:00:00Z",
    ended: null,
    exitCode: null,
    pid: 81234,
    promptPath: "/tmp/alpha.prompt.md",
    source: "hive supervise",
    sourceMessage: null,
    taskId: null,
    scope: ["src/api"],
    stopRequestedAt: null,
    stopRequestedBy: null,
    path: "/tmp/alpha/run.md",
    ...overrides,
  };
}

const DEFAULT_CONFIG = `# Project\n\nlaunch-default: auto\n`;
const DEFAULT_PLAN = `# Plan\n\n## Agents\n### alpha (craftsman -> src/api/**)\nTask: Build the API.\n\n### beta (craftsman -> src/web/**)\nTask: Build the frontend.\n`;

describe("one-run-per-assignment safety", () => {
  test("assignment does not trigger re-launch if agent already has an active run", () => {
    const result = selectWorkerLaunches({
      projectConfig: DEFAULT_CONFIG,
      plan: DEFAULT_PLAN,
      openMessages: [
        makeMessage({
          filename: "assign-alpha.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-100",
          },
        }),
      ],
      activeRuns: [
        makeRun({
          agentId: "alpha",
          sourceMessage: "different-assignment.md",
          scope: ["src/api"],
        }),
      ],
      historicalRuns: [],
      maxParallel: 3,
    });

    expect(result.launches).toHaveLength(0);
    expect(result.skipped.some((s) => s.includes("already has an active or scheduled run"))).toBeTrue();
  });

  test("same assignment does not cause duplicate launches in the same tick", () => {
    // Two open assignment messages addressed to the SAME agent — only the first should be picked
    const result = selectWorkerLaunches({
      projectConfig: DEFAULT_CONFIG,
      plan: DEFAULT_PLAN,
      openMessages: [
        makeMessage({
          filename: "assign-alpha-1.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-100",
            ts: "2026-03-10T14:00:00Z",
          },
        }),
        makeMessage({
          filename: "assign-alpha-2.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-101",
            ts: "2026-03-10T14:01:00Z",
          },
        }),
      ],
      activeRuns: [],
      historicalRuns: [],
      maxParallel: 3,
    });

    // Only one launch for alpha, second is skipped because the agent is now reserved
    expect(result.launches).toHaveLength(1);
    expect(result.launches[0]!.agentId).toBe("alpha");
    expect(result.skipped.some((s) => s.includes("already has an active or scheduled run"))).toBeTrue();
  });

  test("assignment already consumed by a historical run is not re-launched", () => {
    const result = selectWorkerLaunches({
      projectConfig: DEFAULT_CONFIG,
      plan: DEFAULT_PLAN,
      openMessages: [
        makeMessage({
          filename: "assign-alpha.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-100",
          },
        }),
      ],
      activeRuns: [],
      historicalRuns: [
        makeRun({
          agentId: "alpha",
          status: "exited",
          sourceMessage: "assign-alpha.md",
          ended: "2026-03-10T14:05:00Z",
          exitCode: 0,
          pid: null,
        }),
      ],
      maxParallel: 3,
    });

    expect(result.launches).toHaveLength(0);
    expect(result.skipped.some((s) => s.includes("assignment already consumed"))).toBeTrue();
  });

  test("assignment consumed by an active run (same sourceMessage) is not duplicated", () => {
    const result = selectWorkerLaunches({
      projectConfig: DEFAULT_CONFIG,
      plan: DEFAULT_PLAN,
      openMessages: [
        makeMessage({
          filename: "assign-alpha.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-100",
          },
        }),
      ],
      activeRuns: [
        makeRun({
          agentId: "alpha",
          sourceMessage: "assign-alpha.md",
          scope: ["src/api"],
        }),
      ],
      historicalRuns: [],
      maxParallel: 3,
    });

    expect(result.launches).toHaveLength(0);
    // Both the agent-active and consumed checks should trigger
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  test("no launches when the orchestrator is already active", () => {
    const result = selectWorkerLaunches({
      projectConfig: DEFAULT_CONFIG,
      plan: DEFAULT_PLAN,
      openMessages: [
        makeMessage({
          filename: "assign-alpha.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-100",
          },
        }),
      ],
      activeRuns: [
        makeRun({
          runId: "20260310-orch",
          agentId: "orchestrator",
          scope: null,
        }),
      ],
      historicalRuns: [],
      maxParallel: 3,
    });

    expect(result.launches).toHaveLength(0);
    expect(result.skipped.some((s) => s.includes("orchestrator is already active"))).toBeTrue();
  });

  test("parallel limit prevents excess launches", () => {
    const plan = `# Plan\n\n## Agents\n### alpha (craftsman -> src/api/**)\nTask: A.\n\n### beta (craftsman -> src/web/**)\nTask: B.\n\n### gamma (craftsman -> src/db/**)\nTask: C.\n`;

    const result = selectWorkerLaunches({
      projectConfig: DEFAULT_CONFIG,
      plan,
      openMessages: [
        makeMessage({
          filename: "assign-alpha.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-100",
            ts: "2026-03-10T14:00:00Z",
          },
        }),
        makeMessage({
          filename: "assign-beta.md",
          attributes: {
            from: "orchestrator",
            to: "beta",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-101",
            ts: "2026-03-10T14:01:00Z",
          },
        }),
        makeMessage({
          filename: "assign-gamma.md",
          attributes: {
            from: "orchestrator",
            to: "gamma",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-102",
            ts: "2026-03-10T14:02:00Z",
          },
        }),
      ],
      activeRuns: [],
      historicalRuns: [],
      maxParallel: 2,
    });

    expect(result.launches).toHaveLength(2);
    expect(result.skipped.some((s) => s.includes("parallel limit reached"))).toBeTrue();
  });

  test("scope conflict between queued launches within the same tick prevents both", () => {
    // alpha and beta both want src/lib — only the first should launch
    const plan = `# Plan\n\n## Agents\n### alpha (craftsman -> src/lib/**)\nTask: A.\n\n### beta (craftsman -> src/lib/**)\nTask: B.\n`;

    const result = selectWorkerLaunches({
      projectConfig: DEFAULT_CONFIG,
      plan,
      openMessages: [
        makeMessage({
          filename: "assign-alpha.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-100",
            ts: "2026-03-10T14:00:00Z",
          },
        }),
        makeMessage({
          filename: "assign-beta.md",
          attributes: {
            from: "orchestrator",
            to: "beta",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-101",
            ts: "2026-03-10T14:01:00Z",
          },
        }),
      ],
      activeRuns: [],
      historicalRuns: [],
      maxParallel: 3,
    });

    expect(result.launches).toHaveLength(1);
    expect(result.launches[0]!.agentId).toBe("alpha");
    expect(result.skipped.some((s) => s.includes("scope") && s.includes("conflicts"))).toBeTrue();
  });
});

// ---------------------------------------------------------------------------
// 3. Manual launch adoption — supervisor recognizes manually created runs
// ---------------------------------------------------------------------------

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
};

let context: TestContext;

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-supervisor-safety-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-10T14:12:00Z";

  return { root, repo, hiveHome };
}

describe("manual launch adoption", () => {
  beforeEach(async () => {
    context = await setupContext();
  });

  afterEach(async () => {
    delete process.env.HIVE_HOME;
    delete process.env.HIVE_FIXED_NOW;
    await rm(context.root, { recursive: true, force: true });
  });

  test("a manually created run record in runs/active/ is recognized by listActiveRuns", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");

    // Simulate what `hive launch` does: create a run draft and mark it active
    let manualRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Manual launch prompt",
      source: "hive launch",
      sourceMessage: null,
      taskId: "HIVE-200",
      scope: ["src/api"],
    });

    manualRun = await markRunActive(projectPaths, manualRun, 99999);

    // Verify the supervisor's listActiveRuns sees the manually created run
    const activeRuns = await listActiveRuns(projectPaths);

    expect(activeRuns).toHaveLength(1);
    expect(activeRuns[0]!.agentId).toBe("alpha");
    expect(activeRuns[0]!.source).toBe("hive launch");
    expect(activeRuns[0]!.status).toBe("active");
    expect(activeRuns[0]!.scope).toEqual(["src/api"]);
  });

  test("supervisor does not try to launch a duplicate for an agent with an existing active run", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");

    // Create a manual run for alpha (simulating `hive launch alpha`)
    let manualRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Manual launch prompt",
      source: "hive launch",
      sourceMessage: "assign-alpha.md",
      taskId: "HIVE-200",
      scope: ["src/api"],
    });

    manualRun = await markRunActive(projectPaths, manualRun, 99999);

    // Now simulate what the supervisor's selectWorkerLaunches would decide
    const activeRuns = await listActiveRuns(projectPaths);
    const projectConfig = await Bun.file(projectPaths.config).text();
    const plan = await Bun.file(projectPaths.plan).text();

    const assessment = selectWorkerLaunches({
      projectConfig,
      plan,
      openMessages: [
        makeMessage({
          filename: "assign-alpha.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-200",
            launch: "auto",
            scope: "src/api",
          },
        }),
      ],
      activeRuns,
      historicalRuns: [],
      maxParallel: 3,
    });

    // The supervisor should not try to launch alpha again
    expect(assessment.launches).toHaveLength(0);
    expect(
      assessment.skipped.some((s) => s.includes("alpha") && s.includes("already has an active")),
    ).toBeTrue();
  });

  test("supervisor adopts manual run and allows other non-conflicting agents to launch", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    await Bun.write(
      join(context.hiveHome, "projects", "dealsplit", "PLAN.md"),
      `# Plan: DealSplit

## Goal
Ship it.

## Agents
### orchestrator (steward)
Task: Coordinate.

### alpha (craftsman -> src/api/**)
Task: Build the API.

### beta (craftsman -> src/web/**)
Task: Build the UI.
`,
    );

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");

    // Create a manual run for alpha
    let manualRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Manual launch prompt",
      source: "hive launch",
      sourceMessage: "assign-alpha.md",
      taskId: "HIVE-200",
      scope: ["src/api"],
    });

    manualRun = await markRunActive(projectPaths, manualRun, 99999);
    const activeRuns = await listActiveRuns(projectPaths);
    const projectConfig = await Bun.file(projectPaths.config).text();
    const plan = await Bun.file(projectPaths.plan).text();

    const assessment = selectWorkerLaunches({
      projectConfig,
      plan,
      openMessages: [
        makeMessage({
          filename: "assign-alpha.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-200",
            launch: "auto",
            scope: "src/api",
          },
        }),
        makeMessage({
          filename: "assign-beta.md",
          attributes: {
            from: "orchestrator",
            to: "beta",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-201",
            launch: "auto",
            scope: "src/web",
          },
        }),
      ],
      activeRuns,
      historicalRuns: [],
      maxParallel: 3,
    });

    // Alpha should be skipped (already active from manual launch)
    // Beta should be launchable (non-conflicting scope)
    expect(assessment.launches).toHaveLength(1);
    expect(assessment.launches[0]!.agentId).toBe("beta");
    expect(
      assessment.skipped.some((s) => s.includes("alpha") && s.includes("already has an active")),
    ).toBeTrue();
  });

  test("scope conflict from manual run blocks conflicting auto-launch", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    await Bun.write(
      join(context.hiveHome, "projects", "dealsplit", "PLAN.md"),
      `# Plan: DealSplit

## Goal
Ship it.

## Agents
### orchestrator (steward)
Task: Coordinate.

### alpha (craftsman -> src/lib/**)
Task: Shared code.

### beta (craftsman -> src/lib/foo/**)
Task: Extend shared.
`,
    );

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");

    // Manual run for alpha with scope src/lib
    let manualRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Manual launch prompt",
      source: "hive launch",
      sourceMessage: "assign-alpha.md",
      taskId: "HIVE-300",
      scope: ["src/lib"],
    });

    manualRun = await markRunActive(projectPaths, manualRun, 99999);
    const activeRuns = await listActiveRuns(projectPaths);
    const projectConfig = await Bun.file(projectPaths.config).text();
    const plan = await Bun.file(projectPaths.plan).text();

    const assessment = selectWorkerLaunches({
      projectConfig,
      plan,
      openMessages: [
        makeMessage({
          filename: "assign-beta.md",
          attributes: {
            from: "orchestrator",
            to: "beta",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-301",
            launch: "auto",
            scope: "src/lib/foo",
          },
        }),
      ],
      activeRuns,
      historicalRuns: [],
      maxParallel: 3,
    });

    // Beta's scope (src/lib/foo) conflicts with alpha's scope (src/lib)
    expect(assessment.launches).toHaveLength(0);
    expect(assessment.skipped.some((s) => s.includes("scope") && s.includes("conflicts"))).toBeTrue();
  });

  test("finalized manual run clears active pointer so future launches can proceed", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "DealSplit", context.repo]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "dealsplit");

    // Create and complete a manual run
    let manualRun = await createRunDraft({
      projectId: "dealsplit",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: null,
      prompt: "# Manual launch prompt",
      source: "hive launch",
      sourceMessage: "assign-alpha.md",
      taskId: "HIVE-400",
      scope: ["src/api"],
    });

    manualRun = await markRunActive(projectPaths, manualRun, 99999);

    // Active runs should contain alpha
    let activeRuns = await listActiveRuns(projectPaths);
    expect(activeRuns).toHaveLength(1);

    // Finalize the run (simulating runtime exit)
    await finalizeRun({
      projectPaths,
      run: manualRun,
      status: "exited",
      exitCode: 0,
    });

    // Active runs should now be empty
    activeRuns = await listActiveRuns(projectPaths);
    expect(activeRuns).toHaveLength(0);

    // A new assignment for alpha should be launchable (no active run blocks it)
    const projectConfig = await Bun.file(projectPaths.config).text();
    const plan = await Bun.file(projectPaths.plan).text();

    const assessment = selectWorkerLaunches({
      projectConfig,
      plan,
      openMessages: [
        makeMessage({
          filename: "assign-alpha-new.md",
          attributes: {
            from: "orchestrator",
            to: "alpha",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-401",
            launch: "auto",
            scope: "src/api",
          },
        }),
      ],
      activeRuns,
      historicalRuns: [],
      maxParallel: 3,
    });

    expect(assessment.launches).toHaveLength(1);
    expect(assessment.launches[0]!.agentId).toBe("alpha");
  });
});
