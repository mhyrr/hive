import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  extractVerificationSpec,
  runVerification,
} from "../src/lib/supervisor";
import { runVerifyCommand, revertWorkerChanges } from "../src/lib/git";
import type { HiveMessage } from "../src/lib/messages";

function makeMessage(attributes: Record<string, string>): HiveMessage {
  return {
    path: "/tmp/test.md",
    filename: "test.md",
    attributes,
    body: "test body",
    raw: "",
  };
}

describe("extractVerificationSpec", () => {
  test("returns null for null message", () => {
    expect(extractVerificationSpec(null)).toBeNull();
  });

  test("returns null when no verify attribute", () => {
    expect(extractVerificationSpec(makeMessage({ type: "assign" }))).toBeNull();
  });

  test("returns spec with defaults", () => {
    const spec = extractVerificationSpec(makeMessage({ verify: "bun test" }));

    expect(spec).toEqual({
      command: "bun test",
      maxAttempts: 1,
      autoRevert: true,
    });
  });

  test("parses all fields", () => {
    const spec = extractVerificationSpec(
      makeMessage({
        verify: "make check",
        "max-attempts": "3",
        "auto-revert": "false",
      }),
    );

    expect(spec).toEqual({
      command: "make check",
      maxAttempts: 3,
      autoRevert: false,
    });
  });

  test("floors max-attempts to 1", () => {
    const spec = extractVerificationSpec(
      makeMessage({ verify: "test", "max-attempts": "0" }),
    );

    expect(spec!.maxAttempts).toBe(1);
  });

  test("handles non-numeric max-attempts", () => {
    const spec = extractVerificationSpec(
      makeMessage({ verify: "test", "max-attempts": "abc" }),
    );

    expect(spec!.maxAttempts).toBe(1);
  });

  test("auto-revert defaults to true", () => {
    const spec = extractVerificationSpec(makeMessage({ verify: "test" }));

    expect(spec!.autoRevert).toBe(true);
  });

  test("auto-revert is case insensitive", () => {
    const spec = extractVerificationSpec(
      makeMessage({ verify: "test", "auto-revert": "False" }),
    );

    expect(spec!.autoRevert).toBe(false);
  });
});

describe("runVerifyCommand", () => {
  test("passes with exit code 0", () => {
    const result = runVerifyCommand("/tmp", "true");

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("fails with non-zero exit code", () => {
    const result = runVerifyCommand("/tmp", "false");

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test("captures stdout", () => {
    const result = runVerifyCommand("/tmp", "echo hello-verify");

    expect(result.passed).toBe(true);
    expect(result.output).toContain("hello-verify");
  });

  test("captures stderr", () => {
    const result = runVerifyCommand("/tmp", "echo error-output >&2 && false");

    expect(result.passed).toBe(false);
    expect(result.output).toContain("error-output");
  });

  test("truncates long output to 2000 chars", () => {
    const result = runVerifyCommand("/tmp", "python3 -c \"print('x' * 3000)\"");

    expect(result.output.length).toBeLessThanOrEqual(2000);
  });
});

describe("revertWorkerChanges", () => {
  test("reverts scoped changes in a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-verify-"));

    execSync("git init && git commit --allow-empty -m init", { cwd: dir });
    execSync("mkdir -p src/auth", { cwd: dir });
    writeFileSync(join(dir, "src/auth/dirty.txt"), "uncommitted");

    const result = revertWorkerChanges(dir, ["src/auth"]);

    expect(result.reverted).toBe(true);
    expect(result.summary).toContain("src/auth");
  });

  test("refuses to revert when no scope is provided", () => {
    const result = revertWorkerChanges("/tmp", null);

    expect(result.reverted).toBe(false);
    expect(result.summary).toContain("no scope declared");
  });

  test("refuses to revert with empty scope", () => {
    const result = revertWorkerChanges("/tmp", []);

    expect(result.reverted).toBe(false);
    expect(result.summary).toContain("no scope declared");
  });

  test("preserves files outside scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-verify-"));

    execSync("git init && git commit --allow-empty -m init", { cwd: dir });
    execSync("mkdir -p src/auth src/api", { cwd: dir });
    writeFileSync(join(dir, "src/auth/scoped.txt"), "in scope");
    writeFileSync(join(dir, "src/api/unrelated.txt"), "out of scope");

    revertWorkerChanges(dir, ["src/auth"]);

    const unrelatedExists = Bun.file(join(dir, "src/api/unrelated.txt")).size > 0;

    expect(unrelatedExists).toBe(true);
  });
});

describe("runVerification", () => {
  test("returns keep when command passes", () => {
    const outcome = runVerification({
      spec: { command: "true", maxAttempts: 1, autoRevert: true },
      repoPath: "/tmp",
      attempt: 1,
      scope: ["src"],
    });

    expect(outcome.action).toBe("keep");
    expect(outcome.verifyResult.passed).toBe(true);
  });

  test("returns retry when command fails and attempts remain", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-verify-"));

    execSync("git init && git commit --allow-empty -m init", { cwd: dir });
    execSync("mkdir -p src", { cwd: dir });

    const outcome = runVerification({
      spec: { command: "false", maxAttempts: 3, autoRevert: true },
      repoPath: dir,
      attempt: 1,
      scope: ["src"],
    });

    expect(outcome.action).toBe("retry");

    if (outcome.action === "retry") {
      expect(outcome.attempt).toBe(1);
      expect(outcome.maxAttempts).toBe(3);
      expect(outcome.reverted).toBe(true);
    }
  });

  test("returns block when command fails and attempts exhausted", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-verify-"));

    execSync("git init && git commit --allow-empty -m init", { cwd: dir });
    execSync("mkdir -p src", { cwd: dir });

    const outcome = runVerification({
      spec: { command: "false", maxAttempts: 2, autoRevert: true },
      repoPath: dir,
      attempt: 2,
      scope: ["src"],
    });

    expect(outcome.action).toBe("block");

    if (outcome.action === "block") {
      expect(outcome.attempt).toBe(2);
      expect(outcome.maxAttempts).toBe(2);
      expect(outcome.reverted).toBe(true);
    }
  });

  test("skips revert when auto-revert is false", () => {
    const outcome = runVerification({
      spec: { command: "false", maxAttempts: 3, autoRevert: false },
      repoPath: "/tmp",
      attempt: 1,
      scope: ["src"],
    });

    expect(outcome.action).toBe("retry");

    if (outcome.action === "retry") {
      expect(outcome.revertSummary).toBe("auto-revert disabled");
      expect(outcome.reverted).toBe(false);
    }
  });

  test("reports reverted=false when no scope provided", () => {
    const outcome = runVerification({
      spec: { command: "false", maxAttempts: 3, autoRevert: true },
      repoPath: "/tmp",
      attempt: 1,
      scope: null,
    });

    expect(outcome.action).toBe("retry");

    if (outcome.action === "retry") {
      expect(outcome.reverted).toBe(false);
      expect(outcome.revertSummary).toContain("no scope declared");
    }
  });

  test("captures verify output on failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-verify-"));

    execSync("git init && git commit --allow-empty -m init", { cwd: dir });
    execSync("mkdir -p src", { cwd: dir });

    const outcome = runVerification({
      spec: { command: "echo 'test failed: assertion error' && exit 1", maxAttempts: 2, autoRevert: true },
      repoPath: dir,
      attempt: 1,
      scope: ["src"],
    });

    expect(outcome.action).toBe("retry");
    expect(outcome.verifyResult.output).toContain("test failed: assertion error");
  });
});
