import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { mkdir } from "node:fs/promises";

import {
  initCampaign,
  writePlan,
  writeCheckpoint,
  readScorecard,
  readStatus,
  latestPlan,
  type ScorecardRow,
} from "../lib/campaign/state";
import {
  runCampaign,
  checkLimits,
  applyReplan,
  DEFAULT_LIMITS,
  type ExecutorFn,
  type JudgeFn,
  type CampaignLimits,
} from "../lib/campaign/orchestrator";
import type { IterationResult } from "../lib/campaign/executor";
import type { JudgeVerdict } from "../lib/campaign/judge";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let hiveHome: string;
let repoPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hive-orch-test-"));
  hiveHome = join(tmpDir, ".hive");
  repoPath = join(tmpDir, "repo");

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
// Helpers: stub factories
// ---------------------------------------------------------------------------

function makeIterationResult(overrides?: Partial<IterationResult>): IterationResult {
  return {
    exitReason: "clean",
    checkpointPath: "/fake/checkpoint.md",
    tokensUsed: 10000,
    walltimeMs: 5000,
    ...overrides,
  };
}

function makeVerdict(overrides?: Partial<JudgeVerdict>): JudgeVerdict {
  return {
    decision: "continue",
    reasoning: "Progress is good, continuing.",
    second_opinion: "no",
    ...overrides,
  };
}

/**
 * Build a stubbed executor that returns predefined results per iteration.
 * Also writes a checkpoint.md into the campaign workspace so state reads work.
 */
function buildStubExecutor(
  results: IterationResult[],
  campaignId: string,
): { executor: ExecutorFn; calls: number[] } {
  const calls: number[] = [];
  const executor: ExecutorFn = async (opts) => {
    calls.push(opts.iterationN);
    const idx = opts.iterationN - 1;
    const result = results[idx] ?? makeIterationResult();

    // Simulate checkpoint write if the executor "succeeded"
    if (result.exitReason !== "crashed") {
      await writeCheckpoint(
        campaignId,
        `Checkpoint for iteration ${opts.iterationN}`,
        hiveHome,
      );
    }

    return result;
  };
  return { executor, calls };
}

/**
 * Build a stubbed judge that returns predefined verdicts per iteration.
 */
function buildStubJudge(
  verdicts: JudgeVerdict[],
): { judge: JudgeFn; calls: number[] } {
  const calls: number[] = [];
  const judge: JudgeFn = async (opts) => {
    calls.push(opts.iterationN);
    const idx = calls.length - 1;
    return verdicts[idx] ?? makeVerdict({ decision: "done", reasoning: "Fallback done" });
  };
  return { judge, calls };
}

// ---------------------------------------------------------------------------
// Unit: checkLimits
// ---------------------------------------------------------------------------

describe("checkLimits", () => {
  test("returns not exceeded when all under limits", () => {
    const result = checkLimits(1, 0, 0, DEFAULT_LIMITS);
    expect(result.exceeded).toBe(false);
    expect(result.reason).toBeNull();
  });

  test("detects max iterations exceeded", () => {
    const result = checkLimits(13, 0, 0, DEFAULT_LIMITS);
    expect(result.exceeded).toBe(true);
    expect(result.reason).toBe("max_iterations");
  });

  test("detects max cost exceeded", () => {
    const result = checkLimits(1, 40, 0, DEFAULT_LIMITS);
    expect(result.exceeded).toBe(true);
    expect(result.reason).toBe("max_cost");
  });

  test("detects max walltime exceeded", () => {
    const result = checkLimits(1, 0, 8 * 60 * 60 * 1000, DEFAULT_LIMITS);
    expect(result.exceeded).toBe(true);
    expect(result.reason).toBe("max_walltime");
  });

  test("iteration at exact max is allowed", () => {
    const result = checkLimits(12, 0, 0, DEFAULT_LIMITS);
    expect(result.exceeded).toBe(false);
  });

  test("respects custom limits", () => {
    const custom: CampaignLimits = {
      maxIterations: 3,
      maxCostUsd: 5,
      maxWalltimeMs: 60000,
    };
    expect(checkLimits(4, 0, 0, custom).exceeded).toBe(true);
    expect(checkLimits(1, 5, 0, custom).exceeded).toBe(true);
    expect(checkLimits(1, 0, 60000, custom).exceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: applyReplan
// ---------------------------------------------------------------------------

describe("applyReplan", () => {
  test("replaces plan.md with the diff content", async () => {
    const id = await initCampaign({ goal: "Test", repoPath, hiveHome });
    await writePlan(id, "Original plan", hiveHome);

    await applyReplan(id, "New plan from judge", hiveHome);

    const plan = await latestPlan(id, hiveHome);
    expect(plan).toBe("New plan from judge");
  });
});

// ---------------------------------------------------------------------------
// Integration: 3-iteration campaign ending in done
// ---------------------------------------------------------------------------

describe("runCampaign — 3-iteration done", () => {
  test("runs 3 iterations then terminates on judge done", async () => {
    const id = await initCampaign({ goal: "Build feature X", repoPath, hiveHome });
    await writePlan(id, "Step 1: scaffold\nStep 2: implement\nStep 3: test", hiveHome);

    const { executor, calls: execCalls } = buildStubExecutor(
      [
        makeIterationResult({ tokensUsed: 8000 }),
        makeIterationResult({ tokensUsed: 12000 }),
        makeIterationResult({ tokensUsed: 6000 }),
      ],
      id,
    );

    const { judge, calls: judgeCalls } = buildStubJudge([
      makeVerdict({ decision: "continue", reasoning: "Step 1 done, proceed" }),
      makeVerdict({ decision: "continue", reasoning: "Step 2 done, proceed" }),
      makeVerdict({ decision: "done", reasoning: "All steps complete" }),
    ]);

    const result = await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
    });

    // Verify termination
    expect(result.terminationReason).toBe("judge_done");
    expect(result.iterationsCompleted).toBe(3);

    // Verify executor was called 3 times
    expect(execCalls).toEqual([1, 2, 3]);

    // Verify judge was called 3 times
    expect(judgeCalls).toEqual([1, 2, 3]);

    // Verify scorecard has exactly 3 rows
    const scorecard = await readScorecard(id, hiveHome);
    expect(scorecard.length).toBe(3);
    expect(scorecard[0].iteration_n).toBe(1);
    expect(scorecard[0].judge_decision).toBe("continue");
    expect(scorecard[1].iteration_n).toBe(2);
    expect(scorecard[1].judge_decision).toBe("continue");
    expect(scorecard[2].iteration_n).toBe(3);
    expect(scorecard[2].judge_decision).toBe("done");

    // Verify status is done
    const status = await readStatus(id, hiveHome);
    expect(status).toBe("done");

    // Verify token counts
    expect(result.totalTokens).toBe(26000);
  });
});

// ---------------------------------------------------------------------------
// Integration: replan updates plan.md before next iteration
// ---------------------------------------------------------------------------

describe("runCampaign — replan", () => {
  test("replan mutates plan.md before the next iteration starts", async () => {
    const id = await initCampaign({ goal: "Build feature Y", repoPath, hiveHome });
    const originalPlan = "Step 1: do A\nStep 2: do B";
    await writePlan(id, originalPlan, hiveHome);

    const newPlan = "Step 1: do A\nStep 2: do B-revised\nStep 3: do C (added)";

    // Track what plan the executor sees each iteration
    const plansSeenByExecutor: (string | null)[] = [];

    const executor: ExecutorFn = async (opts) => {
      plansSeenByExecutor.push(opts.state.plan);
      await writeCheckpoint(id, `Checkpoint iter ${opts.iterationN}`, hiveHome);
      return makeIterationResult({ tokensUsed: 5000 });
    };

    const { judge } = buildStubJudge([
      makeVerdict({
        decision: "replan",
        reasoning: "Need to adjust approach",
        plan_diff: newPlan,
      }),
      makeVerdict({ decision: "done", reasoning: "All done" }),
    ]);

    const result = await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
    });

    expect(result.terminationReason).toBe("judge_done");
    expect(result.iterationsCompleted).toBe(2);

    // Iteration 1 saw the original plan
    expect(plansSeenByExecutor[0]).toBe(originalPlan);

    // Iteration 2 saw the replanned content
    expect(plansSeenByExecutor[1]).toBe(newPlan);

    // Final plan on disk is the replanned version
    const finalPlan = await latestPlan(id, hiveHome);
    expect(finalPlan).toBe(newPlan);
  });
});

// ---------------------------------------------------------------------------
// Integration: max iterations termination
// ---------------------------------------------------------------------------

describe("runCampaign — max iterations", () => {
  test("terminates when max iterations exceeded", async () => {
    const id = await initCampaign({ goal: "Big task", repoPath, hiveHome });
    await writePlan(id, "Plan", hiveHome);

    const { executor } = buildStubExecutor(
      Array(5).fill(makeIterationResult({ tokensUsed: 1000 })),
      id,
    );

    // Judge always says continue — should hit max iterations
    const { judge } = buildStubJudge(
      Array(5).fill(makeVerdict({ decision: "continue" })),
    );

    const result = await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
      limits: { maxIterations: 3 },
    });

    expect(result.terminationReason).toBe("max_iterations");
    expect(result.iterationsCompleted).toBe(3);

    const scorecard = await readScorecard(id, hiveHome);
    expect(scorecard.length).toBe(3);

    // TK-109: max_iterations is a normal budget termination, not an abort
    const status = await readStatus(id, hiveHome);
    expect(status).toBe("budget-exhausted");
  });
});

// ---------------------------------------------------------------------------
// Integration: max cost termination
// ---------------------------------------------------------------------------

describe("runCampaign — max cost", () => {
  test("terminates when total cost exceeds limit", async () => {
    const id = await initCampaign({ goal: "Expensive task", repoPath, hiveHome });
    await writePlan(id, "Plan", hiveHome);

    // Each iteration uses enough tokens to exceed $1 at our cost rate
    const { executor } = buildStubExecutor(
      Array(5).fill(makeIterationResult({ tokensUsed: 500_000 })),
      id,
    );

    const { judge } = buildStubJudge(
      Array(5).fill(makeVerdict({ decision: "continue" })),
    );

    const result = await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
      limits: { maxCostUsd: 2 },
      costPerToken: 0.000003,
    });

    expect(result.terminationReason).toBe("max_cost");
    // With 500k tokens at $0.000003/token = $1.50 per iteration.
    // Pre-iter-1 check: $0 < $2, runs. Pre-iter-2: $1.50 < $2, runs.
    // Pre-iter-3: $3.00 >= $2, terminates.
    expect(result.iterationsCompleted).toBe(2);

    const status = await readStatus(id, hiveHome);
    expect(status).toBe("budget-exhausted");
  });
});

// ---------------------------------------------------------------------------
// Integration: frozen prefix never changes
// ---------------------------------------------------------------------------

describe("runCampaign — frozen prefix discipline", () => {
  test("frozen prefix is loaded once and reused across iterations", async () => {
    const id = await initCampaign({
      goal: "Frozen prime directive",
      repoPath,
      hiveHome,
    });
    await writePlan(id, "Plan", hiveHome);

    const prefixesSeen: (string | null)[] = [];

    const executor: ExecutorFn = async (opts) => {
      prefixesSeen.push(opts.state.frozenPrefix);
      await writeCheckpoint(id, `Checkpoint ${opts.iterationN}`, hiveHome);
      return makeIterationResult();
    };

    const { judge } = buildStubJudge([
      makeVerdict({ decision: "continue" }),
      makeVerdict({ decision: "continue" }),
      makeVerdict({ decision: "done" }),
    ]);

    await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
    });

    // All iterations saw the same frozen prefix (byte-stable)
    expect(prefixesSeen.length).toBe(3);
    expect(prefixesSeen[0]).toContain("Frozen prime directive");
    expect(prefixesSeen[0]).toContain("## Prime Directive");
    expect(prefixesSeen[0]).toContain("## Scope Fence");
    // Byte-stable across iterations
    expect(prefixesSeen[1]).toBe(prefixesSeen[0]);
    expect(prefixesSeen[2]).toBe(prefixesSeen[0]);
  });
});

// ---------------------------------------------------------------------------
// Integration: second_opinion logged but no control flow change
// ---------------------------------------------------------------------------

describe("runCampaign — second_opinion", () => {
  test("second_opinion: yes is recorded in scorecard without altering flow", async () => {
    const id = await initCampaign({ goal: "Opinion test", repoPath, hiveHome });
    await writePlan(id, "Plan", hiveHome);

    const { executor } = buildStubExecutor(
      [makeIterationResult(), makeIterationResult()],
      id,
    );

    const { judge } = buildStubJudge([
      makeVerdict({
        decision: "continue",
        reasoning: "Good but uncertain",
        second_opinion: "yes",
      }),
      makeVerdict({ decision: "done", reasoning: "Complete" }),
    ]);

    const result = await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
    });

    // Campaign completed normally — second_opinion didn't alter flow
    expect(result.terminationReason).toBe("judge_done");
    expect(result.iterationsCompleted).toBe(2);

    // Scorecard still has the continue decision (not paused or escalated)
    const scorecard = await readScorecard(id, hiveHome);
    expect(scorecard[0].judge_decision).toBe("continue");
  });
});

// ---------------------------------------------------------------------------
// Integration: executor crash handling
// ---------------------------------------------------------------------------

describe("runCampaign — executor crash", () => {
  test("records crash in scorecard and continues to next iteration", async () => {
    const id = await initCampaign({ goal: "Crashy task", repoPath, hiveHome });
    await writePlan(id, "Plan", hiveHome);

    const executor: ExecutorFn = async (opts) => {
      if (opts.iterationN === 1) {
        return makeIterationResult({
          exitReason: "crashed",
          checkpointPath: null,
          tokensUsed: 2000,
        });
      }
      await writeCheckpoint(id, `Checkpoint ${opts.iterationN}`, hiveHome);
      return makeIterationResult({ tokensUsed: 5000 });
    };

    const { judge } = buildStubJudge([
      // Judge only called after successful iterations
      makeVerdict({ decision: "done", reasoning: "Done after recovery" }),
    ]);

    const result = await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
    });

    expect(result.terminationReason).toBe("judge_done");
    expect(result.iterationsCompleted).toBe(2);

    const scorecard = await readScorecard(id, hiveHome);
    expect(scorecard.length).toBe(2);
    // First row is the crash — judge_decision defaults to "continue"
    expect(scorecard[0].exit_reason).toBe("error");
    expect(scorecard[0].judge_decision).toBe("continue");
    // Second row is the successful iteration
    expect(scorecard[1].exit_reason).toBe("natural");
    expect(scorecard[1].judge_decision).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Integration: scorecard completeness
// ---------------------------------------------------------------------------

describe("runCampaign — scorecard completeness", () => {
  test("every iteration produces exactly one scorecard row", async () => {
    const id = await initCampaign({ goal: "Scorecard test", repoPath, hiveHome });
    await writePlan(id, "Plan", hiveHome);

    const { executor } = buildStubExecutor(
      Array(5).fill(makeIterationResult({ tokensUsed: 3000 })),
      id,
    );

    const { judge } = buildStubJudge([
      makeVerdict({ decision: "continue" }),
      makeVerdict({ decision: "continue" }),
      makeVerdict({ decision: "replan", plan_diff: "New plan" }),
      makeVerdict({ decision: "continue" }),
      makeVerdict({ decision: "done" }),
    ]);

    const result = await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
    });

    expect(result.iterationsCompleted).toBe(5);

    const scorecard = await readScorecard(id, hiveHome);
    expect(scorecard.length).toBe(5);

    // Verify sequential iteration numbers, no gaps
    for (let i = 0; i < 5; i++) {
      expect(scorecard[i].iteration_n).toBe(i + 1);
      expect(scorecard[i].started_at).toBeTruthy();
      expect(scorecard[i].ended_at).toBeTruthy();
      expect(scorecard[i].tokens_used).toBe(3000);
    }

    // Verify judge decisions match
    expect(scorecard[0].judge_decision).toBe("continue");
    expect(scorecard[1].judge_decision).toBe("continue");
    expect(scorecard[2].judge_decision).toBe("replan");
    expect(scorecard[3].judge_decision).toBe("continue");
    expect(scorecard[4].judge_decision).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Integration: exit reason mapping
// ---------------------------------------------------------------------------

describe("runCampaign — exit reason mapping", () => {
  test("maps executor exit reasons to scorecard exit reasons", async () => {
    const id = await initCampaign({ goal: "Exit map test", repoPath, hiveHome });
    await writePlan(id, "Plan", hiveHome);

    const executor: ExecutorFn = async (opts) => {
      const reasons: Record<number, IterationResult> = {
        1: makeIterationResult({ exitReason: "clean", tokensUsed: 1000 }),
        2: makeIterationResult({ exitReason: "soft_triggered", tokensUsed: 2000 }),
        3: makeIterationResult({ exitReason: "hard_killed", tokensUsed: 3000 }),
      };
      const result = reasons[opts.iterationN] ?? makeIterationResult();
      await writeCheckpoint(id, `Checkpoint ${opts.iterationN}`, hiveHome);
      return result;
    };

    const { judge } = buildStubJudge([
      makeVerdict({ decision: "continue" }),
      makeVerdict({ decision: "continue" }),
      makeVerdict({ decision: "done" }),
    ]);

    await runCampaign({
      campaignId: id,
      executor,
      judge,
      hiveHome,
    });

    const scorecard = await readScorecard(id, hiveHome);
    expect(scorecard[0].exit_reason).toBe("natural");
    expect(scorecard[1].exit_reason).toBe("timeout");
    expect(scorecard[2].exit_reason).toBe("hard-cap");
  });
});

// ---------------------------------------------------------------------------
// Edge: campaign not found
// ---------------------------------------------------------------------------

describe("runCampaign — error handling", () => {
  test("throws if campaign not found", async () => {
    const { executor } = buildStubExecutor([], "CAMP-999");
    const { judge } = buildStubJudge([]);

    await expect(
      runCampaign({
        campaignId: "CAMP-999",
        executor,
        judge,
        hiveHome,
      }),
    ).rejects.toThrow("Campaign CAMP-999 not found");
  });

  test("throws if frozen prefix is missing", async () => {
    // Create campaign directory structure manually without frozen prefix
    const campaignsDir = join(hiveHome, "campaigns", "CAMP-001");
    await mkdir(join(campaignsDir, "iterations"), { recursive: true });
    await writeFile(join(campaignsDir, "status"), "running", "utf-8");
    // No frozen-prefix.md

    const { executor } = buildStubExecutor([], "CAMP-001");
    const { judge } = buildStubJudge([]);

    await expect(
      runCampaign({
        campaignId: "CAMP-001",
        executor,
        judge,
        hiveHome,
      }),
    ).rejects.toThrow("has no frozen prefix");
  });
});
