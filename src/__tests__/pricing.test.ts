import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendUsageRecord,
  buildUsageRecord,
  estimateCost,
  formatRunCostLine,
  loadUsageSummary,
  totalsOf,
  usagePath,
  type PassUsageRecord,
} from "../lib/pricing";
import type { HivePaths } from "../lib/paths";

const M = 1_000_000;

// One million tokens of each slice, priced alone. The expected values are typed
// in from https://platform.claude.com/docs/en/about-claude/pricing (read
// 2026-11-15), not read back from the rate table under test.
//                       model               input  5m write  1h write  read   output
const DOCUMENTED: Array<[string, number, number, number, number, number]> = [
  // The models the nightly routes to today (src/lib/*: Opus 5.5 everywhere, Haiku 4.5 for TA).
  ["claude-opus-5-5",  4,     5,        8,        0.2,   20],
  ["claude-haiku-4-5", 1,     1.25,     2,        0.1,   5],
  // Models still named in hive's code paths and config defaults.
  ["claude-opus-4-8",  5,     6.25,     10,       0.5,   25],
  ["claude-opus-4-6",  5,     6.25,     10,       0.5,   25],
  ["claude-fable-5-1", 10,    12.5,     20,       0.25,  50],
  ["claude-sonnet-5",  2,     2.5,      4,        0.2,   10],
];

describe("estimateCost — per-model rates", () => {
  for (const [model, input, write5m, write1h, read, output] of DOCUMENTED) {
    test(`${model}: each input slice and output bill at the documented rate`, () => {
      const base = { provider: "anthropic", model, outputTokens: 0 };
      expect(estimateCost({ ...base, inputTokens: M }).inputUsd).toBeCloseTo(input, 9);
      expect(estimateCost({ ...base, inputTokens: M, cacheCreationTokens: M }).inputUsd).toBeCloseTo(write5m, 9);
      expect(
        estimateCost({ ...base, inputTokens: M, cacheCreationTokens: M, cacheCreation1hTokens: M }).inputUsd,
      ).toBeCloseTo(write1h, 9);
      expect(estimateCost({ ...base, inputTokens: M, cacheReadTokens: M }).inputUsd).toBeCloseTo(read, 9);
      expect(estimateCost({ ...base, inputTokens: 0, outputTokens: M }).outputUsd).toBeCloseTo(output, 9);
    });
  }

  test("a mixed call prices each slice separately", () => {
    // Opus 5.5: 100k uncached + 50k 5m write + 50k 1h write + 800k read, 10k out.
    const c = estimateCost({
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 1_000_000,
      cacheCreationTokens: 100_000,
      cacheCreation1hTokens: 50_000,
      cacheReadTokens: 800_000,
      outputTokens: 10_000,
    });
    // 0.1×4 + 0.05×5 + 0.05×8 + 0.8×0.2 = 0.4 + 0.25 + 0.4 + 0.16
    expect(c.inputUsd).toBeCloseTo(1.21, 9);
    expect(c.outputUsd).toBeCloseTo(0.2, 9);
    expect(c.totalUsd).toBeCloseTo(1.41, 9);
  });

  test("with no cache fields the full input bills at the base rate", () => {
    const c = estimateCost({ provider: "anthropic", model: "claude-sonnet-5", inputTokens: M, outputTokens: 0 });
    expect(c.inputUsd).toBeCloseTo(2, 9);
    expect(c.modelKnown).toBe(true);
  });

  test("a 1h count larger than the write total is clamped to it", () => {
    const c = estimateCost({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: M,
      cacheCreationTokens: M,
      cacheCreation1hTokens: 5 * M,
      outputTokens: 0,
    });
    expect(c.inputUsd).toBeCloseTo(2, 9);
  });

  test("an unknown model reports zero and modelKnown=false", () => {
    const c = estimateCost({ provider: "anthropic", model: "claude-nope", inputTokens: 5, outputTokens: 5 });
    expect(c.totalUsd).toBe(0);
    expect(c.modelKnown).toBe(false);
  });

  test("Haiku 5.5 is not priced: its 100k-token tier split cannot be expressed", () => {
    expect(estimateCost({ provider: "anthropic", model: "claude-haiku-5-5", inputTokens: 5, outputTokens: 5 }).modelKnown)
      .toBe(false);
  });
});

describe("buildUsageRecord", () => {
  test("keeps the three input parts, and they sum to inputTokens", () => {
    const r = buildUsageRecord(
      "B",
      {
        provider: "anthropic",
        model: "claude-opus-5-5",
        inputTokens: 27_643,
        cacheCreationTokens: 27_641,
        cacheCreation1hTokens: 27_641,
        cacheReadTokens: 0,
        outputTokens: 5_331,
        durationMs: 48_412,
      },
      "writing",
    );
    expect(r).toMatchObject({
      pass: "B",
      project: "writing",
      inputTokens: 27_643,
      uncachedInputTokens: 2,
      cacheCreationTokens: 27_641,
      cacheReadTokens: 0,
      cacheCreation1hTokens: 27_641,
      outputTokens: 5_331,
      durationMs: 48_412,
    });
    expect(r.uncachedInputTokens! + r.cacheCreationTokens! + r.cacheReadTokens!).toBe(r.inputTokens);
    // 2×$4 + 27,641×$8 (1h write) + 5,331×$20, per MTok.
    expect(r.cost.totalUsd).toBeCloseTo((2 * 4 + 27_641 * 8 + 5_331 * 20) / M, 9);
  });

  test("a call with no cache fields records the whole input as uncached", () => {
    const r = buildUsageRecord("C", {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1_200,
      outputTokens: 30,
      durationMs: null,
    });
    expect(r.project).toBeUndefined();
    expect(r).toMatchObject({ uncachedInputTokens: 1_200, cacheCreationTokens: 0, cacheReadTokens: 0 });
  });
});

function legacyRecord(inputTokens: number, totalUsd: number): PassUsageRecord {
  return {
    pass: "V",
    provider: "anthropic",
    model: "claude-opus-5-5",
    inputTokens,
    outputTokens: 10,
    durationMs: null,
    cost: { inputUsd: totalUsd, outputUsd: 0, totalUsd, modelKnown: true },
    recordedAt: "2026-11-14T07:00:00.000Z",
  };
}

function splitRecord(): PassUsageRecord {
  return {
    ...buildUsageRecord("B", {
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 1_000,
      cacheCreationTokens: 600,
      cacheReadTokens: 300,
      outputTokens: 50,
      durationMs: 1,
    }),
    recordedAt: "2026-11-15T07:00:00.000Z",
  };
}

describe("run totals", () => {
  test("sum the input parts when every record has them", () => {
    const t = totalsOf([splitRecord(), splitRecord()]);
    expect(t).toMatchObject({
      inputTokens: 2_000,
      uncachedInputTokens: 200,
      cacheCreationTokens: 1_200,
      cacheReadTokens: 600,
      outputTokens: 100,
    });
  });

  test("omit the input parts when a record predates the split", () => {
    const t = totalsOf([legacyRecord(5_000, 0.1), splitRecord()]);
    expect(t.inputTokens).toBe(6_000);
    expect(t.uncachedInputTokens).toBeUndefined();
    expect(t.cacheCreationTokens).toBeUndefined();
    expect(t.cacheReadTokens).toBeUndefined();
  });

  test("the briefing cost line shows the split, or only the total without one", () => {
    expect(formatRunCostLine(totalsOf([splitRecord()]))).toMatch(
      /^Cost: 1,000 in \(100 uncached · 600 cache write · 300 cache read\) \/ 50 out tokens · \$0\.\d+$/,
    );
    expect(formatRunCostLine(totalsOf([legacyRecord(5_000, 0.1)]))).toBe("Cost: 5,000 in / 10 out tokens · $0.100");
  });
});

describe("usage.json", () => {
  test("appendUsageRecord writes the split and recomputes totals over old records", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "hive-usage-")));
    try {
      const paths = { memoryRunsDir: root } as HivePaths;
      const date = "2026-11-15";
      // A file written before TK-120: one record, stored totals without a split.
      await Bun.write(
        usagePath(paths, date),
        JSON.stringify({
          date,
          totals: { inputTokens: 5_000, outputTokens: 10, totalUsd: 0.1 },
          records: [legacyRecord(5_000, 0.1)],
        }),
      );
      expect((await loadUsageSummary(paths, date)).totals.cacheReadTokens).toBeUndefined();

      const { recordedAt: _, ...fresh } = splitRecord();
      await appendUsageRecord(paths, date, fresh);
      const onDisk = JSON.parse(await Bun.file(usagePath(paths, date)).text());
      expect(onDisk.records).toHaveLength(2);
      expect(onDisk.records[1]).toMatchObject({ uncachedInputTokens: 100, cacheCreationTokens: 600, cacheReadTokens: 300 });
      expect(onDisk.totals.inputTokens).toBe(6_000);
      expect(onDisk.totals.totalUsd).toBeCloseTo(0.1 + fresh.cost.totalUsd, 9);
      expect(onDisk.totals.cacheReadTokens).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing file loads as an empty summary", async () => {
    const paths = { memoryRunsDir: join(tmpdir(), "hive-usage-none") } as HivePaths;
    const s = await loadUsageSummary(paths, "1999-01-01");
    expect(s.records).toEqual([]);
    expect(s.totals).toEqual({ inputTokens: 0, outputTokens: 0, totalUsd: 0 });
  });
});
