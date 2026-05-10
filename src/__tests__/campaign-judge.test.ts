import { describe, test, expect } from "bun:test";

import {
  runJudge,
  parseVerdict,
  buildJudgeUserMessage,
  JUDGE_SYSTEM_PROMPT,
  SCORECARD_TAIL_COUNT,
  type JudgeCaller,
  type JudgeCallInput,
  type JudgeVerdict,
} from "../lib/campaign/judge";
import type { CampaignState, ScorecardRow } from "../lib/campaign/state";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<CampaignState>): CampaignState {
  return {
    id: "CAMP-001",
    dir: "/tmp/hive/campaigns/CAMP-001",
    workspacePath: "/tmp/hive/campaigns/CAMP-001/workspace",
    status: "running",
    frozenPrefix: "Build a REST API for user management with CRUD endpoints and auth.",
    goal: "Build a REST API for user management with CRUD endpoints and auth.",
    plan: "## Plan\n1. [x] Set up project structure\n2. [ ] Implement user model\n3. [ ] Add auth middleware",
    checkpoint: "Completed project structure. Express app scaffolded with TypeScript. Tests configured.",
    scorecard: [],
    iterationCount: 1,
    ...overrides,
  };
}

function makeRow(n: number, overrides?: Partial<ScorecardRow>): ScorecardRow {
  return {
    iteration_n: n,
    started_at: `2026-05-10T0${n}:00:00Z`,
    ended_at: `2026-05-10T0${n}:25:00Z`,
    exit_reason: "natural",
    judge_decision: "continue",
    tokens_used: 50000,
    cost_usd: 0.45,
    ...overrides,
  };
}

/** Create a mock caller that returns the given text. */
function mockCaller(text: string): JudgeCaller {
  return async (_input: JudgeCallInput) => ({
    text,
    inputTokens: 1000,
    outputTokens: 200,
  });
}

/** Create a mock caller that returns different text on each call. */
function mockCallerSequence(texts: string[]): JudgeCaller {
  let callIndex = 0;
  return async (_input: JudgeCallInput) => {
    const text = texts[callIndex] ?? texts[texts.length - 1];
    callIndex++;
    return { text, inputTokens: 1000, outputTokens: 200 };
  };
}

/** Create a mock caller that records inputs for assertion. */
function recordingCaller(text: string): {
  caller: JudgeCaller;
  calls: JudgeCallInput[];
} {
  const calls: JudgeCallInput[] = [];
  const caller: JudgeCaller = async (input: JudgeCallInput) => {
    calls.push(input);
    return { text, inputTokens: 1000, outputTokens: 200 };
  };
  return { caller, calls };
}

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

describe("parseVerdict", () => {
  test("parses valid continue verdict", () => {
    const raw = JSON.stringify({
      decision: "continue",
      reasoning: "Progress is on track.",
      second_opinion: "no",
    });
    const result = parseVerdict(raw);
    expect(result).toEqual({
      decision: "continue",
      reasoning: "Progress is on track.",
      second_opinion: "no",
    });
  });

  test("parses valid replan verdict with plan_diff", () => {
    const raw = JSON.stringify({
      decision: "replan",
      reasoning: "Auth middleware approach needs rethinking.",
      second_opinion: "yes",
      plan_diff: "Replace step 3 with OAuth2 flow instead of custom JWT.",
    });
    const result = parseVerdict(raw);
    expect(result).toEqual({
      decision: "replan",
      reasoning: "Auth middleware approach needs rethinking.",
      second_opinion: "yes",
      plan_diff: "Replace step 3 with OAuth2 flow instead of custom JWT.",
    });
  });

  test("parses valid done verdict", () => {
    const raw = JSON.stringify({
      decision: "done",
      reasoning: "All plan items complete, tests passing.",
      second_opinion: "no",
    });
    const result = parseVerdict(raw);
    expect(result).toEqual({
      decision: "done",
      reasoning: "All plan items complete, tests passing.",
      second_opinion: "no",
    });
  });

  test("handles JSON wrapped in markdown fences", () => {
    const raw = '```json\n{"decision":"continue","reasoning":"OK.","second_opinion":"no"}\n```';
    const result = parseVerdict(raw);
    expect(result).toEqual({
      decision: "continue",
      reasoning: "OK.",
      second_opinion: "no",
    });
  });

  test("handles JSON wrapped in bare fences", () => {
    const raw = '```\n{"decision":"done","reasoning":"Complete.","second_opinion":"no"}\n```';
    const result = parseVerdict(raw);
    expect(result).toEqual({
      decision: "done",
      reasoning: "Complete.",
      second_opinion: "no",
    });
  });

  test("returns null for invalid JSON", () => {
    expect(parseVerdict("not json at all")).toBeNull();
    expect(parseVerdict("{broken")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });

  test("returns null for missing required fields", () => {
    // Missing decision
    expect(parseVerdict(JSON.stringify({ reasoning: "x", second_opinion: "no" }))).toBeNull();
    // Missing reasoning
    expect(parseVerdict(JSON.stringify({ decision: "continue", second_opinion: "no" }))).toBeNull();
    // Missing second_opinion
    expect(parseVerdict(JSON.stringify({ decision: "continue", reasoning: "x" }))).toBeNull();
  });

  test("returns null for invalid decision value", () => {
    expect(
      parseVerdict(JSON.stringify({ decision: "expand", reasoning: "x", second_opinion: "no" })),
    ).toBeNull();
  });

  test("returns null for invalid second_opinion value", () => {
    expect(
      parseVerdict(JSON.stringify({ decision: "continue", reasoning: "x", second_opinion: "maybe" })),
    ).toBeNull();
  });

  test("returns null for empty reasoning", () => {
    expect(
      parseVerdict(JSON.stringify({ decision: "continue", reasoning: "", second_opinion: "no" })),
    ).toBeNull();
  });

  test("ignores plan_diff if empty string", () => {
    const raw = JSON.stringify({
      decision: "continue",
      reasoning: "Good.",
      second_opinion: "no",
      plan_diff: "",
    });
    const result = parseVerdict(raw);
    expect(result).toEqual({
      decision: "continue",
      reasoning: "Good.",
      second_opinion: "no",
    });
  });
});

// ---------------------------------------------------------------------------
// buildJudgeUserMessage
// ---------------------------------------------------------------------------

describe("buildJudgeUserMessage", () => {
  test("includes goal text in user message", () => {
    const state = makeState();
    const msg = buildJudgeUserMessage(state, 1);
    expect(msg).toContain("## Goal");
    expect(msg).toContain("REST API for user management");
  });

  test("includes current plan", () => {
    const state = makeState();
    const msg = buildJudgeUserMessage(state, 1);
    expect(msg).toContain("## Current Plan");
    expect(msg).toContain("Implement user model");
  });

  test("includes latest checkpoint", () => {
    const state = makeState();
    const msg = buildJudgeUserMessage(state, 2);
    expect(msg).toContain("## Latest Checkpoint (Iteration 2)");
    expect(msg).toContain("Express app scaffolded");
  });

  test("includes scorecard tail limited to N entries", () => {
    const rows = Array.from({ length: 8 }, (_, i) => makeRow(i + 1));
    const state = makeState({ scorecard: rows });
    const msg = buildJudgeUserMessage(state, 9);
    expect(msg).toContain("## Recent Scorecard");
    // Should only show last 5
    expect(msg).toContain("Iter 4");
    expect(msg).toContain("Iter 8");
    expect(msg).not.toContain("Iter 1:");
    expect(msg).not.toContain("Iter 2:");
    expect(msg).not.toContain("Iter 3:");
  });

  test("includes iteration number", () => {
    const state = makeState();
    const msg = buildJudgeUserMessage(state, 7);
    expect(msg).toContain("## Current Iteration: 7");
  });

  test("handles missing optional fields gracefully", () => {
    const state = makeState({
      frozenPrefix: null,
      plan: null,
      checkpoint: null,
      scorecard: [],
    });
    const msg = buildJudgeUserMessage(state, 1);
    expect(msg).not.toContain("## Prime Directive");
    expect(msg).not.toContain("## Current Plan");
    expect(msg).not.toContain("## Latest Checkpoint");
    expect(msg).not.toContain("## Recent Scorecard");
    expect(msg).toContain("## Current Iteration: 1");
  });
});

// ---------------------------------------------------------------------------
// runJudge — continue verdict
// ---------------------------------------------------------------------------

describe("runJudge", () => {
  test("returns continue verdict on valid response", async () => {
    const caller = mockCaller(
      JSON.stringify({
        decision: "continue",
        reasoning: "Iteration completed successfully, moving to next step.",
        second_opinion: "no",
      }),
    );

    const result = await runJudge({
      state: makeState(),
      iterationN: 1,
      caller,
    });

    expect(result).toEqual({
      decision: "continue",
      reasoning: "Iteration completed successfully, moving to next step.",
      second_opinion: "no",
    });
  });

  test("returns done verdict", async () => {
    const caller = mockCaller(
      JSON.stringify({
        decision: "done",
        reasoning: "All objectives achieved, tests green.",
        second_opinion: "no",
      }),
    );

    const result = await runJudge({
      state: makeState(),
      iterationN: 3,
      caller,
    });

    expect(result.decision).toBe("done");
  });

  // -------------------------------------------------------------------------
  // replan with diff
  // -------------------------------------------------------------------------

  test("returns replan verdict when plan_diff is present", async () => {
    const caller = mockCaller(
      JSON.stringify({
        decision: "replan",
        reasoning: "Current approach hitting a wall with JWT validation.",
        second_opinion: "yes",
        plan_diff: "Switch from custom JWT to passport.js with OAuth2 strategy.",
      }),
    );

    const result = await runJudge({
      state: makeState(),
      iterationN: 2,
      caller,
    });

    expect(result).toEqual({
      decision: "replan",
      reasoning: "Current approach hitting a wall with JWT validation.",
      second_opinion: "yes",
      plan_diff: "Switch from custom JWT to passport.js with OAuth2 strategy.",
    });
  });

  // -------------------------------------------------------------------------
  // replan without diff → downgrades to done
  // -------------------------------------------------------------------------

  test("downgrades replan to done when plan_diff is missing", async () => {
    const caller = mockCaller(
      JSON.stringify({
        decision: "replan",
        reasoning: "Something needs to change.",
        second_opinion: "no",
      }),
    );

    const result = await runJudge({
      state: makeState(),
      iterationN: 2,
      caller,
    });

    expect(result.decision).toBe("done");
    expect(result.reasoning).toContain("no plan_diff provided");
    expect(result.reasoning).toContain("Something needs to change");
  });

  // -------------------------------------------------------------------------
  // Parse failure + retry success
  // -------------------------------------------------------------------------

  test("retries once on parse failure and succeeds", async () => {
    const caller = mockCallerSequence([
      "I think the project is going well! Let me evaluate...",
      JSON.stringify({
        decision: "continue",
        reasoning: "On track.",
        second_opinion: "no",
      }),
    ]);

    const result = await runJudge({
      state: makeState(),
      iterationN: 1,
      caller,
    });

    expect(result.decision).toBe("continue");
    expect(result.reasoning).toBe("On track.");
  });

  // -------------------------------------------------------------------------
  // Parse failure + retry failure → safe default
  // -------------------------------------------------------------------------

  test("returns safe default after two parse failures", async () => {
    const caller = mockCallerSequence([
      "This is not JSON at all.",
      "Still not JSON, sorry.",
    ]);

    const result = await runJudge({
      state: makeState(),
      iterationN: 1,
      caller,
    });

    expect(result).toEqual({
      decision: "replan",
      reasoning: "judge parse failure",
      second_opinion: "no",
    });
  });

  // -------------------------------------------------------------------------
  // Retry mechanics
  // -------------------------------------------------------------------------

  test("retry exactly once — caller is invoked at most twice", async () => {
    const { caller, calls } = recordingCaller("not valid json");

    await runJudge({
      state: makeState(),
      iterationN: 1,
      caller,
    });

    expect(calls.length).toBe(2);
  });

  test("no retry when first attempt succeeds", async () => {
    const { caller, calls } = recordingCaller(
      JSON.stringify({
        decision: "done",
        reasoning: "Complete.",
        second_opinion: "no",
      }),
    );

    await runJudge({
      state: makeState(),
      iterationN: 1,
      caller,
    });

    expect(calls.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Prompt stability
  // -------------------------------------------------------------------------

  test("system prompt is byte-stable across calls", async () => {
    const { caller, calls } = recordingCaller(
      JSON.stringify({
        decision: "continue",
        reasoning: "OK.",
        second_opinion: "no",
      }),
    );

    // Two different iterations with different state
    await runJudge({ state: makeState(), iterationN: 1, caller });
    await runJudge({
      state: makeState({ checkpoint: "Different checkpoint" }),
      iterationN: 2,
      caller,
    });

    // System prompt must be identical across both calls
    expect(calls[0].systemPrompt).toBe(calls[1].systemPrompt);
    expect(calls[0].systemPrompt).toBe(JUDGE_SYSTEM_PROMPT);
  });

  test("user message varies with iteration state", async () => {
    const { caller, calls } = recordingCaller(
      JSON.stringify({
        decision: "continue",
        reasoning: "OK.",
        second_opinion: "no",
      }),
    );

    await runJudge({ state: makeState(), iterationN: 1, caller });
    await runJudge({
      state: makeState({ checkpoint: "New checkpoint content" }),
      iterationN: 5,
      caller,
    });

    expect(calls[0].userMessage).not.toBe(calls[1].userMessage);
    expect(calls[1].userMessage).toContain("New checkpoint content");
    expect(calls[1].userMessage).toContain("Iteration 5");
  });

  // -------------------------------------------------------------------------
  // Model override
  // -------------------------------------------------------------------------

  test("uses default model when not specified", async () => {
    const { caller, calls } = recordingCaller(
      JSON.stringify({
        decision: "continue",
        reasoning: "OK.",
        second_opinion: "no",
      }),
    );

    await runJudge({ state: makeState(), iterationN: 1, caller });
    expect(calls[0].modelId).toBe("claude-opus-4-7");
  });

  test("uses custom model when specified", async () => {
    const { caller, calls } = recordingCaller(
      JSON.stringify({
        decision: "continue",
        reasoning: "OK.",
        second_opinion: "no",
      }),
    );

    await runJudge({
      state: makeState(),
      iterationN: 1,
      caller,
      modelId: "claude-sonnet-4-5",
    });
    expect(calls[0].modelId).toBe("claude-sonnet-4-5");
  });

  // -------------------------------------------------------------------------
  // Retry includes nudge message
  // -------------------------------------------------------------------------

  test("retry user message includes format reminder", async () => {
    const { caller, calls } = recordingCaller("not json");

    await runJudge({ state: makeState(), iterationN: 1, caller });

    // Second call should have the format nudge appended
    expect(calls[1].userMessage).toContain("IMPORTANT");
    expect(calls[1].userMessage).toContain("not valid JSON");
    expect(calls[1].userMessage).toContain('"decision"');
  });

  // -------------------------------------------------------------------------
  // Edge: second_opinion yes is preserved
  // -------------------------------------------------------------------------

  test("preserves second_opinion: yes without triggering anything", async () => {
    const caller = mockCaller(
      JSON.stringify({
        decision: "continue",
        reasoning: "On track but uncertain about auth approach.",
        second_opinion: "yes",
      }),
    );

    const result = await runJudge({
      state: makeState(),
      iterationN: 3,
      caller,
    });

    expect(result.second_opinion).toBe("yes");
    expect(result.decision).toBe("continue");
  });
});
