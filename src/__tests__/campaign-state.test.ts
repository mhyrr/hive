import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  initCampaign,
  readCheckpoint,
  writeCheckpoint,
  appendScorecardRow,
  readScorecard,
  latestPlan,
  writePlan,
  freezePrefix,
  readFrozenPrefix,
  readStatus,
  writeStatus,
  createIteration,
  iterationDir,
  readCampaignState,
  teardownWorktree,
  listCampaigns,
  readPid,
  isPidAlive,
  resolveStatus,
  detectAndFixStaleStatus,
  type ScorecardRow,
  type CampaignState,
} from "../lib/campaign/state";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let hiveHome: string;
let repoPath: string;

function makeRow(n: number, overrides?: Partial<ScorecardRow>): ScorecardRow {
  return {
    iteration_n: n,
    started_at: `2026-05-09T0${n}:00:00Z`,
    ended_at: `2026-05-09T0${n}:25:00Z`,
    exit_reason: "natural",
    judge_decision: "continue",
    tokens_used: 50000 * n,
    cost_usd: 0.15 * n,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hive-campaign-test-"));
  hiveHome = join(tmpDir, ".hive");
  repoPath = join(tmpDir, "repo");

  // Create a bare-minimum git repo for worktree tests
  await mkdir(repoPath, { recursive: true });
  execSync("git init && git commit --allow-empty -m 'init'", {
    cwd: repoPath,
    stdio: "pipe",
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// initCampaign
// ---------------------------------------------------------------------------

describe("initCampaign", () => {
  test("creates directory tree with expected structure", async () => {
    const id = await initCampaign({
      goal: "Build the feature",
      repoPath,
      hiveHome,
    });

    expect(id).toBe("CAMP-001");

    const dir = join(hiveHome, "campaigns", id);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "iterations"))).toBe(true);
    expect(existsSync(join(dir, "workspace"))).toBe(true);
    expect(existsSync(join(dir, "status"))).toBe(true);
    expect(existsSync(join(dir, "frozen-prefix.md"))).toBe(true);
  });

  test("creates a git worktree on a campaign branch", async () => {
    const id = await initCampaign({
      goal: "Test worktree",
      repoPath,
      hiveHome,
    });

    const workspacePath = join(hiveHome, "campaigns", id, "workspace");

    // Verify it's a git working tree
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspacePath,
      encoding: "utf-8",
    }).trim();

    expect(branch).toBe(`campaign/${id}`);
  });

  test("sequential IDs increment correctly", async () => {
    const id1 = await initCampaign({ goal: "First", repoPath, hiveHome });
    const id2 = await initCampaign({ goal: "Second", repoPath, hiveHome });
    const id3 = await initCampaign({ goal: "Third", repoPath, hiveHome });

    expect(id1).toBe("CAMP-001");
    expect(id2).toBe("CAMP-002");
    expect(id3).toBe("CAMP-003");
  });

  test("writes frozen prefix with structured content including the goal", async () => {
    const goal = "# Prime Directive\n\nShip the campaign system.";
    const id = await initCampaign({ goal, repoPath, hiveHome });

    const prefix = await readFrozenPrefix(id, hiveHome);
    expect(prefix).toContain("## Prime Directive");
    expect(prefix).toContain("## Scope Fence");
    expect(prefix).toContain("## Scorecard Schema");
    expect(prefix).toContain(goal);
  });

  test("sets initial status to running", async () => {
    const id = await initCampaign({ goal: "Go", repoPath, hiveHome });
    const status = await readStatus(id, hiveHome);
    expect(status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Frozen prefix (immutability)
// ---------------------------------------------------------------------------

describe("freezePrefix", () => {
  test("throws if frozen prefix already exists", async () => {
    const id = await initCampaign({ goal: "Original", repoPath, hiveHome });

    // initCampaign already wrote the frozen prefix
    expect(
      freezePrefix(id, "Attempted mutation", hiveHome),
    ).rejects.toThrow(/already exists/);
  });

  test("succeeds on a campaign without a frozen prefix", async () => {
    // Manually create a campaign dir without frozen prefix
    const dir = join(hiveHome, "campaigns", "CAMP-099");
    await mkdir(dir, { recursive: true });

    await freezePrefix("CAMP-099", "Late freeze", hiveHome);
    const content = await readFrozenPrefix("CAMP-099", hiveHome);
    expect(content).toBe("Late freeze");
  });
});

// ---------------------------------------------------------------------------
// Checkpoint (round-trip)
// ---------------------------------------------------------------------------

describe("checkpoint", () => {
  test("returns null when no checkpoint exists", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });
    const cp = await readCheckpoint(id, hiveHome);
    expect(cp).toBeNull();
  });

  test("round-trip write and read", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });
    const body = "## Iteration 1 Checkpoint\n\nAll tests passing. Ready for step 2.";

    await writeCheckpoint(id, body, hiveHome);
    const result = await readCheckpoint(id, hiveHome);
    expect(result).toBe(body);
  });

  test("subsequent writes replace (not append)", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });

    await writeCheckpoint(id, "First checkpoint", hiveHome);
    await writeCheckpoint(id, "Second checkpoint", hiveHome);

    const result = await readCheckpoint(id, hiveHome);
    expect(result).toBe("Second checkpoint");
  });
});

// ---------------------------------------------------------------------------
// Plan (round-trip)
// ---------------------------------------------------------------------------

describe("plan", () => {
  test("returns null when no plan exists", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });
    const plan = await latestPlan(id, hiveHome);
    expect(plan).toBeNull();
  });

  test("round-trip write and read", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });
    const body = "1. Build state module\n2. Wire orchestrator\n3. Test";

    await writePlan(id, body, hiveHome);
    const result = await latestPlan(id, hiveHome);
    expect(result).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Scorecard (append ordering)
// ---------------------------------------------------------------------------

describe("scorecard", () => {
  test("returns empty array when no scorecard exists", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });
    const rows = await readScorecard(id, hiveHome);
    expect(rows).toEqual([]);
  });

  test("appends rows in order", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });

    await appendScorecardRow(id, makeRow(1), hiveHome);
    await appendScorecardRow(id, makeRow(2), hiveHome);
    await appendScorecardRow(id, makeRow(3), hiveHome);

    const rows = await readScorecard(id, hiveHome);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.iteration_n).toBe(1);
    expect(rows[1]!.iteration_n).toBe(2);
    expect(rows[2]!.iteration_n).toBe(3);
  });

  test("preserves all schema fields", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });

    const row: ScorecardRow = {
      iteration_n: 5,
      started_at: "2026-05-09T10:00:00Z",
      ended_at: "2026-05-09T10:25:00Z",
      exit_reason: "timeout",
      judge_decision: "replan",
      tokens_used: 125000,
      cost_usd: 0.42,
    };

    await appendScorecardRow(id, row, hiveHome);
    const [result] = await readScorecard(id, hiveHome);

    expect(result).toEqual(row);
  });

  test("file is valid JSONL (one JSON object per line)", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });

    await appendScorecardRow(id, makeRow(1), hiveHome);
    await appendScorecardRow(id, makeRow(2), hiveHome);

    const raw = await readFile(
      join(hiveHome, "campaigns", id, "scorecard.jsonl"),
      "utf-8",
    );
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);

    // Each line is independently parseable
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Worktree creation and teardown
// ---------------------------------------------------------------------------

describe("worktree lifecycle", () => {
  test("teardownWorktree removes worktree and branch", async () => {
    const id = await initCampaign({ goal: "Teardown test", repoPath, hiveHome });
    const workspacePath = join(hiveHome, "campaigns", id, "workspace");

    expect(existsSync(workspacePath)).toBe(true);

    await teardownWorktree(id, repoPath, hiveHome);

    // Worktree directory should be gone
    expect(existsSync(workspacePath)).toBe(false);

    // Branch should be deleted
    const branches = execSync("git branch", {
      cwd: repoPath,
      encoding: "utf-8",
    });
    expect(branches).not.toContain(`campaign/${id}`);
  });

  test("teardownWorktree is idempotent", async () => {
    const id = await initCampaign({ goal: "Idempotent test", repoPath, hiveHome });

    await teardownWorktree(id, repoPath, hiveHome);
    // Second call should not throw
    await teardownWorktree(id, repoPath, hiveHome);
  });
});

// ---------------------------------------------------------------------------
// Iterations
// ---------------------------------------------------------------------------

describe("iterations", () => {
  test("createIteration returns sequential numbers", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });

    const iter1 = await createIteration(id, hiveHome);
    const iter2 = await createIteration(id, hiveHome);
    const iter3 = await createIteration(id, hiveHome);

    expect(iter1).toBe(1);
    expect(iter2).toBe(2);
    expect(iter3).toBe(3);
  });

  test("iterationDir returns correct path", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });
    await createIteration(id, hiveHome);

    const dir = iterationDir(id, 1, hiveHome);
    expect(dir).toBe(join(hiveHome, "campaigns", id, "iterations", "1"));
    expect(existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("status", () => {
  test("writeStatus and readStatus round-trip", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });

    await writeStatus(id, "paused", hiveHome);
    expect(await readStatus(id, hiveHome)).toBe("paused");

    await writeStatus(id, "done", hiveHome);
    expect(await readStatus(id, hiveHome)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Aggregate reader
// ---------------------------------------------------------------------------

describe("readCampaignState", () => {
  test("returns null for nonexistent campaign", async () => {
    const state = await readCampaignState("CAMP-999", hiveHome);
    expect(state).toBeNull();
  });

  test("aggregates all state into one object", async () => {
    const id = await initCampaign({ goal: "Full state", repoPath, hiveHome });

    // Write a live PID so resolveStatus doesn't auto-correct "running" to "aborted"
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), String(process.pid), "utf-8");

    await writePlan(id, "Step 1\nStep 2", hiveHome);
    await writeCheckpoint(id, "Checkpoint data", hiveHome);
    await appendScorecardRow(id, makeRow(1), hiveHome);
    await createIteration(id, hiveHome);
    await createIteration(id, hiveHome);

    const state = await readCampaignState(id, hiveHome);
    expect(state).not.toBeNull();
    expect(state!.id).toBe(id);
    expect(state!.status).toBe("running");
    expect(state!.wasOrphaned).toBe(false);
    expect(state!.frozenPrefix).toContain("Full state");
    expect(state!.frozenPrefix).toContain("## Prime Directive");
    expect(state!.goal).toBe("Full state");
    expect(state!.plan).toBe("Step 1\nStep 2");
    expect(state!.checkpoint).toBe("Checkpoint data");
    expect(state!.scorecard).toHaveLength(1);
    expect(state!.iterationCount).toBe(2);
    expect(state!.workspacePath).toContain("workspace");
  });
});

// ---------------------------------------------------------------------------
// List campaigns
// ---------------------------------------------------------------------------

describe("listCampaigns", () => {
  test("returns empty for fresh hive home", async () => {
    const list = await listCampaigns(hiveHome);
    expect(list).toEqual([]);
  });

  test("returns sorted campaign IDs", async () => {
    await initCampaign({ goal: "A", repoPath, hiveHome });
    await initCampaign({ goal: "B", repoPath, hiveHome });

    const list = await listCampaigns(hiveHome);
    expect(list).toEqual(["CAMP-001", "CAMP-002"]);
  });
});

// ---------------------------------------------------------------------------
// PID liveness and stale-running detection (TK-084)
// ---------------------------------------------------------------------------

describe("readPid", () => {
  test("returns null when no pid file exists", async () => {
    const id = await initCampaign({ goal: "No pid", repoPath, hiveHome });
    const { unlink } = await import("node:fs/promises");
    try { await unlink(join(hiveHome, "campaigns", id, "pid")); } catch { /* ok */ }

    const pid = await readPid(id, hiveHome);
    expect(pid).toBeNull();
  });

  test("reads a valid PID from the pid file", async () => {
    const id = await initCampaign({ goal: "Has pid", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), "12345", "utf-8");

    const pid = await readPid(id, hiveHome);
    expect(pid).toBe(12345);
  });

  test("returns null for non-numeric pid content", async () => {
    const id = await initCampaign({ goal: "Bad pid", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), "not-a-number", "utf-8");

    const pid = await readPid(id, hiveHome);
    expect(pid).toBeNull();
  });
});

describe("isPidAlive", () => {
  test("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("returns false for a definitely-dead PID", () => {
    expect(isPidAlive(2147483647)).toBe(false);
  });
});

describe("resolveStatus", () => {
  test("returns raw status for non-running campaigns", async () => {
    const id = await initCampaign({ goal: "Done", repoPath, hiveHome });
    await writeStatus(id, "done", hiveHome);

    const resolved = await resolveStatus(id, hiveHome);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("done");
    expect(resolved!.wasOrphaned).toBe(false);
  });

  test("returns running when PID is alive", async () => {
    const id = await initCampaign({ goal: "Alive", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), String(process.pid), "utf-8");

    const resolved = await resolveStatus(id, hiveHome);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("running");
    expect(resolved!.wasOrphaned).toBe(false);
  });

  test("detects orphaned campaign (dead PID, no result.txt)", async () => {
    const id = await initCampaign({ goal: "Orphaned", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), "2147483647", "utf-8");

    const resolved = await resolveStatus(id, hiveHome);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("aborted");
    expect(resolved!.wasOrphaned).toBe(true);

    // Verify the status file was updated on disk (self-healing)
    const rawStatus = await readStatus(id, hiveHome);
    expect(rawStatus).toBe("aborted");
  });

  test("does NOT mark as orphaned when result.txt exists", async () => {
    const id = await initCampaign({ goal: "Has result", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), "2147483647", "utf-8");
    await wf(join(hiveHome, "campaigns", id, "result.txt"), "done", "utf-8");

    const resolved = await resolveStatus(id, hiveHome);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("running");
    expect(resolved!.wasOrphaned).toBe(false);
  });

  test("detects orphaned campaign when no PID file exists", async () => {
    const id = await initCampaign({ goal: "No pid file", repoPath, hiveHome });
    const { unlink } = await import("node:fs/promises");
    try { await unlink(join(hiveHome, "campaigns", id, "pid")); } catch { /* ok */ }

    const resolved = await resolveStatus(id, hiveHome);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("aborted");
    expect(resolved!.wasOrphaned).toBe(true);
  });

  test("returns null for non-existent campaign", async () => {
    const resolved = await resolveStatus("CAMP-999", hiveHome);
    expect(resolved).toBeNull();
  });
});

describe("detectAndFixStaleStatus (compat wrapper)", () => {
  test("returns corrected status for dead PID", async () => {
    const id = await initCampaign({ goal: "Dead", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), "999999999", "utf-8");

    const status = await detectAndFixStaleStatus(id, hiveHome);
    expect(status).toBe("aborted");
  });

  test("returns running for live PID", async () => {
    const id = await initCampaign({ goal: "Alive", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), String(process.pid), "utf-8");

    const status = await detectAndFixStaleStatus(id, hiveHome);
    expect(status).toBe("running");
  });
});

describe("readCampaignState with PID liveness", () => {
  test("wasOrphaned is false for live campaigns", async () => {
    const id = await initCampaign({ goal: "Live", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), String(process.pid), "utf-8");

    const state = await readCampaignState(id, hiveHome);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("running");
    expect(state!.wasOrphaned).toBe(false);
  });

  test("wasOrphaned is true and status corrected for dead PID", async () => {
    const id = await initCampaign({ goal: "Dead", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), "2147483647", "utf-8");

    const state = await readCampaignState(id, hiveHome);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("aborted");
    expect(state!.wasOrphaned).toBe(true);
  });

  test("second read after orphan detection sees aborted directly", async () => {
    const id = await initCampaign({ goal: "Self-heal", repoPath, hiveHome });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(join(hiveHome, "campaigns", id, "pid"), "2147483647", "utf-8");

    const state1 = await readCampaignState(id, hiveHome);
    expect(state1!.wasOrphaned).toBe(true);

    const state2 = await readCampaignState(id, hiveHome);
    expect(state2!.status).toBe("aborted");
    expect(state2!.wasOrphaned).toBe(false);
  });
});
