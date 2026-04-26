import { describe, test, expect } from "bun:test";

import {
  rankExchanges,
  noveltyScore,
  hasAlwaysIncludeMarker,
  estimateTokens,
  type ExtractedExchange,
} from "../lib/sessions";

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  test("4 chars per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// hasAlwaysIncludeMarker
// ---------------------------------------------------------------------------

describe("hasAlwaysIncludeMarker", () => {
  test("matches save this / save that", () => {
    expect(hasAlwaysIncludeMarker("save this for later")).toBe(true);
    expect(hasAlwaysIncludeMarker("Save that observation.")).toBe(true);
  });

  test("matches remember markers", () => {
    expect(hasAlwaysIncludeMarker("remember this")).toBe(true);
    expect(hasAlwaysIncludeMarker("Please remember that we use Bun")).toBe(true);
    expect(hasAlwaysIncludeMarker("let's remember the auth pattern")).toBe(true);
  });

  test("matches write down / take note / don't forget", () => {
    expect(hasAlwaysIncludeMarker("write this down")).toBe(true);
    expect(hasAlwaysIncludeMarker("take note of the constraint")).toBe(true);
    expect(hasAlwaysIncludeMarker("don't forget the migration")).toBe(true);
    expect(hasAlwaysIncludeMarker("don’t forget the migration")).toBe(false); // smart quote — keep simple for now
  });

  test("matches put/save/write to memory", () => {
    expect(hasAlwaysIncludeMarker("write this to memory")).toBe(true);
    expect(hasAlwaysIncludeMarker("save in memory")).toBe(true);
  });

  test("does not match casual prose", () => {
    expect(hasAlwaysIncludeMarker("the function returns a value")).toBe(false);
    expect(hasAlwaysIncludeMarker("we'll fix this later")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// noveltyScore
// ---------------------------------------------------------------------------

describe("noveltyScore", () => {
  test("empty corpus returns 1.0 (maximally novel)", () => {
    expect(noveltyScore("anything", [])).toBe(1.0);
  });

  test("exchange echoing canon scores lower than novel exchange", () => {
    const knowledge = [
      "Use Joken for JWT, not Guardian — API-only app",
      "PostgreSQL is the only database",
      "Bun runtime replaces Node for builds",
    ];
    const echoed = noveltyScore("we should use Joken for JWT auth", knowledge);
    const novel = noveltyScore("the rendering pipeline uses webgl shaders", knowledge);
    expect(echoed).toBeLessThan(novel);
  });

  test("scores stay in (0, 1]", () => {
    const knowledge = ["a fact about something"];
    const score = noveltyScore("a fact about something", knowledge);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// rankExchanges
// ---------------------------------------------------------------------------

describe("rankExchanges", () => {
  const knowledge = [
    "Use Joken for JWT auth, not Guardian",
    "PostgreSQL is the only database we use",
  ];

  test("novel exchange ranks above echoed exchange of similar length", () => {
    const echoed: ExtractedExchange = {
      role: "assistant",
      text: "Joken handles JWT auth here, not Guardian, since this is API-only.",
    };
    const novel: ExtractedExchange = {
      role: "assistant",
      text: "We're considering moving the analytics pipeline off the kafka cluster entirely.",
    };
    const [first, second] = rankExchanges([echoed, novel], knowledge);
    expect(first?.exchange).toBe(novel);
    expect(second?.exchange).toBe(echoed);
  });

  test("longer beats shorter when novelty is roughly equal", () => {
    const short: ExtractedExchange = { role: "user", text: "What about kafka?" };
    const long: ExtractedExchange = {
      role: "user",
      text: "What about the kafka cluster — is it still streaming events into the analytics pipeline, or did we move that off entirely after the cost incident last month?",
    };
    const [first] = rankExchanges([short, long], knowledge);
    expect(first?.exchange).toBe(long);
  });

  test("always-include marker forces top placement regardless of length", () => {
    const tiny: ExtractedExchange = { role: "user", text: "save this: tip jar." };
    const huge: ExtractedExchange = {
      role: "assistant",
      text: "Massive treatise about an unrelated thing. ".repeat(50),
    };
    const [first] = rankExchanges([tiny, huge], knowledge);
    expect(first?.exchange).toBe(tiny);
    expect(first?.alwaysInclude).toBe(true);
  });

  test("attaches diagnostic fields", () => {
    const ex: ExtractedExchange = { role: "user", text: "hello world" };
    const [r] = rankExchanges([ex], knowledge);
    expect(r?.tokenCount).toBe(estimateTokens(ex.text));
    expect(r?.novelty).toBeGreaterThan(0);
    expect(r?.score).toBeGreaterThanOrEqual(0);
    expect(r?.alwaysInclude).toBe(false);
  });

  test("filters empty / whitespace-only exchanges", () => {
    const empty: ExtractedExchange = { role: "user", text: "   " };
    const real: ExtractedExchange = { role: "user", text: "actual content" };
    const ranked = rankExchanges([empty, real], knowledge);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.exchange).toBe(real);
  });

  test("empty corpus — pure tokenCount ranking", () => {
    const a: ExtractedExchange = { role: "user", text: "short" };
    const b: ExtractedExchange = { role: "user", text: "this is a longer message" };
    const [first] = rankExchanges([a, b], []);
    expect(first?.exchange).toBe(b);
  });
});
