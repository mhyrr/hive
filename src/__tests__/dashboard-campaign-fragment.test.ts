import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import {
  renderCampaignFragment,
  computeSimpleDiff,
  type CampaignFragmentData,
  type IterationBlock,
} from "../lib/dashboard/runs/campaign-fragment";
import { collectCampaignFragment } from "../lib/dashboard/runs/collect-campaign";
import type { ScorecardRow } from "../lib/campaign/state";

let paths: HivePaths;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-camp-frag-"));
  paths = await ensureHiveScaffold(home);
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function writeCampaignFixture(
  campId: string,
  opts: {
    goal?: string;
    status?: string;
    frozenPrefix?: string;
    scorecard?: ScorecardRow[];
    iterations?: Array<{
      n: number;
      task?: string;
      checkpoint?: string;
      judgeRow?: Record<string, unknown>;
      plan?: string;
    }>;
    plan?: string;
    config?: Record<string, unknown>;
  },
): Promise<string> {
  const dir = join(paths.campaignsDir, campId);
  await mkdir(join(dir, "iterations"), { recursive: true });

  await writeFile(join(dir, "status"), opts.status ?? "running", "utf-8");

  if (opts.goal) {
    await writeFile(join(dir, "goal.md"), opts.goal, "utf-8");
  }
  if (opts.frozenPrefix) {
    await writeFile(join(dir, "frozen-prefix.md"), opts.frozenPrefix, "utf-8");
  }
  if (opts.plan) {
    await writeFile(join(dir, "plan.md"), opts.plan, "utf-8");
  }
  if (opts.config) {
    await writeFile(join(dir, "config.json"), JSON.stringify(opts.config), "utf-8");
  }
  if (opts.scorecard && opts.scorecard.length > 0) {
    const jsonl = opts.scorecard.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(join(dir, "scorecard.jsonl"), jsonl, "utf-8");
  }
  if (opts.iterations) {
    for (const iter of opts.iterations) {
      const iterDir = join(dir, "iterations", String(iter.n));
      await mkdir(iterDir, { recursive: true });
      if (iter.task) {
        await writeFile(join(iterDir, "task.md"), iter.task, "utf-8");
      }
      if (iter.checkpoint) {
        await writeFile(join(iterDir, "checkpoint.md"), iter.checkpoint, "utf-8");
      }
      if (iter.judgeRow) {
        await writeFile(
          join(iterDir, "scorecard-row.json"),
          JSON.stringify(iter.judgeRow),
          "utf-8",
        );
      }
      if (iter.plan) {
        await writeFile(join(iterDir, "plan.md"), iter.plan, "utf-8");
      }
    }
  }

  return dir;
}

// ---------------------------------------------------------------------------
// collectCampaignFragment
// ---------------------------------------------------------------------------

describe("collectCampaignFragment", () => {
  test("returns null for non-existent campaign", async () => {
    const result = await collectCampaignFragment("CAMP-999", paths);
    expect(result).toBeNull();
  });

  test("collects empty-iteration campaign (just started)", async () => {
    await writeCampaignFixture("CAMP-001", {
      goal: "Build the auth system",
      status: "running",
      frozenPrefix: "# Frozen\n\nSome prefix content",
    });

    const result = await collectCampaignFragment("CAMP-001", paths);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("CAMP-001");
    expect(result!.goal).toBe("Build the auth system");
    expect(result!.status).toBe("running");
    expect(result!.iterations).toHaveLength(0);
    expect(result!.scorecard).toHaveLength(0);
    expect(result!.frozenPrefix).toBe("# Frozen\n\nSome prefix content");
  });

  test("reads goal from config.json when available", async () => {
    await writeCampaignFixture("CAMP-001", {
      status: "running",
      config: { goal: "Goal from config", projectId: "hive" },
    });

    const result = await collectCampaignFragment("CAMP-001", paths);
    expect(result!.goal).toBe("Goal from config");
  });

  test("collects multi-iteration campaign with scorecard", async () => {
    const scorecard: ScorecardRow[] = [
      {
        iteration_n: 1,
        started_at: "2026-05-10T10:00:00Z",
        ended_at: "2026-05-10T10:15:00Z",
        exit_reason: "natural",
        judge_decision: "continue",
        tokens_used: 50000,
        cost_usd: 0.15,
      },
      {
        iteration_n: 2,
        started_at: "2026-05-10T10:16:00Z",
        ended_at: "2026-05-10T10:30:00Z",
        exit_reason: "natural",
        judge_decision: "replan",
        tokens_used: 75000,
        cost_usd: 0.22,
      },
      {
        iteration_n: 3,
        started_at: "2026-05-10T10:31:00Z",
        ended_at: "2026-05-10T10:45:00Z",
        exit_reason: "natural",
        judge_decision: "done",
        tokens_used: 60000,
        cost_usd: 0.18,
      },
    ];

    await writeCampaignFixture("CAMP-002", {
      goal: "Implement campaign dispatch V1",
      status: "done",
      frozenPrefix: "# Campaign Frozen Prefix (v0.1.0)\n\n## Prime Directive\n...",
      plan: "Step 1: Build state module\nStep 2: Build orchestrator",
      scorecard,
      iterations: [
        {
          n: 1,
          task: "Build the campaign state module with init/read/write helpers",
          judgeRow: {
            decision: "continue",
            reasoning: "State module complete with full test coverage. Ready to proceed.",
            progress_vs_prime: 0.3,
            confidence: 4,
          },
        },
        {
          n: 2,
          task: "Build the orchestrator main loop",
          judgeRow: {
            decision: "replan",
            reasoning: "Orchestrator partially complete but executor spawning needs redesign.",
            progress_vs_prime: 0.55,
            confidence: 3,
          },
          plan: "Step 1: Build state module (done)\nStep 2: Redesign executor spawn\nStep 3: Wire judge",
        },
        {
          n: 3,
          task: "Redesign executor spawn and wire judge calls",
          judgeRow: {
            decision: "done",
            reasoning: "All components wired. Tests passing. Prime directive satisfied.",
            progress_vs_prime: 0.95,
            confidence: 5,
          },
        },
      ],
    });

    const result = await collectCampaignFragment("CAMP-002", paths);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("CAMP-002");
    expect(result!.status).toBe("done");
    expect(result!.iterations).toHaveLength(3);
    expect(result!.scorecard).toHaveLength(3);

    // Iteration details
    expect(result!.iterations[0]!.executorGoal).toContain("campaign state module");
    expect(result!.iterations[0]!.judgeVerdict).toContain("State module complete");
    expect(result!.iterations[0]!.progress).toBe(0.3);
    expect(result!.iterations[0]!.confidence).toBe(4);

    expect(result!.iterations[1]!.judgeDecision).toBe("replan");
    expect(result!.iterations[2]!.status).toBe("shipped"); // judge_decision: done

    // Plan diffs computed
    expect(result!.planDiffs.length).toBeGreaterThanOrEqual(1);
  });

  test("handles campaign with no goal.md gracefully", async () => {
    await writeCampaignFixture("CAMP-001", {
      status: "aborted",
      frozenPrefix: "# Frozen\n\n## Goal\n\nExtracted goal text",
    });

    const result = await collectCampaignFragment("CAMP-001", paths);
    expect(result!.goal).toBe("Extracted goal text");
  });
});

// ---------------------------------------------------------------------------
// renderCampaignFragment
// ---------------------------------------------------------------------------

describe("renderCampaignFragment", () => {
  test("renders empty-iteration campaign without error", () => {
    const data: CampaignFragmentData = {
      id: "CAMP-001",
      goal: "Build auth system",
      status: "running",
      frozenPrefix: "# Prefix\nStable content here",
      iterations: [],
      scorecard: [],
      initialPlan: null,
      planDiffs: [],
    };

    const html = renderCampaignFragment(data);
    expect(html).toContain("CAMP-001");
    expect(html).toContain("Build auth system");
    expect(html).toContain("running");
    expect(html).toContain("No iterations scored yet");
    expect(html).toContain("No iterations yet");
    expect(html).toContain("Frozen Prefix");
    expect(html).toContain("cache-stable across iterations");
    expect(html).toContain("Stable content here");
  });

  test("scorecard table renders with iteration columns", () => {
    const data: CampaignFragmentData = {
      id: "CAMP-003",
      goal: "Multi-iteration goal",
      status: "done",
      frozenPrefix: null,
      iterations: [
        {
          n: 1, startedAt: "2026-05-10T10:00:00Z", endedAt: "2026-05-10T10:15:00Z",
          status: "shipped", executorGoal: "Do step 1", judgeVerdict: "Good progress",
          judgeDecision: "continue", progress: 0.3, confidence: 4, planSnapshot: null,
        },
        {
          n: 2, startedAt: "2026-05-10T10:16:00Z", endedAt: "2026-05-10T10:30:00Z",
          status: "shipped", executorGoal: "Do step 2", judgeVerdict: "Needs replan",
          judgeDecision: "replan", progress: 0.6, confidence: 3, planSnapshot: null,
        },
      ],
      scorecard: [
        {
          iteration_n: 1, started_at: "2026-05-10T10:00:00Z",
          ended_at: "2026-05-10T10:15:00Z", exit_reason: "natural",
          judge_decision: "continue", tokens_used: 50000, cost_usd: 0.15,
        },
        {
          iteration_n: 2, started_at: "2026-05-10T10:16:00Z",
          ended_at: "2026-05-10T10:30:00Z", exit_reason: "natural",
          judge_decision: "replan", tokens_used: 75000, cost_usd: 0.22,
        },
      ],
      initialPlan: null,
      planDiffs: [],
    };

    const html = renderCampaignFragment(data);
    expect(html).toContain("Iter 1");
    expect(html).toContain("Iter 2");
    expect(html).toContain("continue");
    expect(html).toContain("replan");
    expect(html).toContain("$0.15");
    expect(html).toContain("$0.22");
    expect(html).toContain("50K");
    expect(html).toContain("75K");
    expect(html).toContain("30%"); // progress 0.3
    expect(html).toContain("60%"); // progress 0.6
    expect(html).toContain("4/5"); // confidence
    expect(html).toContain("3/5");
  });

  test("missing scorecard cells render as dashes", () => {
    const data: CampaignFragmentData = {
      id: "CAMP-004",
      goal: "Sparse data",
      status: "running",
      frozenPrefix: null,
      iterations: [
        {
          n: 1, startedAt: "", endedAt: "", status: "running",
          executorGoal: "Current work", judgeVerdict: null,
          judgeDecision: null, progress: null, confidence: null,
          planSnapshot: null,
        },
      ],
      scorecard: [
        {
          iteration_n: 1, started_at: "2026-05-10T10:00:00Z",
          ended_at: "2026-05-10T10:15:00Z", exit_reason: "natural",
          judge_decision: "continue", tokens_used: 30000, cost_usd: 0.09,
        },
      ],
      initialPlan: null,
      planDiffs: [],
    };

    const html = renderCampaignFragment(data);
    // Progress/confidence are null → should show "—"
    expect(html).toContain("—");
  });

  test("iteration blocks are collapsible details elements", () => {
    const data: CampaignFragmentData = {
      id: "CAMP-005",
      goal: "Test collapsible",
      status: "done",
      frozenPrefix: null,
      iterations: [
        {
          n: 1, startedAt: "2026-05-10T10:00:00Z", endedAt: "2026-05-10T10:15:00Z",
          status: "shipped", executorGoal: "Build the thing",
          judgeVerdict: "Successfully built", judgeDecision: "done",
          progress: 0.95, confidence: 5, planSnapshot: null,
        },
      ],
      scorecard: [{
        iteration_n: 1, started_at: "2026-05-10T10:00:00Z",
        ended_at: "2026-05-10T10:15:00Z", exit_reason: "natural",
        judge_decision: "done", tokens_used: 100000, cost_usd: 0.30,
      }],
      initialPlan: null,
      planDiffs: [],
    };

    const html = renderCampaignFragment(data);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Iteration 1");
    expect(html).toContain("Build the thing");
    expect(html).toContain("Successfully built");
  });

  test("frozen prefix shown in monospace with label", () => {
    const data: CampaignFragmentData = {
      id: "CAMP-006",
      goal: "Prefix test",
      status: "running",
      frozenPrefix: "# Campaign Frozen Prefix (v0.1.0)\n\n## Prime Directive\n\nYou are a judge.",
      iterations: [],
      scorecard: [],
      initialPlan: null,
      planDiffs: [],
    };

    const html = renderCampaignFragment(data);
    expect(html).toContain("frozen-prefix-label");
    expect(html).toContain("Frozen Prefix");
    expect(html).toContain("cache-stable across iterations");
    expect(html).toContain("<pre");
    expect(html).toContain("You are a judge.");
  });

  test("plan diffs use +/- line format", () => {
    const data: CampaignFragmentData = {
      id: "CAMP-007",
      goal: "Diff test",
      status: "done",
      frozenPrefix: null,
      iterations: [],
      scorecard: [],
      initialPlan: "Step 1: Build A\nStep 2: Build B",
      planDiffs: [
        {
          fromIter: 0,
          toIter: 2,
          diff: "  Step 1: Build A\n- Step 2: Build B\n+ Step 2: Redesign B\n+ Step 3: Wire C",
        },
      ],
    };

    const html = renderCampaignFragment(data);
    expect(html).toContain("Plan Changes");
    expect(html).toContain("Iter 0");
    expect(html).toContain("Iter 2");
    expect(html).toContain("diff-add");
    expect(html).toContain("diff-del");
    expect(html).toContain("diff-ctx");
    expect(html).toContain("Redesign B");
  });

  // ---------------------------------------------------------------------------
  // Snapshot test: 3-iteration partial campaign
  // ---------------------------------------------------------------------------

  test("snapshot: 3-iteration partial campaign", () => {
    const data: CampaignFragmentData = {
      id: "CAMP-010",
      goal: "Implement the full campaign dispatch system with orchestrator, judge, and executor",
      status: "running",
      frozenPrefix: [
        "# Campaign Frozen Prefix (v0.1.0)",
        "",
        "## Prime Directive",
        "",
        "You are a campaign judge.",
        "",
        "## Scope Fence",
        "",
        "Do not modify files outside the workspace.",
        "",
        "## Goal",
        "",
        "Implement the full campaign dispatch system.",
      ].join("\n"),
      iterations: [
        {
          n: 1,
          startedAt: "2026-05-10T08:00:00Z",
          endedAt: "2026-05-10T08:25:00Z",
          status: "shipped",
          executorGoal: "Build campaign state module: init, read, write, scorecard helpers",
          judgeVerdict: "State module shipped with 15 tests. All CRUD operations verified.",
          judgeDecision: "continue",
          progress: 0.25,
          confidence: 4,
          planSnapshot: null,
        },
        {
          n: 2,
          startedAt: "2026-05-10T08:26:00Z",
          endedAt: "2026-05-10T08:50:00Z",
          status: "shipped",
          executorGoal: "Build orchestrator main loop with iteration dispatch",
          judgeVerdict: "Orchestrator loop works but executor spawn has a shell-escaping bug. Replan to fix spawn before adding judge.",
          judgeDecision: "replan",
          progress: 0.45,
          confidence: 3,
          planSnapshot: "Step 1: State module (done)\nStep 2: Fix executor spawn escaping\nStep 3: Add judge calls\nStep 4: Wire CLI",
        },
        {
          n: 3,
          startedAt: "2026-05-10T08:51:00Z",
          endedAt: "2026-05-10T09:10:00Z",
          status: "shipped",
          executorGoal: "Fix executor spawn: use structured JSON over the wire instead of shell interpolation",
          judgeVerdict: "Spawn fixed. Tests passing. Ready to wire judge.",
          judgeDecision: "continue",
          progress: 0.6,
          confidence: 4,
          planSnapshot: null,
        },
      ],
      scorecard: [
        {
          iteration_n: 1, started_at: "2026-05-10T08:00:00Z",
          ended_at: "2026-05-10T08:25:00Z", exit_reason: "natural",
          judge_decision: "continue", tokens_used: 85000, cost_usd: 0.26,
        },
        {
          iteration_n: 2, started_at: "2026-05-10T08:26:00Z",
          ended_at: "2026-05-10T08:50:00Z", exit_reason: "natural",
          judge_decision: "replan", tokens_used: 120000, cost_usd: 0.36,
        },
        {
          iteration_n: 3, started_at: "2026-05-10T08:51:00Z",
          ended_at: "2026-05-10T09:10:00Z", exit_reason: "natural",
          judge_decision: "continue", tokens_used: 95000, cost_usd: 0.29,
        },
      ],
      initialPlan: "Step 1: Build state module\nStep 2: Build orchestrator\nStep 3: Add judge\nStep 4: Wire CLI",
      planDiffs: [
        {
          fromIter: 0,
          toIter: 2,
          diff: [
            "  Step 1: Build state module",
            "- Step 2: Build orchestrator",
            "- Step 3: Add judge",
            "+ Step 2: Fix executor spawn escaping",
            "+ Step 3: Add judge calls",
            "  Step 4: Wire CLI",
          ].join("\n"),
        },
      ],
    };

    const html = renderCampaignFragment(data);

    // Structural assertions
    expect(html).toContain('data-campaign-id="CAMP-010"');
    expect(html).toContain("campaign-fragment");

    // Goal section
    expect(html).toContain("Implement the full campaign dispatch system");

    // Scorecard table
    expect(html).toContain("scorecard-table");
    expect(html).toContain("Iter 1");
    expect(html).toContain("Iter 2");
    expect(html).toContain("Iter 3");
    expect(html).toContain("continue");
    expect(html).toContain("replan");
    expect(html).toContain("$0.26");
    expect(html).toContain("$0.36");
    expect(html).toContain("$0.29");
    expect(html).toContain("85K");
    expect(html).toContain("120K");
    expect(html).toContain("95K");
    expect(html).toContain("25%"); // iter 1 progress
    expect(html).toContain("45%"); // iter 2 progress
    expect(html).toContain("60%"); // iter 3 progress

    // Iteration blocks
    expect(html).toContain("Iteration 1");
    expect(html).toContain("Iteration 2");
    expect(html).toContain("Iteration 3");
    expect(html).toContain("campaign state module");
    expect(html).toContain("orchestrator main loop");
    expect(html).toContain("executor spawn");
    expect(html).toContain("State module shipped");
    expect(html).toContain("shell-escaping bug");
    expect(html).toContain("Spawn fixed");

    // Frozen prefix
    expect(html).toContain("frozen-prefix-label");
    expect(html).toContain("cache-stable across iterations");
    expect(html).toContain("You are a campaign judge");

    // Plan diffs
    expect(html).toContain("Plan Changes");
    expect(html).toContain("diff-add");
    expect(html).toContain("diff-del");
    expect(html).toContain("Fix executor spawn escaping");

    // Snapshot: ensure the HTML parses as valid structure
    // (no unclosed tags, balanced details/summary)
    const detailsCount = (html.match(/<details/g) || []).length;
    const detailsCloseCount = (html.match(/<\/details>/g) || []).length;
    expect(detailsCount).toBe(detailsCloseCount);
    expect(detailsCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeSimpleDiff
// ---------------------------------------------------------------------------

describe("computeSimpleDiff", () => {
  test("identical content produces no markers", () => {
    const result = computeSimpleDiff("a\nb\nc", "a\nb\nc");
    expect(result).not.toContain("+ ");
    expect(result).not.toContain("- ");
  });

  test("added lines get + prefix", () => {
    const result = computeSimpleDiff("a\nb", "a\nb\nc");
    expect(result).toContain("+ c");
  });

  test("removed lines get - prefix", () => {
    const result = computeSimpleDiff("a\nb\nc", "a\nc");
    expect(result).toContain("- b");
  });

  test("changed lines show both - and +", () => {
    const result = computeSimpleDiff("a\nold\nc", "a\nnew\nc");
    expect(result).toContain("- old");
    expect(result).toContain("+ new");
    expect(result).toContain("  a");
    expect(result).toContain("  c");
  });
});
