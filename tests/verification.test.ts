import { describe, expect, test } from "bun:test";

import {
  countPriorAttempts,
  extractVerificationSpec,
  runVerification,
} from "../src/lib/supervisor";
import { HiveMessage } from "../src/lib/messages";
import { RunRecord } from "../src/lib/runs";

function makeMessage(attrs: Record<string, string>): HiveMessage {
  return {
    path: "/tmp/test.md",
    filename: "test.md",
    attributes: {
      from: "orchestrator",
      to: "alpha",
      type: "assign",
      status: "open",
      project: "myproject",
      ...attrs,
    },
    body: "Do the thing.",
    raw: "",
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "20260310-140000Z-alpha",
    projectId: "myproject",
    agentId: "alpha",
    status: "exited",
    runtime: "claude",
    model: null,
    started: "2026-03-10T14:00:00Z",
    ended: "2026-03-10T14:05:00Z",
    exitCode: 0,
    pid: null,
    promptPath: "/tmp/alpha.prompt.md",
    source: "hive supervise",
    sourceMessage: "test.md",
    taskId: null,
    scope: ["src/api"],
    stopRequestedAt: null,
    stopRequestedBy: null,
    path: "/tmp/alpha/run.md",
    ...overrides,
  };
}

describe("extractVerificationSpec", () => {
  test("returns null when no verify attribute", () => {
    const msg = makeMessage({});

    expect(extractVerificationSpec(msg)).toBeNull();
  });

  test("returns null for null message", () => {
    expect(extractVerificationSpec(null)).toBeNull();
  });

  test("extracts verify command with defaults", () => {
    const msg = makeMessage({ verify: "bun test" });
    const spec = extractVerificationSpec(msg);

    expect(spec).toEqual({
      command: "bun test",
      maxAttempts: 1,
      autoRevert: true,
    });
  });

  test("extracts all fields", () => {
    const msg = makeMessage({
      verify: "npm test -- --bail",
      "max-attempts": "3",
      "auto-revert": "true",
    });
    const spec = extractVerificationSpec(msg);

    expect(spec).toEqual({
      command: "npm test -- --bail",
      maxAttempts: 3,
      autoRevert: true,
    });
  });

  test("auto-revert defaults to true", () => {
    const msg = makeMessage({ verify: "bun test" });

    expect(extractVerificationSpec(msg)!.autoRevert).toBeTrue();
  });

  test("auto-revert can be disabled", () => {
    const msg = makeMessage({ verify: "bun test", "auto-revert": "false" });

    expect(extractVerificationSpec(msg)!.autoRevert).toBeFalse();
  });

  test("max-attempts defaults to 1", () => {
    const msg = makeMessage({ verify: "bun test" });

    expect(extractVerificationSpec(msg)!.maxAttempts).toBe(1);
  });

  test("max-attempts floors to 1", () => {
    const msg = makeMessage({ verify: "bun test", "max-attempts": "0" });

    expect(extractVerificationSpec(msg)!.maxAttempts).toBe(1);
  });
});

describe("countPriorAttempts", () => {
  test("returns 0 when no matching runs", () => {
    expect(countPriorAttempts("test.md", [])).toBe(0);
  });

  test("counts matching source messages", () => {
    const runs = [
      makeRun({ sourceMessage: "test.md", runId: "run-1" }),
      makeRun({ sourceMessage: "test.md", runId: "run-2" }),
      makeRun({ sourceMessage: "other.md", runId: "run-3" }),
    ];

    expect(countPriorAttempts("test.md", runs)).toBe(2);
  });
});

describe("runVerification", () => {
  test("returns keep when command passes", () => {
    const outcome = runVerification({
      spec: { command: "true", maxAttempts: 3, autoRevert: true },
      repoPath: "/tmp",
      attempt: 1,
    });

    expect(outcome.action).toBe("keep");

    if (outcome.action === "keep") {
      expect(outcome.verifyResult.passed).toBeTrue();
      expect(outcome.verifyResult.exitCode).toBe(0);
    }
  });

  test("returns retry when command fails and attempts remain", () => {
    const outcome = runVerification({
      spec: { command: "false", maxAttempts: 3, autoRevert: false },
      repoPath: "/tmp",
      attempt: 1,
    });

    expect(outcome.action).toBe("retry");

    if (outcome.action === "retry") {
      expect(outcome.attempt).toBe(1);
      expect(outcome.maxAttempts).toBe(3);
      expect(outcome.verifyResult.passed).toBeFalse();
    }
  });

  test("returns block when command fails and attempts exhausted", () => {
    const outcome = runVerification({
      spec: { command: "false", maxAttempts: 2, autoRevert: false },
      repoPath: "/tmp",
      attempt: 2,
    });

    expect(outcome.action).toBe("block");

    if (outcome.action === "block") {
      expect(outcome.attempt).toBe(2);
      expect(outcome.maxAttempts).toBe(2);
    }
  });

  test("captures verify command output", () => {
    const outcome = runVerification({
      spec: { command: "echo 'hello from verify'", maxAttempts: 1, autoRevert: false },
      repoPath: "/tmp",
      attempt: 1,
    });

    expect(outcome.action).toBe("keep");

    if (outcome.action === "keep") {
      expect(outcome.verifyResult.output).toContain("hello from verify");
    }
  });

  test("captures failing command output", () => {
    const outcome = runVerification({
      spec: { command: "echo 'test failed' && exit 1", maxAttempts: 1, autoRevert: false },
      repoPath: "/tmp",
      attempt: 1,
    });

    expect(outcome.action).toBe("block");

    if (outcome.action === "block") {
      expect(outcome.verifyResult.output).toContain("test failed");
      expect(outcome.verifyResult.exitCode).toBe(1);
    }
  });
});
