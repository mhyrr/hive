/**
 * Campaign fragment data collector.
 *
 * Reads a single campaign directory and produces the CampaignFragmentData
 * shape consumed by renderCampaignFragment(). Pure I/O: reads files, returns
 * data. No rendering, no side effects.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { HivePaths } from "../../paths";
import type { ScorecardRow } from "../../campaign/state";
import {
  type CampaignFragmentData,
  type IterationBlock,
  computeSimpleDiff,
} from "./campaign-fragment";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function parseScorecardJsonl(raw: string): ScorecardRow[] {
  const rows: ScorecardRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as ScorecardRow);
    } catch {
      // Skip malformed lines
    }
  }
  return rows;
}

/**
 * Map scorecard row exit_reason + judge_decision to a display status.
 */
function iterationStatus(
  row: ScorecardRow | undefined,
): "shipped" | "partial" | "failed" | "running" {
  if (!row) return "running";
  if (row.exit_reason === "error") return "failed";
  if (row.judge_decision === "done") return "shipped";
  if (row.exit_reason === "hard-cap" || row.exit_reason === "timeout") return "partial";
  return "shipped"; // natural exit with continue/replan is still a successful iteration
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect data for a single campaign's drill-in fragment.
 * Returns null if the campaign directory doesn't exist or has no status file.
 */
export async function collectCampaignFragment(
  campId: string,
  paths: HivePaths,
): Promise<CampaignFragmentData | null> {
  const campDir = join(paths.campaignsDir, campId);

  const statusRaw = await safeRead(join(campDir, "status"));
  if (statusRaw === null) return null;

  // Goal — from config.json or goal.md or frozen-prefix
  let goal = "";
  const configRaw = await safeRead(join(campDir, "config.json"));
  if (configRaw) {
    try {
      const cfg = JSON.parse(configRaw);
      goal = cfg.goal ?? "";
    } catch {
      // fallthrough
    }
  }
  if (!goal) {
    goal = (await safeRead(join(campDir, "goal.md")))?.trim() ?? "";
  }
  // Last resort: extract from frozen prefix
  if (!goal) {
    const prefix = await safeRead(join(campDir, "frozen-prefix.md"));
    if (prefix) {
      const marker = "## Goal\n\n";
      const idx = prefix.lastIndexOf(marker);
      if (idx !== -1) {
        goal = prefix.slice(idx + marker.length).trim();
      }
    }
  }

  const frozenPrefix = await safeRead(join(campDir, "frozen-prefix.md"));
  const initialPlan = await safeRead(join(campDir, "plan.md"));

  // Scorecard
  const scorecardRaw = await safeRead(join(campDir, "scorecard.jsonl"));
  const scorecard = scorecardRaw ? parseScorecardJsonl(scorecardRaw) : [];

  // Iterations
  const iterDir = join(campDir, "iterations");
  const iterEntries = await readdir(iterDir).catch(() => [] as string[]);
  const iterNums = iterEntries
    .map((e) => parseInt(e, 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);

  const iterations: IterationBlock[] = [];
  const planSnapshots: Array<{ n: number; plan: string }> = [];

  for (const n of iterNums) {
    const iterPath = join(iterDir, String(n));
    const scorecardRow = scorecard.find((r) => r.iteration_n === n);

    // Read iteration-level artifacts
    const taskMd = await safeRead(join(iterPath, "task.md"));
    const checkpointMd = await safeRead(join(iterPath, "checkpoint.md"));

    // Judge verdict: look in scorecard-row.json for full judge output
    let judgeVerdict: string | null = null;
    let progress: number | null = null;
    let confidence: number | null = null;
    const judgeRowRaw = await safeRead(join(iterPath, "scorecard-row.json"));
    if (judgeRowRaw) {
      try {
        const judgeRow = JSON.parse(judgeRowRaw);
        judgeVerdict = judgeRow.reasoning ?? null;
        progress = typeof judgeRow.progress_vs_prime === "number" ? judgeRow.progress_vs_prime : null;
        confidence = typeof judgeRow.confidence === "number" ? judgeRow.confidence : null;
      } catch {
        // Ignore parse errors
      }
    }

    // Fallback: use scorecard row data for progress if not in the judge file
    if (progress === null && scorecardRow) {
      // No progress_vs_prime in ScorecardRow type — leave null
    }

    // Plan snapshot — check if plan was updated during this iteration
    const iterPlan = await safeRead(join(iterPath, "plan.md"));
    if (iterPlan) {
      planSnapshots.push({ n, plan: iterPlan });
    }

    const status = iterationStatus(scorecardRow);

    iterations.push({
      n,
      startedAt: scorecardRow?.started_at ?? "",
      endedAt: scorecardRow?.ended_at ?? "",
      status,
      executorGoal: taskMd?.trim() ?? checkpointMd?.trim().slice(0, 300) ?? "(no task recorded)",
      judgeVerdict,
      judgeDecision: scorecardRow?.judge_decision ?? null,
      progress,
      confidence,
      planSnapshot: iterPlan,
    });
  }

  // Compute plan diffs across iterations
  const planDiffs: CampaignFragmentData["planDiffs"] = [];
  const allPlans: Array<{ n: number; plan: string }> = [];
  if (initialPlan) {
    allPlans.push({ n: 0, plan: initialPlan });
  }
  allPlans.push(...planSnapshots);

  for (let i = 1; i < allPlans.length; i++) {
    const before = allPlans[i - 1]!;
    const after = allPlans[i]!;
    if (before.plan !== after.plan) {
      const diff = computeSimpleDiff(before.plan, after.plan);
      planDiffs.push({
        fromIter: before.n,
        toIter: after.n,
        diff,
      });
    }
  }

  return {
    id: campId,
    goal,
    status: statusRaw.trim(),
    frozenPrefix,
    iterations,
    scorecard,
    initialPlan,
    planDiffs,
  };
}
