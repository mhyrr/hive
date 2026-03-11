import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assessStewardLaunch, scopesConflict, selectWorkerLaunches } from "../src/lib/supervisor";

beforeEach(() => {
  process.env.HIVE_FIXED_NOW = "2026-03-10T14:12:00Z";
});

afterEach(() => {
  delete process.env.HIVE_FIXED_NOW;
});

describe("supervisor assessment", () => {
  test("requests a steward pass when worker results landed after the last orchestrator run", () => {
    const assessment = assessStewardLaunch({
      boardText: `# Board

## Tasks
- 001: Auth endpoint [alpha] [done]

## Agents
### alpha (craftsman -> backend)
status: idle
last-active: 14:52

## Blockers
(none)

## Decisions
(none)
`,
      openMessages: [],
      activeRuns: [],
      recentRuns: [
        {
          runId: "20260310-140000Z-orchestrator",
          projectId: "dealsplit",
          agentId: "orchestrator",
          status: "exited",
          runtime: "codex",
          model: null,
          started: "2026-03-10T14:00:00Z",
          ended: "2026-03-10T14:05:00Z",
          exitCode: 0,
          pid: null,
          promptPath: "/tmp/orch.prompt.md",
          source: "hive supervise",
          sourceMessage: null,
          taskId: null,
          path: "/tmp/orch/run.md",
        },
      ],
      recentRunResults: [
        {
          runId: "20260310-141000Z-alpha",
          agentId: "alpha",
          status: "exited",
          exitCode: 0,
          assignmentMessage: "message.md",
          assignmentStatusAfterExit: "open",
          assignmentResolvedByWorker: false,
          changedFiles: ["src/api/auth.ts"],
          gitSummaryLines: ["M src/api/auth.ts"],
          finalVisibleOutput: "Implemented auth endpoint.",
          ended: "2026-03-10T14:10:00Z",
          path: "/tmp/alpha/result.md",
        },
      ],
      reassessSeconds: 120,
    });

    expect(assessment.shouldLaunch).toBeTrue();
    expect(assessment.reasons).toContain(
      "1 worker run result(s) landed since the last steward pass",
    );
  });

  test("stays idle when the steward is recent and no triggers exist", () => {
    const assessment = assessStewardLaunch({
      boardText: `# Board

## Tasks
- 001: Auth endpoint [done]

## Agents
### alpha (craftsman -> backend)
status: idle
last-active: 15:07

## Blockers
(none)

## Decisions
(none)
`,
      openMessages: [],
      activeRuns: [],
      recentRuns: [
        {
          runId: "20260309-150800Z-orchestrator",
          projectId: "dealsplit",
          agentId: "orchestrator",
          status: "exited",
          runtime: "codex",
          model: null,
          started: "2026-03-10T14:11:00Z",
          ended: "2026-03-10T14:11:00Z",
          exitCode: 0,
          pid: null,
          promptPath: "/tmp/orch.prompt.md",
          source: "hive supervise",
          sourceMessage: null,
          taskId: null,
          path: "/tmp/orch/run.md",
        },
      ],
      recentRunResults: [],
      reassessSeconds: 120,
    });

    expect(assessment.shouldLaunch).toBeFalse();
    expect(assessment.reasons).toEqual([]);
  });

  test("launches non-conflicting auto assignments up to the parallel limit", () => {
    const assessment = selectWorkerLaunches({
      projectConfig: `# Project

launch-default: auto
`,
      plan: `# Plan

## Agents
### alpha (craftsman -> src/api/**, tests/**)
Task: Build the API contract.

### beta (craftsman -> src/web/**)
Task: Build the settings screen.
`,
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
            task: "HIVE-006",
          },
          body: "Build the API contract.",
          raw: "",
        },
        {
          path: "/tmp/beta.md",
          filename: "beta.md",
          attributes: {
            from: "orchestrator",
            to: "beta",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-007",
          },
          body: "Build the settings screen.",
          raw: "",
        },
      ],
      activeRuns: [],
      historicalRuns: [],
      maxParallel: 2,
    });

    expect(assessment.launches.map((launch) => launch.agentId)).toEqual(["alpha", "beta"]);
    expect(assessment.skipped).toEqual([]);
  });

  test("skips manual, conflicting, and already-consumed assignments", () => {
    const assessment = selectWorkerLaunches({
      projectConfig: `# Project

launch-default: auto
`,
      plan: `# Plan

## Agents
### alpha (craftsman -> src/lib/**)
Task: Build the shared library.

### beta (craftsman -> src/lib/foo/**)
Task: Extend the shared library.

### gamma (critic)
Task: Review the change.
`,
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
            task: "HIVE-008",
            launch: "manual",
          },
          body: "Build the shared library.",
          raw: "",
        },
        {
          path: "/tmp/beta.md",
          filename: "beta.md",
          attributes: {
            from: "orchestrator",
            to: "beta",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-009",
          },
          body: "Extend the shared library.",
          raw: "",
        },
        {
          path: "/tmp/gamma.md",
          filename: "gamma.md",
          attributes: {
            from: "orchestrator",
            to: "gamma",
            type: "assign",
            status: "open",
            project: "dealsplit",
            task: "HIVE-010",
          },
          body: "Review the change.",
          raw: "",
        },
      ],
      activeRuns: [
        {
          runId: "20260310-140000Z-delta",
          projectId: "dealsplit",
          agentId: "delta",
          status: "active",
          runtime: "codex",
          model: null,
          started: "2026-03-10T14:00:00Z",
          ended: null,
          exitCode: null,
          pid: 81234,
          promptPath: "/tmp/delta.prompt.md",
          source: "hive supervise",
          sourceMessage: null,
          taskId: "HIVE-001",
          scope: ["src/lib"],
          path: "/tmp/delta/run.md",
        },
      ],
      historicalRuns: [
        {
          runId: "20260310-135000Z-gamma",
          projectId: "dealsplit",
          agentId: "gamma",
          status: "exited",
          runtime: "codex",
          model: null,
          started: "2026-03-10T13:50:00Z",
          ended: "2026-03-10T13:55:00Z",
          exitCode: 0,
          pid: null,
          promptPath: "/tmp/gamma.prompt.md",
          source: "hive supervise",
          sourceMessage: "gamma.md",
          taskId: "HIVE-010",
          scope: null,
          path: "/tmp/gamma/run.md",
        },
      ],
      maxParallel: 2,
    });

    expect(assessment.launches).toHaveLength(0);
    expect(assessment.skipped).toContain("alpha.md: launch mode is manual");
    expect(assessment.skipped).toContain(
      "beta.md: scope src/lib/foo conflicts with an active or queued run",
    );
    expect(assessment.skipped).toContain(
      "gamma.md: assignment already consumed its current launch attempt",
    );
  });

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
});

describe("scope conflicts", () => {
  test("treats null scope as exclusive and respects path boundaries", () => {
    expect(scopesConflict(null, ["src/api"])).toBeTrue();
    expect(scopesConflict(["src/lib"], ["src/lib/foo"])).toBeTrue();
    expect(scopesConflict(["src/lib"], ["src/lib-utils"])).toBeFalse();
  });
});
