// Per-model pricing for HIVE LLM calls. Rates are easy to edit — when
// Anthropic shifts list prices, change the table; the rest follows.
//
// Source: Anthropic public pricing as of 2026-01.

export interface ModelRate {
  inputPerMTok: number;   // USD per million input tokens
  outputPerMTok: number;  // USD per million output tokens
}

const RATES: Record<string, ModelRate> = {
  // Sonnet family
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },

  // Opus family
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-opus-4-6": { inputPerMTok: 15, outputPerMTok: 75 },

  // Haiku family
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function rateForModel(modelId: string): ModelRate | null {
  return RATES[modelId] ?? null;
}

export interface UsageDelta {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  modelKnown: boolean;
}

export function estimateCost(usage: UsageDelta): CostBreakdown {
  const rate = rateForModel(usage.model);
  if (!rate) {
    return { inputUsd: 0, outputUsd: 0, totalUsd: 0, modelKnown: false };
  }
  const inputUsd = (usage.inputTokens / 1_000_000) * rate.inputPerMTok;
  const outputUsd = (usage.outputTokens / 1_000_000) * rate.outputPerMTok;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    modelKnown: true,
  };
}

/** Format a USD amount to a short string. Pennies for < $1, two decimals otherwise. */
export function formatUsd(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Run-level usage aggregation — runs/{DATE}/usage.json
// Used by Pass B, C, and V to log their token + cost spend per run.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HivePaths } from "./paths";

export interface PassUsageRecord {
  pass: "B" | "C" | "V" | "TA" | "TB" | "TC";
  project?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  cost: CostBreakdown;
  recordedAt: string;
}

export interface RunUsageSummary {
  date: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalUsd: number;
  };
  records: PassUsageRecord[];
}

export function usagePath(paths: HivePaths, date: string): string {
  return join(paths.memoryRunsDir, date, "usage.json");
}

export async function loadUsageSummary(
  paths: HivePaths,
  date: string,
): Promise<RunUsageSummary> {
  const file = usagePath(paths, date);
  if (!existsSync(file)) {
    return {
      date,
      totals: { inputTokens: 0, outputTokens: 0, totalUsd: 0 },
      records: [],
    };
  }
  return JSON.parse(await Bun.file(file).text()) as RunUsageSummary;
}

export async function appendUsageRecord(
  paths: HivePaths,
  date: string,
  record: Omit<PassUsageRecord, "recordedAt"> & { recordedAt?: string },
): Promise<RunUsageSummary> {
  const summary = await loadUsageSummary(paths, date);
  const stamped: PassUsageRecord = {
    ...record,
    recordedAt: record.recordedAt ?? new Date().toISOString(),
  };
  summary.records.push(stamped);
  summary.totals.inputTokens += stamped.inputTokens;
  summary.totals.outputTokens += stamped.outputTokens;
  summary.totals.totalUsd += stamped.cost.totalUsd;

  await mkdir(dirname(usagePath(paths, date)), { recursive: true });
  await Bun.write(usagePath(paths, date), JSON.stringify(summary, null, 2));
  return summary;
}
