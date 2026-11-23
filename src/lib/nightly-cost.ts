// `hive memory cost` — per-pass input, cache and cost for one or more nightly
// runs, read from runs/{DATE}/usage.json. Built so one night can be compared
// with the next: the same pass rows, the same columns, side by side.

import { existsSync, readdirSync } from "node:fs";

import type { HivePaths } from "./paths";
import { formatUsd, loadUsageSummary, type PassUsageRecord, type RunUsageSummary } from "./pricing";

export interface PassCostRow {
  pass: string;
  model: string;
  records: number;
  inputTokens: number;
  /** Null when any record in the row predates TK-120's cache split. */
  uncachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number;
  totalUsd: number;
}

const PASS_ORDER = ["B", "C", "V", "TA", "TB", "TR", "TC"];

/** One row per (pass, model), in pipeline order. */
export function passCostRows(records: PassUsageRecord[]): PassCostRow[] {
  const rows = new Map<string, PassCostRow>();
  for (const r of records) {
    const key = `${r.pass}\u0000${r.model}`;
    const row = rows.get(key) ?? {
      pass: r.pass,
      model: r.model,
      records: 0,
      inputTokens: 0,
      uncachedInputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalUsd: 0,
    };
    row.records++;
    row.inputTokens += r.inputTokens;
    row.outputTokens += r.outputTokens;
    row.totalUsd += r.cost.totalUsd;
    const split = r.uncachedInputTokens !== undefined && r.cacheReadTokens !== undefined && r.cacheCreationTokens !== undefined;
    row.uncachedInputTokens = split && row.uncachedInputTokens !== null ? row.uncachedInputTokens + r.uncachedInputTokens! : null;
    row.cacheCreationTokens = split && row.cacheCreationTokens !== null ? row.cacheCreationTokens + r.cacheCreationTokens! : null;
    row.cacheReadTokens = split && row.cacheReadTokens !== null ? row.cacheReadTokens + r.cacheReadTokens! : null;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => PASS_ORDER.indexOf(a.pass) - PASS_ORDER.indexOf(b.pass) || a.model.localeCompare(b.model),
  );
}

/** Sum rows into one "all" row. A split column is null if any row's is. */
export function totalCostRow(rows: PassCostRow[]): PassCostRow {
  const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
  return rows.reduce<PassCostRow>(
    (t, r) => ({
      pass: "all",
      model: "",
      records: t.records + r.records,
      inputTokens: t.inputTokens + r.inputTokens,
      uncachedInputTokens: add(t.uncachedInputTokens, r.uncachedInputTokens),
      cacheCreationTokens: add(t.cacheCreationTokens, r.cacheCreationTokens),
      cacheReadTokens: add(t.cacheReadTokens, r.cacheReadTokens),
      outputTokens: t.outputTokens + r.outputTokens,
      totalUsd: t.totalUsd + r.totalUsd,
    }),
    {
      pass: "all", model: "", records: 0, inputTokens: 0, uncachedInputTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalUsd: 0,
    },
  );
}

function n(v: number | null): string {
  return v === null ? "—" : v.toLocaleString("en-US");
}

function hitRate(row: Pick<PassCostRow, "cacheReadTokens" | "inputTokens">): string {
  if (row.cacheReadTokens === null || row.inputTokens === 0) return "—";
  return `${((row.cacheReadTokens / row.inputTokens) * 100).toFixed(1)}%`;
}

const HEADER = ["pass", "model", "rec", "input", "uncached", "cache write", "cache read", "hit", "output", "cost"];

/** Render one run's table. Columns are right-aligned except pass and model. */
export function formatRunCost(summary: RunUsageSummary): string {
  const rows = passCostRows(summary.records);
  const render = (r: PassCostRow): string[] => [
    r.pass,
    r.model,
    String(r.records),
    n(r.inputTokens),
    n(r.uncachedInputTokens),
    n(r.cacheCreationTokens),
    n(r.cacheReadTokens),
    hitRate(r),
    n(r.outputTokens),
    formatUsd(r.totalUsd),
  ];
  const cells = rows.map(render);
  if (rows.length > 0) cells.push(render(totalCostRow(rows)));
  const table = [HEADER, ...cells];
  const widths = HEADER.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  const line = (row: string[]): string =>
    row.map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ").trimEnd();

  const out = [`== ${summary.date}`];
  if (cells.length === 0) {
    out.push("(no usage.json for this date)");
    return out.join("\n");
  }
  out.push(line(table[0]!));
  for (const row of cells) out.push(line(row));
  if (rows.some((r) => r.cacheReadTokens === null)) {
    out.push("— : records written before TK-120 carry no cache split; their cost is that binary's estimate.");
  }
  return out.join("\n");
}

/** Dates (YYYY-MM-DD) with a usage.json, up to and including `through`, newest last. */
export function runDatesWithUsage(paths: HivePaths, through: string, count: number): string[] {
  if (!existsSync(paths.memoryRunsDir)) return [];
  return readdirSync(paths.memoryRunsDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= through)
    .filter((d) => existsSync(`${paths.memoryRunsDir}/${d}/usage.json`))
    .sort()
    .slice(-count);
}

export async function nightlyCostReport(paths: HivePaths, dates: string[]): Promise<string> {
  const parts: string[] = [];
  for (const d of dates) parts.push(formatRunCost(await loadUsageSummary(paths, d)));
  return parts.join("\n\n");
}
