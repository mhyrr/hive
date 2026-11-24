// Per-model pricing for HIVE LLM calls. Rates are easy to edit — when
// Anthropic shifts list prices, change the table; the rest follows.
//
// Source: Anthropic's model pricing table, read 2026-11-15:
//   https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
// Every column is copied from that table, not derived from a multiplier.
// Cache-hit rates differ by model: Fable 5.1/5.2 read at 0.025× base, Opus 5.5
// and Sonnet 5.5 at 0.05×, every other model at 0.1×. Cache writes cost 1.25×
// base for the 5-minute TTL and 2× base for the 1-hour TTL.
//
// Haiku 5.5 is left out on purpose. It has two price tiers, split at 100k
// prompt tokens, and this table cannot express that. An unlisted model reports
// modelKnown=false, which is better than a wrong number.

export interface ModelRate {
  /** USD per million uncached input tokens. */
  inputPerMTok: number;
  /** USD per million tokens written to the 5-minute prompt cache. */
  cacheWrite5mPerMTok: number;
  /** USD per million tokens written to the 1-hour prompt cache. */
  cacheWrite1hPerMTok: number;
  /** USD per million tokens read from the prompt cache (hits and refreshes). */
  cacheReadPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

function rate(
  inputPerMTok: number,
  cacheWrite5mPerMTok: number,
  cacheWrite1hPerMTok: number,
  cacheReadPerMTok: number,
  outputPerMTok: number,
): ModelRate {
  return { inputPerMTok, cacheWrite5mPerMTok, cacheWrite1hPerMTok, cacheReadPerMTok, outputPerMTok };
}

// prettier-ignore
const RATES: Record<string, ModelRate> = {
  //                     input  5m write  1h write  read   output
  // Fable family
  "claude-fable-5-2":  rate(8,     10,       16,      0.2,   40),
  "claude-fable-5-1":  rate(10,    12.5,     20,      0.25,  50),
  "claude-fable-5":    rate(10,    12.5,     20,      1,     50),

  // Opus family
  "claude-opus-5-5":   rate(4,     5,        8,       0.2,   20),
  "claude-opus-5":     rate(5,     6.25,     10,      0.5,   25),
  "claude-opus-4-8":   rate(5,     6.25,     10,      0.5,   25),
  "claude-opus-4-7":   rate(5,     6.25,     10,      0.5,   25),
  "claude-opus-4-6":   rate(5,     6.25,     10,      0.5,   25),
  "claude-opus-4-5":   rate(5,     6.25,     10,      0.5,   25),

  // Sonnet family
  "claude-sonnet-5-5": rate(2,     2.5,      4,       0.1,   10),
  "claude-sonnet-5":   rate(2,     2.5,      4,       0.2,   10),
  "claude-sonnet-4-6": rate(3,     3.75,     6,       0.3,   15),
  "claude-sonnet-4-5": rate(3,     3.75,     6,       0.3,   15),

  // Haiku family
  "claude-haiku-4-5":  rate(1,     1.25,     2,       0.1,   5),
};

export function rateForModel(modelId: string): ModelRate | null {
  // A trailing `[1m]` selects Claude Code's 1M-context variant of the same model.
  return RATES[modelId.replace(/\[1m\]$/, "")] ?? null;
}

/**
 * The prompt-cache slices of one call's input. Each count is part of the
 * call's full `inputTokens`, never an addition to it.
 */
export interface CacheTokens {
  /** Tokens served from the prompt cache. */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache, both TTLs together. */
  cacheCreationTokens?: number;
  /**
   * The part of cacheCreationTokens written with the 1-hour TTL. `claude
   * --print` writes 1-hour entries (observed 2026-11-15). When this is absent,
   * every write is billed at the 5-minute rate, which is the API default.
   */
  cacheCreation1hTokens?: number;
}

/** Copy only the cache fields, so a usage object can pass them along by spread. */
export function cacheTokensOf(u: CacheTokens): CacheTokens {
  const out: CacheTokens = {};
  if (u.cacheReadTokens !== undefined) out.cacheReadTokens = u.cacheReadTokens;
  if (u.cacheCreationTokens !== undefined) out.cacheCreationTokens = u.cacheCreationTokens;
  if (u.cacheCreation1hTokens !== undefined) out.cacheCreation1hTokens = u.cacheCreation1hTokens;
  return out;
}

/** Sum the cache fields of several calls. */
export function sumCacheTokens(usages: CacheTokens[]): Required<CacheTokens> {
  return {
    cacheReadTokens: usages.reduce((n, u) => n + (u.cacheReadTokens ?? 0), 0),
    cacheCreationTokens: usages.reduce((n, u) => n + (u.cacheCreationTokens ?? 0), 0),
    cacheCreation1hTokens: usages.reduce((n, u) => n + (u.cacheCreation1hTokens ?? 0), 0),
  };
}

export interface UsageDelta extends CacheTokens {
  provider: string;
  model: string;
  /** Full prompt context, cached slices included. */
  inputTokens: number;
  outputTokens: number;
}

/** The three disjoint parts of a call's input. They sum to its inputTokens. */
export interface InputSplit {
  uncachedInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function splitInput(usage: UsageDelta): InputSplit & { cacheCreation1hTokens: number } {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  return {
    uncachedInputTokens: Math.max(0, usage.inputTokens - cacheReadTokens - cacheCreationTokens),
    cacheCreationTokens,
    cacheReadTokens,
    cacheCreation1hTokens: Math.min(usage.cacheCreation1hTokens ?? 0, cacheCreationTokens),
  };
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  modelKnown: boolean;
}

/** Provider tag on usage from the Message Batches transport (TK-168). Batch
 * requests bill at 50% of list on input, output and cache tokens alike
 * (platform.claude.com/docs/en/about-claude/pricing#batch-processing). */
export const BATCH_PROVIDER = "anthropic-batch";
const BATCH_MULTIPLIER = 0.5;

export function estimateCost(usage: UsageDelta): CostBreakdown {
  const r = rateForModel(usage.model);
  if (!r) {
    return { inputUsd: 0, outputUsd: 0, totalUsd: 0, modelKnown: false };
  }
  const s = splitInput(usage);
  const write5m = s.cacheCreationTokens - s.cacheCreation1hTokens;
  const inputUsd =
    (s.uncachedInputTokens * r.inputPerMTok +
      write5m * r.cacheWrite5mPerMTok +
      s.cacheCreation1hTokens * r.cacheWrite1hPerMTok +
      s.cacheReadTokens * r.cacheReadPerMTok) /
    1_000_000;
  const outputUsd = (usage.outputTokens * r.outputPerMTok) / 1_000_000;
  if (usage.provider === BATCH_PROVIDER) {
    return {
      inputUsd: inputUsd * BATCH_MULTIPLIER,
      outputUsd: outputUsd * BATCH_MULTIPLIER,
      totalUsd: (inputUsd + outputUsd) * BATCH_MULTIPLIER,
      modelKnown: true,
    };
  }
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
// Every nightly pass (B, C, V and the taste track) logs its token + cost spend
// here, one record per pass, built by buildUsageRecord.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HivePaths } from "./paths";

/** "VS" is the shadow verifier (TK-166): neighbour-scoped V calls that decide
 * but never apply. Kept apart from "V" so the shadow week's cost shows. */
export type UsagePass = "B" | "C" | "V" | "VS" | "TA" | "TB" | "TC" | "TR";

export interface PassUsageRecord extends Partial<InputSplit> {
  pass: UsagePass;
  project?: string;
  provider: string;
  model: string;
  /**
   * Full prompt context: uncachedInputTokens + cacheCreationTokens +
   * cacheReadTokens. The three parts are absent on records written before
   * TK-120 (2026-11-15).
   */
  inputTokens: number;
  /** The part of cacheCreationTokens written with the 1-hour TTL. */
  cacheCreation1hTokens?: number;
  outputTokens: number;
  durationMs: number | null;
  cost: CostBreakdown;
  recordedAt: string;
}

export interface RunUsageTotals extends Partial<InputSplit> {
  inputTokens: number;
  outputTokens: number;
  totalUsd: number;
}

export interface RunUsageSummary {
  date: string;
  /**
   * Sums over `records`. The three input parts appear only when every record
   * carries them, so they always add up to inputTokens.
   */
  totals: RunUsageTotals;
  records: PassUsageRecord[];
}

/**
 * The one way to turn a pass's usage into a usage.json record. It prices the
 * call and keeps the input split, so no call site can drop the cache fields.
 */
export function buildUsageRecord(
  pass: UsagePass,
  usage: UsageDelta & { durationMs: number | null },
  project?: string,
): Omit<PassUsageRecord, "recordedAt"> {
  const s = splitInput(usage);
  return {
    pass,
    ...(project !== undefined ? { project } : {}),
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens,
    uncachedInputTokens: s.uncachedInputTokens,
    cacheCreationTokens: s.cacheCreationTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheCreation1hTokens: s.cacheCreation1hTokens,
    outputTokens: usage.outputTokens,
    durationMs: usage.durationMs,
    cost: estimateCost(usage),
  };
}

function hasInputSplit(r: Partial<InputSplit>): r is InputSplit {
  return (
    r.uncachedInputTokens !== undefined &&
    r.cacheCreationTokens !== undefined &&
    r.cacheReadTokens !== undefined
  );
}

export function totalsOf(records: PassUsageRecord[]): RunUsageTotals {
  const totals: RunUsageTotals = {
    inputTokens: records.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: records.reduce((n, r) => n + r.outputTokens, 0),
    totalUsd: records.reduce((n, r) => n + r.cost.totalUsd, 0),
  };
  if (records.length > 0 && records.every(hasInputSplit)) {
    totals.uncachedInputTokens = records.reduce((n, r) => n + (r.uncachedInputTokens ?? 0), 0);
    totals.cacheCreationTokens = records.reduce((n, r) => n + (r.cacheCreationTokens ?? 0), 0);
    totals.cacheReadTokens = records.reduce((n, r) => n + (r.cacheReadTokens ?? 0), 0);
  }
  return totals;
}

/**
 * "285,415 in (2,104 uncached · 210,000 cache write · 73,311 cache read)".
 * Without a split (records from before TK-120) it is just "285,415 in".
 */
export function formatInputTokens(t: Pick<RunUsageTotals, "inputTokens"> & Partial<InputSplit>): string {
  const total = `${t.inputTokens.toLocaleString()} in`;
  if (!hasInputSplit(t)) return total;
  return (
    `${total} (${t.uncachedInputTokens.toLocaleString()} uncached · ` +
    `${t.cacheCreationTokens.toLocaleString()} cache write · ` +
    `${t.cacheReadTokens.toLocaleString()} cache read)`
  );
}

/** The briefing's one-line run cost: tokens in (with the cache split), out, and USD. */
export function formatRunCostLine(t: RunUsageTotals): string {
  return `Cost: ${formatInputTokens(t)} / ${t.outputTokens.toLocaleString()} out tokens · ${formatUsd(t.totalUsd)}`;
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
    return { date, totals: totalsOf([]), records: [] };
  }
  const summary = JSON.parse(await Bun.file(file).text()) as RunUsageSummary;
  // Recompute rather than trust the stored totals: a file written before
  // TK-120 has no split totals, and a day can mix old and new records.
  return { ...summary, totals: totalsOf(summary.records) };
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
  summary.totals = totalsOf(summary.records);

  await mkdir(dirname(usagePath(paths, date)), { recursive: true });
  await Bun.write(usagePath(paths, date), JSON.stringify(summary, null, 2));
  return summary;
}
