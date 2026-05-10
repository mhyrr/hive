import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  buildFrozenPrefix,
  extractGoalFromPrefix,
  ORCHESTRATOR_VERSION,
} from "../lib/campaign/frozen-prefix";
import {
  initCampaign,
  readFrozenPrefix,
  readGoal,
  readCampaignState,
} from "../lib/campaign/state";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let hiveHome: string;
let repoPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hive-frozen-prefix-test-"));
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
// buildFrozenPrefix — content verification
// ---------------------------------------------------------------------------

describe("buildFrozenPrefix", () => {
  test("contains prime directive section", () => {
    const prefix = buildFrozenPrefix("Ship the widget");
    expect(prefix).toContain("## Prime Directive");
    expect(prefix).toContain("campaign judge");
    expect(prefix).toContain("iteration");
  });

  test("contains scope fence section", () => {
    const prefix = buildFrozenPrefix("Ship the widget");
    expect(prefix).toContain("## Scope Fence");
    expect(prefix).toContain("MUST NOT");
    expect(prefix).toContain("campaign worktree");
  });

  test("contains scorecard schema section", () => {
    const prefix = buildFrozenPrefix("Ship the widget");
    expect(prefix).toContain("## Scorecard Schema");
    expect(prefix).toContain('"decision"');
    expect(prefix).toContain('"reasoning"');
    expect(prefix).toContain('"second_opinion"');
    expect(prefix).toContain('"progress_vs_prime"');
    expect(prefix).toContain('"fence_integrity"');
    expect(prefix).toContain('"confidence"');
  });

  test("contains the goal text", () => {
    const goal = "Build an amazing feature that changes everything";
    const prefix = buildFrozenPrefix(goal);
    expect(prefix).toContain("## Goal");
    expect(prefix).toContain(goal);
  });

  test("includes orchestrator version", () => {
    const prefix = buildFrozenPrefix("Test");
    expect(prefix).toContain(`v${ORCHESTRATOR_VERSION}`);
  });

  test("is deterministic — same goal produces identical output", () => {
    const goal = "Deploy the campaign system to production";
    const prefix1 = buildFrozenPrefix(goal);
    const prefix2 = buildFrozenPrefix(goal);
    expect(prefix1).toBe(prefix2);
  });

  test("different goals produce different outputs", () => {
    const prefix1 = buildFrozenPrefix("Goal A");
    const prefix2 = buildFrozenPrefix("Goal B");
    expect(prefix1).not.toBe(prefix2);
  });

  test("two campaigns initialized by the same orchestrator version produce identical prefixes for same goal", () => {
    const goal = "Implement the frozen prefix properly";
    const a = buildFrozenPrefix(goal);
    const b = buildFrozenPrefix(goal);
    // Byte-for-byte identical
    expect(a).toBe(b);
    expect(a.length).toBe(b.length);
  });
});

// ---------------------------------------------------------------------------
// extractGoalFromPrefix
// ---------------------------------------------------------------------------

describe("extractGoalFromPrefix", () => {
  test("extracts goal from a well-formed prefix", () => {
    const goal = "Ship the campaign system";
    const prefix = buildFrozenPrefix(goal);
    const extracted = extractGoalFromPrefix(prefix);
    expect(extracted).toBe(goal);
  });

  test("returns null for text without goal marker", () => {
    const result = extractGoalFromPrefix("Just some random text");
    expect(result).toBeNull();
  });

  test("handles multiline goals", () => {
    const goal = "Line 1\nLine 2\nLine 3";
    const prefix = buildFrozenPrefix(goal);
    const extracted = extractGoalFromPrefix(prefix);
    expect(extracted).toBe(goal);
  });
});

// ---------------------------------------------------------------------------
// initCampaign — frozen prefix integration
// ---------------------------------------------------------------------------

describe("initCampaign with frozen prefix", () => {
  test("writes both goal.md and frozen-prefix.md", async () => {
    const goal = "Build the feature";
    const id = await initCampaign({ goal, repoPath, hiveHome });
    const dir = join(hiveHome, "campaigns", id);

    expect(existsSync(join(dir, "goal.md"))).toBe(true);
    expect(existsSync(join(dir, "frozen-prefix.md"))).toBe(true);
  });

  test("goal.md contains raw goal text", async () => {
    const goal = "Ship the campaign system";
    const id = await initCampaign({ goal, repoPath, hiveHome });

    const rawGoal = await readGoal(id, hiveHome);
    expect(rawGoal).toBe(goal);
  });

  test("frozen-prefix.md contains structured content (not just goal)", async () => {
    const goal = "Build something great";
    const id = await initCampaign({ goal, repoPath, hiveHome });

    const prefix = await readFrozenPrefix(id, hiveHome);
    expect(prefix).not.toBeNull();
    expect(prefix).not.toBe(goal); // Should NOT be just the goal
    expect(prefix!).toContain("## Prime Directive");
    expect(prefix!).toContain("## Scope Fence");
    expect(prefix!).toContain("## Scorecard Schema");
    expect(prefix!).toContain(goal); // But should include the goal
  });

  test("frozen prefix is byte-stable: same goal → same prefix", async () => {
    const goal = "Consistent frozen prefix test";
    const id1 = await initCampaign({ goal, repoPath, hiveHome });
    const id2 = await initCampaign({ goal, repoPath, hiveHome });

    const prefix1 = await readFrozenPrefix(id1, hiveHome);
    const prefix2 = await readFrozenPrefix(id2, hiveHome);

    expect(prefix1).toBe(prefix2);
  });

  test("readCampaignState includes both frozenPrefix and goal fields", async () => {
    const goal = "State aggregation test";
    const id = await initCampaign({ goal, repoPath, hiveHome });

    const state = await readCampaignState(id, hiveHome);
    expect(state).not.toBeNull();
    expect(state!.goal).toBe(goal);
    expect(state!.frozenPrefix).toContain("## Prime Directive");
    expect(state!.frozenPrefix).toContain(goal);
  });

  test("editing goal.md does not change frozen-prefix.md", async () => {
    const goal = "Original goal";
    const id = await initCampaign({ goal, repoPath, hiveHome });

    const originalPrefix = await readFrozenPrefix(id, hiveHome);

    // Simulate editing the goal (would be done by hive campaign direct or manual edit)
    const { writeGoal } = await import("../lib/campaign/state");
    await writeGoal(id, "Modified goal", hiveHome);

    const prefixAfterEdit = await readFrozenPrefix(id, hiveHome);
    expect(prefixAfterEdit).toBe(originalPrefix); // Cache not busted
  });
});

// ---------------------------------------------------------------------------
// Prefix is substantial (not just 75 bytes)
// ---------------------------------------------------------------------------

describe("prefix substance", () => {
  test("prefix is substantially larger than goal alone", () => {
    const goal = "Ship it"; // 7 bytes
    const prefix = buildFrozenPrefix(goal);
    // The prefix should be hundreds of bytes with the structural content
    expect(prefix.length).toBeGreaterThan(500);
  });

  test("prefix contains iteration discipline rules", () => {
    const prefix = buildFrozenPrefix("Test");
    expect(prefix).toContain("independent");
    expect(prefix).toContain("separate agent");
    expect(prefix).toContain("evidence");
  });

  test("prefix contains executor constraints in scope fence", () => {
    const prefix = buildFrozenPrefix("Test");
    expect(prefix).toContain("MUST NOT");
    expect(prefix).toContain("Push to remote");
    expect(prefix).toContain("checkpoint");
  });

  test("scorecard schema includes all required fields", () => {
    const prefix = buildFrozenPrefix("Test");
    const requiredFields = [
      "decision",
      "reasoning",
      "second_opinion",
      "progress_vs_prime",
      "fence_integrity",
      "confidence",
      "plan_diff",
    ];
    for (const field of requiredFields) {
      expect(prefix).toContain(field);
    }
  });
});
