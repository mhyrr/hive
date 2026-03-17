import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { type HivePaths, getProjectPaths } from "./paths";
import { listAllRunResults } from "./runs";
import { getSessionHistory, listSessions, type SessionTurn } from "./sessions";
import { now, toIsoTimestamp } from "./time";

export type CognitiveUsageTierKey = "tier1" | "tier2" | "tier3";
export type CognitiveUsageBudgetStatus = "unconfigured" | "ok" | "approaching" | "over";

export type CognitiveUsageTierTotals = {
  invocations: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
};

export type CognitiveUsageBudget = {
  tier: CognitiveUsageTierKey;
  tokenLimit: number | null;
  usedTokens: number;
  remainingTokens: number | null;
  ratio: number | null;
  status: CognitiveUsageBudgetStatus;
};

export type CognitiveUsageSnapshot = {
  project: string;
  generatedAt: string;
  windowHours: number;
  windowStartedAt: string;
  tiers: Record<CognitiveUsageTierKey, CognitiveUsageTierTotals>;
  budgets: Record<CognitiveUsageTierKey, CognitiveUsageBudget>;
  summary: {
    estimatedCostUsd: number | null;
    stewardWakes: number;
    workerRuns: number;
    tier1Calls: number;
    lastStewardWakeAt: string | null;
  };
};

function extractConfigValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));

  return match ? match[1].trim() : null;
}

function extractConfigValueAlias(input: string, keys: string[]): string | null {
  for (const key of keys) {
    const value = extractConfigValue(input, key);

    if (value) {
      return value;
    }
  }

  return null;
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value.trim());

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveFloat(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value.trim());

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function emptyTierTotals(): CognitiveUsageTierTotals {
  return {
    invocations: 0,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };
}

function addNullableNumber(current: number | null, value: number | null | undefined): number | null {
  if (value == null) {
    return current;
  }

  return (current ?? 0) + value;
}

function addUsage(input: {
  totals: CognitiveUsageTierTotals;
  invocations?: number;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  totalTokens?: number | null;
}): void {
  input.totals.invocations += input.invocations ?? 1;
  input.totals.costUsd = addNullableNumber(input.totals.costUsd, input.costUsd ?? null);
  input.totals.inputTokens += input.inputTokens ?? 0;
  input.totals.outputTokens += input.outputTokens ?? 0;
  input.totals.cacheCreationInputTokens += input.cacheCreationInputTokens ?? 0;
  input.totals.cacheReadInputTokens += input.cacheReadInputTokens ?? 0;
  input.totals.totalTokens += input.totalTokens ?? 0;
}

function resolveTurnRecordedAt(sessionStartedAt: string, turn: SessionTurn): string | null {
  const recordedAt = turn.details?.recordedAt?.trim();

  if (recordedAt) {
    return recordedAt;
  }

  if (/^\d{2}:\d{2}:\d{2}$/.test(turn.ts)) {
    return `${sessionStartedAt.slice(0, 10)}T${turn.ts}Z`;
  }

  return null;
}

function isWithinWindow(timestamp: string | null, windowStartedMs: number): boolean {
  if (!timestamp) {
    return false;
  }

  const parsed = Date.parse(timestamp);

  return Number.isFinite(parsed) && parsed >= windowStartedMs;
}

function buildBudget(input: {
  tier: CognitiveUsageTierKey;
  usedTokens: number;
  tokenLimit: number | null;
  warnRatio: number;
}): CognitiveUsageBudget {
  if (!input.tokenLimit) {
    return {
      tier: input.tier,
      tokenLimit: null,
      usedTokens: input.usedTokens,
      remainingTokens: null,
      ratio: null,
      status: "unconfigured",
    };
  }

  const ratio = input.usedTokens / input.tokenLimit;

  return {
    tier: input.tier,
    tokenLimit: input.tokenLimit,
    usedTokens: input.usedTokens,
    remainingTokens: Math.max(0, input.tokenLimit - input.usedTokens),
    ratio,
    status:
      input.usedTokens >= input.tokenLimit
        ? "over"
        : ratio >= input.warnRatio
          ? "approaching"
          : "ok",
  };
}

function readUsagePolicy(globalConfig: string): {
  windowHours: number;
  warnRatio: number;
  budgets: Record<CognitiveUsageTierKey, number | null>;
} {
  const windowHours = parsePositiveInt(
    extractConfigValueAlias(globalConfig, ["cognitive-window-hours", "cognitive_window_hours"]),
  ) ?? 24;
  const warnRatio = Math.min(
    0.99,
    Math.max(
      0.5,
      parsePositiveFloat(
        extractConfigValueAlias(globalConfig, ["cognitive-budget-warn-ratio", "cognitive_budget_warn_ratio"]),
      ) ?? 0.9,
    ),
  );

  return {
    windowHours,
    warnRatio,
    budgets: {
      tier1:
        parsePositiveInt(
          extractConfigValueAlias(globalConfig, ["cognitive-budget-tier1-tokens", "cognitive_budget_tier1_tokens"]),
        ) ?? null,
      tier2:
        parsePositiveInt(
          extractConfigValueAlias(globalConfig, ["cognitive-budget-tier2-tokens", "cognitive_budget_tier2_tokens"]),
        ) ?? null,
      tier3:
        parsePositiveInt(
          extractConfigValueAlias(globalConfig, ["cognitive-budget-tier3-tokens", "cognitive_budget_tier3_tokens"]),
        ) ?? null,
    },
  };
}

export async function buildProjectCognitiveUsageSnapshot(input: {
  hivePaths: HivePaths;
  projectId: string;
  globalConfig: string;
}): Promise<CognitiveUsageSnapshot> {
  const policy = readUsagePolicy(input.globalConfig);
  const projectPaths = getProjectPaths(input.hivePaths, input.projectId);
  const generatedAt = toIsoTimestamp(now());
  const windowStartedMs = Date.parse(generatedAt) - policy.windowHours * 60 * 60 * 1000;
  const tiers = {
    tier1: emptyTierTotals(),
    tier2: emptyTierTotals(),
    tier3: emptyTierTotals(),
  } satisfies Record<CognitiveUsageTierKey, CognitiveUsageTierTotals>;
  let workerRuns = 0;
  let tier1Calls = 0;
  let stewardWakes = 0;
  let lastStewardWakeAt: string | null = null;

  const runResults = await listAllRunResults(projectPaths);

  for (const result of runResults) {
    if (!isWithinWindow(result.ended, windowStartedMs)) {
      continue;
    }

    if (result.agentId !== "console" && result.agentId !== "steward") {
      workerRuns += 1;
      addUsage({
        totals: tiers.tier2,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        totalTokens: result.totalTokens,
      });
    }

    if (result.cognitiveDigest) {
      tier1Calls += 1;
      addUsage({
        totals: tiers.tier1,
        inputTokens: result.cognitiveDigest.inputTokens,
        outputTokens: result.cognitiveDigest.outputTokens,
        totalTokens: result.cognitiveDigest.totalTokens,
      });
    }
  }

  const sessions = await listSessions(input.hivePaths.sessionsDir);

  for (const session of sessions) {
    const turns = await getSessionHistory(input.hivePaths.sessionsDir, session.sessionId);

    for (const turn of turns) {
      if (turn.role !== "assistant" || !turn.details || turn.details.project !== input.projectId) {
        continue;
      }

      const tier = turn.details.routing?.tier ?? null;

      if (tier !== "tier1" && tier !== "tier3") {
        continue;
      }

      const recordedAt = resolveTurnRecordedAt(session.started, turn);

      if (!isWithinWindow(recordedAt, windowStartedMs)) {
        continue;
      }

      addUsage({
        totals: tiers[tier],
        costUsd: turn.details.costUsd,
        inputTokens: turn.details.inputTokens,
        outputTokens: turn.details.outputTokens,
        cacheCreationInputTokens: turn.details.cacheCreationInputTokens,
        cacheReadInputTokens: turn.details.cacheReadInputTokens,
        totalTokens: turn.details.totalTokens,
      });

      if (tier === "tier1") {
        tier1Calls += 1;
      } else {
        stewardWakes += 1;
        if (!lastStewardWakeAt || recordedAt > lastStewardWakeAt) {
          lastStewardWakeAt = recordedAt;
        }
      }
    }
  }

  const estimatedCostUsd =
    (tiers.tier1.costUsd ?? 0) + (tiers.tier2.costUsd ?? 0) + (tiers.tier3.costUsd ?? 0);
  const hasKnownCost =
    tiers.tier1.costUsd !== null || tiers.tier2.costUsd !== null || tiers.tier3.costUsd !== null;

  return {
    project: input.projectId,
    generatedAt,
    windowHours: policy.windowHours,
    windowStartedAt: new Date(windowStartedMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    tiers,
    budgets: {
      tier1: buildBudget({
        tier: "tier1",
        usedTokens: tiers.tier1.totalTokens,
        tokenLimit: policy.budgets.tier1,
        warnRatio: policy.warnRatio,
      }),
      tier2: buildBudget({
        tier: "tier2",
        usedTokens: tiers.tier2.totalTokens,
        tokenLimit: policy.budgets.tier2,
        warnRatio: policy.warnRatio,
      }),
      tier3: buildBudget({
        tier: "tier3",
        usedTokens: tiers.tier3.totalTokens,
        tokenLimit: policy.budgets.tier3,
        warnRatio: policy.warnRatio,
      }),
    },
    summary: {
      estimatedCostUsd: hasKnownCost ? estimatedCostUsd : null,
      stewardWakes,
      workerRuns,
      tier1Calls,
      lastStewardWakeAt,
    },
  };
}

export async function refreshProjectCognitiveUsageSnapshot(input: {
  hivePaths: HivePaths;
  projectId: string;
  globalConfig: string;
}): Promise<CognitiveUsageSnapshot> {
  const projectPaths = getProjectPaths(input.hivePaths, input.projectId);
  const snapshot = await buildProjectCognitiveUsageSnapshot(input);

  await mkdir(dirname(projectPaths.stateUsage), { recursive: true });
  await Bun.write(projectPaths.stateUsage, `${JSON.stringify(snapshot, null, 2)}\n`);

  return snapshot;
}
