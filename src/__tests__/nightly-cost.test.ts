// Nightly cost controls (2026-11-20): per-pass model config, the prompt-cache
// switch on `claude --print`, Sonnet 5.5 pricing, the taste cadence math and
// the `hive memory cost` report.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { completeClaudeText } from "../lib/claude";
import {
  NIGHTLY_PASSES,
  nightlyEffort,
  nightlyModel,
  nightlyPromptCacheOff,
  tasteEveryNights,
} from "../lib/nightly-config";
import {
  addDays,
  catchUpDates,
  daysBetween,
  decideTasteGate,
  emptyManifest,
  projectCatchUpDays,
  writeManifest,
} from "../lib/nightly-resume";
import { formatRunCost, passCostRows } from "../lib/nightly-cost";
import { buildUsageRecord, estimateCost, type PassUsageRecord } from "../lib/pricing";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";

const ENV_KEYS = [
  "HIVE_NIGHTLY_MODEL_B",
  "HIVE_NIGHTLY_MODEL_VBRIEF",
  "HIVE_EXTRACT_MODEL",
  "HIVE_VERIFY_MODEL",
  "HIVE_TASTE_PROVIDER",
  "HIVE_NIGHTLY_EFFORT_TC",
  "HIVE_NIGHTLY_PROMPT_CACHE",
  "HIVE_TASTE_EVERY_NIGHTS",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("nightly-config — per-pass models", () => {
  test("defaults: Sonnet 5.5 for extraction and taste, Opus 5.5 for V and the Brief, Haiku for TA", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(nightlyModel("B").modelId).toBe("claude-sonnet-5-5");
    expect(nightlyModel("C").modelId).toBe("claude-sonnet-5-5");
    expect(nightlyModel("TB").modelId).toBe("claude-sonnet-5-5");
    expect(nightlyModel("TC").modelId).toBe("claude-sonnet-5-5");
    expect(nightlyModel("TR").modelId).toBe("claude-sonnet-5-5");
    expect(nightlyModel("V").modelId).toBe("claude-opus-5-5");
    expect(nightlyModel("VBRIEF").modelId).toBe("claude-opus-5-5");
    expect(nightlyModel("TA").modelId).toBe("claude-haiku-4-5");
    expect(nightlyModel("B").provider).toBe("anthropic");
  });

  test("the per-pass variable beats the legacy one, which beats the map", () => {
    process.env.HIVE_VERIFY_MODEL = "claude-fable-5-2";
    expect(nightlyModel("V").modelId).toBe("claude-fable-5-2");
    expect(nightlyModel("VBRIEF").modelId).toBe("claude-fable-5-2");
    process.env.HIVE_NIGHTLY_MODEL_VBRIEF = "claude-sonnet-5-5";
    expect(nightlyModel("VBRIEF").modelId).toBe("claude-sonnet-5-5");
    expect(nightlyModel("V").modelId).toBe("claude-fable-5-2");
  });

  test("provider/model sets both; a legacy provider variable still applies", () => {
    process.env.HIVE_NIGHTLY_MODEL_B = "openai/gpt-x";
    expect(nightlyModel("B")).toEqual({ provider: "openai", modelId: "gpt-x" });
    process.env.HIVE_TASTE_PROVIDER = "other";
    expect(nightlyModel("TC").provider).toBe("other");
  });

  test("effort comes from the map; an invalid override is ignored", () => {
    expect(nightlyEffort("V")).toBe("high");
    expect(nightlyEffort("TC")).toBe(NIGHTLY_PASSES.TC.effort);
    process.env.HIVE_NIGHTLY_EFFORT_TC = "low";
    expect(nightlyEffort("TC")).toBe("low");
    process.env.HIVE_NIGHTLY_EFFORT_TC = "extreme";
    expect(nightlyEffort("TC")).toBe(NIGHTLY_PASSES.TC.effort);
  });

  test("prompt caching is off unless HIVE_NIGHTLY_PROMPT_CACHE=on; taste cadence defaults to 2", () => {
    delete process.env.HIVE_NIGHTLY_PROMPT_CACHE;
    expect(nightlyPromptCacheOff()).toBe(true);
    process.env.HIVE_NIGHTLY_PROMPT_CACHE = "on";
    expect(nightlyPromptCacheOff()).toBe(false);
    delete process.env.HIVE_TASTE_EVERY_NIGHTS;
    expect(tasteEveryNights()).toBe(2);
    process.env.HIVE_TASTE_EVERY_NIGHTS = "1";
    expect(tasteEveryNights()).toBe(1);
    process.env.HIVE_TASTE_EVERY_NIGHTS = "0";
    expect(tasteEveryNights()).toBe(2);
  });
});

describe("completeClaudeText — promptCacheOff reaches the child's environment", () => {
  let dir: string;
  let savedBin: string | undefined;
  beforeAll(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), "hive-cache-env-")));
    // A stand-in `claude` that reports what DISABLE_PROMPT_CACHING it saw.
    const bin = join(dir, "claude");
    await Bun.write(
      bin,
      "#!/bin/sh\ncat > /dev/null\n" +
        `printf '{"type":"result","subtype":"success","is_error":false,"result":"cache=%s","usage":{"input_tokens":1,"output_tokens":1}}' "\${DISABLE_PROMPT_CACHING:-unset}"\n`,
    );
    await chmod(bin, 0o755);
    savedBin = process.env.HIVE_CLAUDE_BIN;
    process.env.HIVE_CLAUDE_BIN = bin;
  });
  afterAll(async () => {
    if (savedBin === undefined) delete process.env.HIVE_CLAUDE_BIN;
    else process.env.HIVE_CLAUDE_BIN = savedBin;
    await rm(dir, { recursive: true, force: true });
  });

  test("set: DISABLE_PROMPT_CACHING=1; unset: the variable is not added", async () => {
    const off = await completeClaudeText({ modelId: "m", systemPrompt: "s", userContent: "u", promptCacheOff: true });
    expect(off.text).toBe("cache=1");
    const on = await completeClaudeText({ modelId: "m", systemPrompt: "s", userContent: "u" });
    expect(on.text).toBe("cache=unset");
  });
});

describe("pricing — Sonnet 5.5", () => {
  test("prices at $2 in / $10 out per MTok, cache read $0.10, 1h write $4 (typed from the docs)", () => {
    const M = 1_000_000;
    const plain = estimateCost({ provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: M, outputTokens: M });
    expect(plain.modelKnown).toBe(true);
    expect(plain.inputUsd).toBeCloseTo(2, 9);
    expect(plain.outputUsd).toBeCloseTo(10, 9);
    const cached = estimateCost({
      provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 2 * M, outputTokens: 0,
      cacheReadTokens: M, cacheCreationTokens: M, cacheCreation1hTokens: M,
    });
    expect(cached.inputUsd).toBeCloseTo(0.1 + 4, 9);
  });
});

describe("taste cadence math", () => {
  let paths: HivePaths;
  beforeAll(async () => {
    paths = await ensureHiveScaffold(realpathSync(await mkdtemp(join(tmpdir(), "hive-gate-"))));
  });

  test("date helpers", () => {
    expect(daysBetween("2026-02-27", "2026-03-01")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(catchUpDates("2026-11-20", 3)).toEqual(["2026-11-18", "2026-11-19", "2026-11-20"]);
  });

  test("due with no history; skipped inside the cadence; due again at the cadence; capped at 7 days", async () => {
    expect(decideTasteGate(paths, "2026-11-20", 2)).toMatchObject({ run: true, lastRun: null, catchUpDays: 1 });

    await writeManifest(paths, { ...emptyManifest("2026-11-20"), tasteComplete: "2026-11-20T07:20:00Z" });
    expect(decideTasteGate(paths, "2026-11-21", 2)).toMatchObject({ run: false, nextRun: "2026-11-22" });
    expect(decideTasteGate(paths, "2026-11-22", 2)).toMatchObject({ run: true, catchUpDays: 2 });
    expect(decideTasteGate(paths, "2026-12-20", 2)).toMatchObject({ run: true, catchUpDays: 7 });
    expect(decideTasteGate(paths, "2026-11-21", 1)).toMatchObject({ run: true, catchUpDays: 1 });
    // A retry of the date itself doesn't count its own manifest as history.
    expect(decideTasteGate(paths, "2026-11-20", 2).lastRun).toBeNull();
  });

  test("a project finished in a failed track starts its window there, not at the last full run", async () => {
    // 11-20 finished (above); on 11-22 the track failed overall but alpha finished.
    await writeManifest(paths, {
      ...emptyManifest("2026-11-22"),
      taste: { alpha: { at: "2026-11-22T07:10:00Z", tc: null } },
    });
    const gate = decideTasteGate(paths, "2026-11-23", 2);
    expect(gate).toMatchObject({ run: true, lastRun: "2026-11-20", catchUpDays: 3 });
    expect(projectCatchUpDays(paths, "2026-11-23", "alpha", gate)).toBe(1);
    expect(projectCatchUpDays(paths, "2026-11-23", "bravo", gate)).toBe(3);
  });

  test("a corrupt manifest counts as no history", async () => {
    const other = await ensureHiveScaffold(realpathSync(await mkdtemp(join(tmpdir(), "hive-gate-bad-"))));
    await mkdir(join(other.memoryRunsDir, "2026-11-20"), { recursive: true });
    await writeFile(join(other.memoryRunsDir, "2026-11-20", "resume.json"), "{not json");
    expect(decideTasteGate(other, "2026-11-21", 2)).toMatchObject({ run: true, lastRun: null });
  });
});

describe("hive memory cost — report", () => {
  const rec = (r: Partial<PassUsageRecord> & Pick<PassUsageRecord, "pass" | "model">): PassUsageRecord => ({
    ...buildUsageRecord(r.pass, {
      provider: "anthropic", model: r.model, inputTokens: r.inputTokens ?? 1000, outputTokens: 100,
      cacheReadTokens: r.cacheReadTokens ?? 0, cacheCreationTokens: r.cacheCreationTokens ?? 0,
      cacheCreation1hTokens: r.cacheCreationTokens ?? 0, durationMs: 1,
    }),
    recordedAt: "t",
  });

  test("one row per pass and model, in pipeline order, with hit rate from cache reads", () => {
    const rows = passCostRows([
      rec({ pass: "TC", model: "claude-sonnet-5-5" }),
      rec({ pass: "V", model: "claude-opus-5-5", inputTokens: 1000, cacheReadTokens: 250 }),
      rec({ pass: "B", model: "claude-sonnet-5-5" }),
      rec({ pass: "B", model: "claude-sonnet-5-5" }),
      rec({ pass: "V", model: "claude-sonnet-5-5" }),
    ]);
    expect(rows.map((r) => `${r.pass}:${r.model}:${r.records}`)).toEqual([
      "B:claude-sonnet-5-5:2",
      "V:claude-opus-5-5:1",
      "V:claude-sonnet-5-5:1",
      "TC:claude-sonnet-5-5:1",
    ]);
    const table = formatRunCost({ date: "2026-11-21", totals: { inputTokens: 0, outputTokens: 0, totalUsd: 0 }, records: [
      rec({ pass: "V", model: "claude-opus-5-5", inputTokens: 1000, cacheReadTokens: 250 }),
    ] });
    expect(table).toContain("== 2026-11-21");
    expect(table).toMatch(/V\s+claude-opus-5-5\s+1\s+1,000\s+750\s+0\s+250\s+25\.0%/);
    expect(table).toMatch(/^all\s+/m);
  });

  test("records without the TK-120 split show dashes and a note, never a fake zero", () => {
    const old: PassUsageRecord = {
      pass: "V", provider: "anthropic", model: "claude-opus-5-5", inputTokens: 1_093_717,
      outputTokens: 44_279, durationMs: 1, cost: { inputUsd: 5.4, outputUsd: 0.9, totalUsd: 6.3, modelKnown: true },
      recordedAt: "t",
    };
    const table = formatRunCost({ date: "2026-11-20", totals: { inputTokens: 0, outputTokens: 0, totalUsd: 0 }, records: [old] });
    expect(table).toMatch(/V\s+claude-opus-5-5\s+1\s+1,093,717\s+—\s+—\s+—\s+—/);
    expect(table).toContain("carry no cache split");
  });
});
