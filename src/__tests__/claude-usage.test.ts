// TK-120: the usage claude.ts reads from a `claude --print` result envelope,
// and the cost hive computes from it.
//
// The fixtures in fixtures/claude-envelopes/ are real envelopes captured
// 2026-11-15 from `claude --print --output-format json` with hive's own flags.
// Each pair is one prompt sent twice: the first call writes the prompt cache
// (1-hour TTL, the CLI's choice), the second reads it. The CLI reports its own
// list-price `total_cost_usd`, so hive's estimate can be checked against it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { completeClaudeText } from "../lib/claude";
import { estimateCost } from "../lib/pricing";

const FIXTURES = join(import.meta.dir, "fixtures", "claude-envelopes");

let dir: string;
let savedBin: string | undefined;
let savedEnvelope: string | undefined;

beforeAll(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "hive-claude-usage-")));
  // A stand-in `claude`: drain the prompt on stdin, print the chosen envelope.
  const bin = join(dir, "claude");
  await Bun.write(bin, '#!/bin/sh\ncat > /dev/null\ncat "$HIVE_TEST_ENVELOPE"\n');
  await chmod(bin, 0o755);
  savedBin = process.env.HIVE_CLAUDE_BIN;
  savedEnvelope = process.env.HIVE_TEST_ENVELOPE;
  process.env.HIVE_CLAUDE_BIN = bin;
});

afterAll(async () => {
  if (savedBin === undefined) delete process.env.HIVE_CLAUDE_BIN;
  else process.env.HIVE_CLAUDE_BIN = savedBin;
  if (savedEnvelope === undefined) delete process.env.HIVE_TEST_ENVELOPE;
  else process.env.HIVE_TEST_ENVELOPE = savedEnvelope;
  await rm(dir, { recursive: true, force: true });
});

async function complete(envelopeFile: string, modelId: string) {
  process.env.HIVE_TEST_ENVELOPE = envelopeFile;
  return completeClaudeText({ modelId, systemPrompt: "s", userContent: "u" });
}

const REAL: Array<{ file: string; model: string; uncached: number; write: number; write1h: number; read: number }> = [
  { file: "haiku-4-5-cache-write-1h.json", model: "claude-haiku-4-5", uncached: 2, write: 8275, write1h: 8275, read: 0 },
  { file: "haiku-4-5-cache-read.json", model: "claude-haiku-4-5", uncached: 2, write: 0, write1h: 0, read: 8275 },
  { file: "opus-5-5-cache-write-1h.json", model: "claude-opus-5-5", uncached: 2, write: 4002, write1h: 4002, read: 0 },
  { file: "opus-5-5-cache-read.json", model: "claude-opus-5-5", uncached: 2, write: 0, write1h: 0, read: 4002 },
];

describe("claude --print envelope with cache fields (real captures)", () => {
  for (const f of REAL) {
    test(`${f.file}: input counts every slice, and cost matches the CLI's own`, async () => {
      const path = join(FIXTURES, f.file);
      const envelope = JSON.parse(await Bun.file(path).text());
      const c = await complete(path, f.model);

      expect(c.inputTokens).toBe(f.uncached + f.write + f.read);
      expect(c.cacheCreationTokens).toBe(f.write);
      expect(c.cacheCreation1hTokens).toBe(f.write1h);
      expect(c.cacheReadTokens).toBe(f.read);

      const cost = estimateCost({
        provider: c.provider,
        model: c.model,
        inputTokens: c.inputTokens!,
        outputTokens: c.outputTokens!,
        cacheCreationTokens: c.cacheCreationTokens,
        cacheCreation1hTokens: c.cacheCreation1hTokens,
        cacheReadTokens: c.cacheReadTokens,
      });
      expect(cost.totalUsd).toBeCloseTo(envelope.total_cost_usd, 9);
    });
  }
});

describe("claude --print envelope without cache fields", () => {
  test("input is input_tokens alone and the cache slices are zero", async () => {
    const path = join(dir, "legacy.json");
    await Bun.write(
      path,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        usage: { input_tokens: 1200, output_tokens: 30 },
      }),
    );
    const c = await complete(path, "claude-haiku-4-5");
    expect(c.inputTokens).toBe(1200);
    expect(c.outputTokens).toBe(30);
    expect(c.cacheCreationTokens).toBe(0);
    expect(c.cacheCreation1hTokens).toBe(0);
    expect(c.cacheReadTokens).toBe(0);
  });

  test("an envelope with no usage block reports null token counts", async () => {
    const path = join(dir, "no-usage.json");
    await Bun.write(path, JSON.stringify({ type: "result", subtype: "success", result: "ok" }));
    const c = await complete(path, "claude-haiku-4-5");
    expect(c.inputTokens).toBeNull();
    expect(c.outputTokens).toBeNull();
  });
});
