/**
 * Tests for campaign runner lifecycle helpers (TK-104).
 *
 * Verifies that crash artifacts, completion artifacts, and start breadcrumbs
 * are written correctly regardless of which spawn path launches the campaign.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  emitStartBreadcrumb,
  writeCrashArtifacts,
  writeCompletionArtifacts,
} from "../lib/campaign/run-lifecycle";
import type { CampaignResult } from "../lib/campaign/orchestrator";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let hiveHome: string;
let campaignDir: string;
const CAMP_ID = "CAMP-TEST";

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hive-lifecycle-test-"));
  hiveHome = join(tmpDir, ".hive");
  campaignDir = join(hiveHome, "campaigns", CAMP_ID);
  await mkdir(campaignDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// emitStartBreadcrumb
// ---------------------------------------------------------------------------

describe("emitStartBreadcrumb", () => {
  test("writes campaign ID and runner name to stderr", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      emitStartBreadcrumb("CAMP-007", "run-orchestrator");
      expect(errSpy).toHaveBeenCalledTimes(1);
      const msg = errSpy.mock.calls[0]![0] as string;
      expect(msg).toContain("CAMP-007");
      expect(msg).toContain("run-orchestrator");
      expect(msg).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    } finally {
      errSpy.mockRestore();
    }
  });

  test("includes ISO timestamp", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const before = new Date().toISOString().slice(0, 16); // minute precision
      emitStartBreadcrumb("CAMP-001", "run-detached");
      const msg = errSpy.mock.calls[0]![0] as string;
      // Timestamp should be close to "now"
      expect(msg).toContain(before.slice(0, 10)); // at least same date
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// writeCrashArtifacts
// ---------------------------------------------------------------------------

describe("writeCrashArtifacts", () => {
  test("writes status file to 'aborted'", async () => {
    const err = new Error("OAuth keychain access denied");
    await writeCrashArtifacts(CAMP_ID, err, hiveHome);

    const status = await readFile(join(campaignDir, "status"), "utf-8");
    expect(status).toBe("aborted");
  });

  test("writes error.txt with error message", async () => {
    const err = new Error("Module init failed: cannot resolve identity");
    await writeCrashArtifacts(CAMP_ID, err, hiveHome);

    const errorContent = await readFile(join(campaignDir, "error.txt"), "utf-8");
    expect(errorContent).toContain("Module init failed: cannot resolve identity");
  });

  test("includes stack trace in error.txt when available", async () => {
    const err = new Error("assembleIdentity threw");
    await writeCrashArtifacts(CAMP_ID, err, hiveHome);

    const errorContent = await readFile(join(campaignDir, "error.txt"), "utf-8");
    expect(errorContent).toContain("assembleIdentity threw");
    expect(errorContent).toContain("campaign-run-lifecycle.test.ts"); // stack frame
  });

  test("handles string errors gracefully", async () => {
    await writeCrashArtifacts(CAMP_ID, "raw string error", hiveHome);

    const errorContent = await readFile(join(campaignDir, "error.txt"), "utf-8");
    expect(errorContent).toBe("raw string error");
  });

  test("logs to stderr (which goes to orchestrator.log)", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeCrashArtifacts(CAMP_ID, new Error("crash!"), hiveHome);
      expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(errSpy.mock.calls[0]![0]).toContain(CAMP_ID);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("survives when campaign dir doesn't exist", async () => {
    // Should not throw — all writes are best-effort
    await writeCrashArtifacts("CAMP-NONEXISTENT", new Error("boom"), hiveHome);
    // No crash = success
  });
});

// ---------------------------------------------------------------------------
// writeCompletionArtifacts
// ---------------------------------------------------------------------------

describe("writeCompletionArtifacts", () => {
  test("writes result.txt with campaign summary", async () => {
    const result: CampaignResult = {
      campaignId: CAMP_ID,
      terminationReason: "judge_done",
      iterationsCompleted: 5,
      totalCostUsd: 12.34,
      totalTokens: 250000,
      totalWalltimeMs: 3600000,
    };

    await writeCompletionArtifacts(result, hiveHome);

    const content = await readFile(join(campaignDir, "result.txt"), "utf-8");
    expect(content).toContain(CAMP_ID);
    expect(content).toContain("judge_done");
    expect(content).toContain("5");
    expect(content).toContain("$12.34");
    expect(content).toContain("250000");
    expect(content).toContain("3600s");
  });

  test("logs summary to stderr (which goes to orchestrator.log)", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result: CampaignResult = {
        campaignId: CAMP_ID,
        terminationReason: "max_iterations",
        iterationsCompleted: 12,
        totalCostUsd: 40.0,
        totalTokens: 500000,
        totalWalltimeMs: 28800000,
      };

      await writeCompletionArtifacts(result, hiveHome);
      expect(errSpy).toHaveBeenCalledTimes(1);
      const msg = errSpy.mock.calls[0]![0] as string;
      expect(msg).toContain("finished");
    } finally {
      errSpy.mockRestore();
    }
  });

  test("survives when campaign dir doesn't exist", async () => {
    const result: CampaignResult = {
      campaignId: "CAMP-NONEXISTENT",
      terminationReason: "judge_done",
      iterationsCompleted: 1,
      totalCostUsd: 0.5,
      totalTokens: 10000,
      totalWalltimeMs: 60000,
    };

    // Should not throw — write is best-effort
    await writeCompletionArtifacts(result, hiveHome);
  });
});

// ---------------------------------------------------------------------------
// Integration: spawn-and-fail simulation
// ---------------------------------------------------------------------------

describe("spawn-and-fail integration", () => {
  test("a crashing script leaves breadcrumb + error artifacts when stderr is redirected", async () => {
    const { spawn } = await import("node:child_process");
    const { openSync, closeSync } = await import("node:fs");

    // Create a script that emits a breadcrumb then crashes
    const scriptPath = join(tmpDir, "crash-runner.ts");
    await Bun.write(
      scriptPath,
      `
      console.log("--- CAMP-CRASH starting at " + new Date().toISOString() + " ---");
      throw new Error("simulated module-init failure");
      `,
    );

    // Redirect stdout/stderr to a log file (same pattern as campaign spawn)
    const logPath = join(campaignDir, "orchestrator.log");
    const logFd = openSync(logPath, "a");

    const child = spawn("bun", ["run", scriptPath], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    child.unref();
    closeSync(logFd);

    // Wait for the child to exit
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      // Safety timeout
      setTimeout(() => resolve(), 5000);
    });

    // Verify the log file has both the breadcrumb and the error
    expect(existsSync(logPath)).toBe(true);
    const logContent = await readFile(logPath, "utf-8");
    expect(logContent).toContain("CAMP-CRASH starting at");
    expect(logContent).toContain("simulated module-init failure");
  });

  test("a script that fails to parse leaves bun error in log", async () => {
    const { spawn } = await import("node:child_process");
    const { openSync, closeSync } = await import("node:fs");

    // Create a script with a syntax error
    const scriptPath = join(tmpDir, "bad-syntax.ts");
    await Bun.write(scriptPath, "const x: = bad syntax here !!!;");

    const logPath = join(campaignDir, "orchestrator.log");
    const logFd = openSync(logPath, "a");

    const child = spawn("bun", ["run", scriptPath], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    child.unref();
    closeSync(logFd);

    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(() => resolve(), 5000);
    });

    // Bun should have written a parse error to stderr → log file
    expect(existsSync(logPath)).toBe(true);
    const logContent = await readFile(logPath, "utf-8");
    // Bun prints parse errors to stderr — should be captured
    expect(logContent.length).toBeGreaterThan(0);
  });
});
