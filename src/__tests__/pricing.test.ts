import { describe, test, expect } from "bun:test";
import { estimateCost } from "../lib/pricing";

describe("estimateCost", () => {
  test("bills the full context at the input rate when no cache split is given", () => {
    const c = estimateCost({ provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 0 });
    expect(c.inputUsd).toBeCloseTo(3, 6);
    expect(c.modelKnown).toBe(true);
  });

  test("applies cache read (10%) and cache write (125%) rates to their slices", () => {
    const c = estimateCost({
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 800_000,
      cacheCreationTokens: 100_000,
    });
    // 100k uncached ×1 + 100k write ×1.25 + 800k read ×0.1 = 305k billable
    expect(c.inputUsd).toBeCloseTo(0.305 * 3, 6);
  });

  test("unknown model reports zero and modelKnown=false", () => {
    const c = estimateCost({ provider: "anthropic", model: "claude-nope", inputTokens: 5, outputTokens: 5 });
    expect(c.totalUsd).toBe(0);
    expect(c.modelKnown).toBe(false);
  });
});
