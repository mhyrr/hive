/**
 * Campaign orchestrator main loop (TK-078, C5).
 *
 * Deterministic TypeScript loop that drives the campaign lifecycle:
 *   iterate → (executor → judge → apply decision) → iterate
 *
 * Design invariants:
 * - Frozen prefix loaded once at start, never rewritten mid-run.
 * - Stateless across iterations: each judge call gets curated fresh content,
 *   not accumulated raw context.
 * - Scorecard is append-only: one row per iteration, no gaps.
 * - Hard limits (max iterations, max cost, max wall-clock) checked between iterations.
 * - `second_opinion: yes` from the judge is recorded but does not alter control flow.
 */

import { toIsoTimestamp } from "../time";
import {
  type CampaignState,
  type ScorecardRow,
  readCampaignState,
  appendScorecardRow,
  writePlan,
  writeCheckpoint,
  writeStatus,
  readCheckpoint,
  latestPlan,
} from "./state";
import type { IterationResult, RunIterationOpts } from "./executor";
import type { JudgeVerdict, RunJudgeOpts } from "./judge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CampaignLimits = {
  /** Max number of iterations before forced termination. Default 12. */
  maxIterations: number;
  /** Max total cost in USD across all iterations. Default 40. */
  maxCostUsd: number;
  /** Max wall-clock milliseconds from campaign start. Default 8h. */
  maxWalltimeMs: number;
};

export const DEFAULT_LIMITS: CampaignLimits = {
  maxIterations: 12,
  maxCostUsd: 40,
  maxWalltimeMs: 8 * 60 * 60 * 1000, // 8 hours
};

export type TerminationReason =
  | "judge_done"
  | "max_iterations"
  | "max_cost"
  | "max_walltime"
  | "executor_crashed";

export type CampaignResult = {
  campaignId: string;
  terminationReason: TerminationReason;
  iterationsCompleted: number;
  totalCostUsd: number;
  totalTokens: number;
  totalWalltimeMs: number;
};

/**
 * Executor function signature — matches runIteration from executor.ts.
 * Injected so tests can stub without spawning Claude.
 */
export type ExecutorFn = (opts: RunIterationOpts) => Promise<IterationResult>;

/**
 * Judge function signature — matches runJudge from judge.ts.
 * Injected so tests can stub without spawning Claude.
 */
export type JudgeFn = (opts: RunJudgeOpts) => Promise<JudgeVerdict>;

export type RunCampaignOpts = {
  /** Campaign ID (e.g. "CAMP-001"). */
  campaignId: string;
  /** Hard limits for the campaign. */
  limits?: Partial<CampaignLimits>;
  /** Executor function (injected for testability). */
  executor: ExecutorFn;
  /** Judge function (injected for testability). */
  judge: JudgeFn;
  /** Override HIVE_HOME for testing. */
  hiveHome?: string;
  /** Cost per token in USD. Default $0.000003 (rough Opus average). */
  costPerToken?: number;
};

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

const DEFAULT_COST_PER_TOKEN = 0.000003;

function estimateCost(tokens: number, costPerToken: number): number {
  return Math.round(tokens * costPerToken * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Replan: apply plan_diff to plan.md
// ---------------------------------------------------------------------------

/**
 * Apply a plan_diff from the judge to the current plan.
 *
 * V1 strategy: the plan_diff is treated as the judge's description of what
 * should change. We replace the plan entirely with the diff content — the
 * judge is instructed to provide a complete replacement plan when replanning.
 *
 * Future versions could implement structured diff/patch semantics.
 */
export async function applyReplan(
  campaignId: string,
  planDiff: string,
  hiveHome?: string,
): Promise<void> {
  await writePlan(campaignId, planDiff, hiveHome);
}

// ---------------------------------------------------------------------------
// Hard-limit checks
// ---------------------------------------------------------------------------

export type LimitCheck = {
  exceeded: boolean;
  reason: TerminationReason | null;
};

export function checkLimits(
  iterationN: number,
  totalCostUsd: number,
  elapsedMs: number,
  limits: CampaignLimits,
): LimitCheck {
  if (iterationN > limits.maxIterations) {
    return {
      exceeded: true,
      reason: "max_iterations",
    };
  }
  if (totalCostUsd >= limits.maxCostUsd) {
    return {
      exceeded: true,
      reason: "max_cost",
    };
  }
  if (elapsedMs >= limits.maxWalltimeMs) {
    return {
      exceeded: true,
      reason: "max_walltime",
    };
  }
  return { exceeded: false, reason: null };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runCampaign(opts: RunCampaignOpts): Promise<CampaignResult> {
  const {
    campaignId,
    executor,
    judge,
    hiveHome,
    costPerToken = DEFAULT_COST_PER_TOKEN,
  } = opts;

  const limits: CampaignLimits = {
    ...DEFAULT_LIMITS,
    ...opts.limits,
  };

  const startTime = Date.now();
  let totalTokens = 0;
  let totalCostUsd = 0;
  let iterationsCompleted = 0;

  // --- Load initial state ---
  const initialState = await readCampaignState(campaignId, hiveHome);
  if (!initialState) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  // --- Load frozen prefix once ---
  const frozenPrefix = initialState.frozenPrefix;
  if (!frozenPrefix) {
    throw new Error(`Campaign ${campaignId} has no frozen prefix`);
  }

  // --- Ensure status is running ---
  await writeStatus(campaignId, "running", hiveHome);

  // --- Main loop ---
  while (true) {
    const iterationN = iterationsCompleted + 1;

    // Pre-iteration limit check
    const elapsedMs = Date.now() - startTime;
    const limitCheck = checkLimits(iterationN, totalCostUsd, elapsedMs, limits);
    if (limitCheck.exceeded) {
      // All three budget caps (max_cost, max_iterations, max_walltime) are normal
      // budget terminations — campaign did all it could within constraints. Reserve
      // "aborted" for genuine aborts (crash, manual stop, judge_decision=abort).
      await writeStatus(campaignId, "budget-exhausted", hiveHome);
      return {
        campaignId,
        terminationReason: limitCheck.reason!,
        iterationsCompleted,
        totalCostUsd,
        totalTokens,
        totalWalltimeMs: Date.now() - startTime,
      };
    }

    // Refresh state for this iteration (re-read mutable fields: plan, checkpoint, scorecard)
    const state = await readCampaignState(campaignId, hiveHome);
    if (!state) {
      throw new Error(`Campaign ${campaignId} disappeared mid-run`);
    }

    // Enforce frozen prefix discipline: use the one loaded at start
    state.frozenPrefix = frozenPrefix;

    const iterStartedAt = toIsoTimestamp();

    // --- Run executor (C3) ---
    const iterResult = await executor({
      state,
      iterationN,
    } as RunIterationOpts);

    // Accumulate costs
    const iterCost = estimateCost(iterResult.tokensUsed, costPerToken);
    totalTokens += iterResult.tokensUsed;
    totalCostUsd += iterCost;

    // If executor crashed, record and check if we should continue
    if (iterResult.exitReason === "crashed") {
      const crashRow: ScorecardRow = {
        iteration_n: iterationN,
        started_at: iterStartedAt,
        ended_at: toIsoTimestamp(),
        exit_reason: "error",
        judge_decision: "continue",
        tokens_used: iterResult.tokensUsed,
        cost_usd: iterCost,
      };
      await appendScorecardRow(campaignId, crashRow, hiveHome);
      iterationsCompleted++;

      // Don't run judge after crash — check limits and try next iteration
      const postCrashCheck = checkLimits(iterationsCompleted + 1, totalCostUsd, Date.now() - startTime, limits);
      if (postCrashCheck.exceeded) {
        await writeStatus(campaignId, "aborted", hiveHome);
        return {
          campaignId,
          terminationReason: postCrashCheck.reason!,
          iterationsCompleted,
          totalCostUsd,
          totalTokens,
          totalWalltimeMs: Date.now() - startTime,
        };
      }
      continue;
    }

    // --- Read updated checkpoint if executor wrote one ---
    if (iterResult.checkpointPath) {
      const checkpointContent = await readCheckpoint(campaignId, hiveHome);
      if (checkpointContent) {
        // Checkpoint is already in the workspace — state will pick it up on re-read
      }
    }

    // --- Re-read state for judge (fresh mutable content) ---
    const judgeState = await readCampaignState(campaignId, hiveHome);
    if (!judgeState) {
      throw new Error(`Campaign ${campaignId} disappeared after executor`);
    }
    judgeState.frozenPrefix = frozenPrefix;

    // --- Run judge (C4) ---
    const verdict = await judge({
      state: judgeState,
      iterationN,
    } as RunJudgeOpts);

    // Map exit reasons
    const exitReasonMap: Record<string, ScorecardRow["exit_reason"]> = {
      clean: "natural",
      soft_triggered: "timeout",
      hard_killed: "hard-cap",
      crashed: "error",
    };

    // --- Append scorecard row ---
    const row: ScorecardRow = {
      iteration_n: iterationN,
      started_at: iterStartedAt,
      ended_at: toIsoTimestamp(),
      exit_reason: exitReasonMap[iterResult.exitReason] ?? "error",
      judge_decision: verdict.decision,
      tokens_used: iterResult.tokensUsed,
      cost_usd: iterCost,
    };
    await appendScorecardRow(campaignId, row, hiveHome);
    iterationsCompleted++;

    // --- Apply judge decision ---
    if (verdict.decision === "done") {
      await writeStatus(campaignId, "done", hiveHome);
      return {
        campaignId,
        terminationReason: "judge_done",
        iterationsCompleted,
        totalCostUsd,
        totalTokens,
        totalWalltimeMs: Date.now() - startTime,
      };
    }

    if (verdict.decision === "replan" && verdict.plan_diff) {
      await applyReplan(campaignId, verdict.plan_diff, hiveHome);
    }

    // `continue` and `replan` both loop to next iteration.
    // `second_opinion: yes` is already captured in the verdict but we don't
    // act on it in V1 — it lives in the scorecard row's judge_decision context.
  }
}
