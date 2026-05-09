import { describe, expect, test } from "bun:test";

import {
  runDecomposeLoop,
  type LLMCallInput,
  type LLMCallOutput,
  type LLMCaller,
} from "./decompose-loop";
import type { DecomposeContext } from "./decompose-prompt";

// ---------------------------------------------------------------------------
// Helpers — synthetic context + scriptable LLM
// ---------------------------------------------------------------------------

const ctx: DecomposeContext = {
  projectId: "hive",
  goal: "test goal",
  indexMd: "",
  principlesMd: "",
  searchHits: [],
  openTickets: [],
};

function validProposalJson(): string {
  return JSON.stringify({
    epic: { title: "An epic", body: "## Goal\ntest", tags: [] },
    children: [
      {
        ref: "C1",
        title: "Step one",
        type: "task",
        tags: [],
        depends: [],
        body: "## Scope\n…\n## Acceptance\n- [ ] ok",
      },
      {
        ref: "C2",
        title: "Step two",
        type: "task",
        tags: [],
        depends: ["C1"],
        body: "## Scope\n…\n## Acceptance\n- [ ] ok",
      },
    ],
  });
}

function cyclicProposalJson(): string {
  return JSON.stringify({
    epic: { title: "Bad", body: "", tags: [] },
    children: [
      { ref: "A", title: "A", type: "task", tags: [], depends: ["B"], body: "" },
      { ref: "B", title: "B", type: "task", tags: [], depends: ["A"], body: "" },
    ],
  });
}

function abortDecisionJson(reason: string): string {
  return JSON.stringify({ decision: "abort", reason });
}

function reframeDecisionJson(reframe: string): string {
  return JSON.stringify({ decision: "retry-with-reframe", reframe });
}

function acceptDecisionJson(warning: string): string {
  return JSON.stringify({ decision: "accept-with-warn", warning });
}

type ScriptStep = string | { text: string; inputTokens: number; outputTokens: number };

function script(sequence: ScriptStep[]): { llm: LLMCaller; calls: LLMCallInput[] } {
  const calls: LLMCallInput[] = [];
  let i = 0;
  const llm: LLMCaller = async (input) => {
    calls.push(input);
    if (i >= sequence.length) {
      throw new Error(`LLM script exhausted at call ${i + 1}`);
    }
    const step = sequence[i++]!;
    const text = typeof step === "string" ? step : step.text;
    const inputTokens = typeof step === "string" ? 100 : step.inputTokens;
    const outputTokens = typeof step === "string" ? 50 : step.outputTokens;
    const out: LLMCallOutput = { text, inputTokens, outputTokens };
    return out;
  };
  return { llm, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDecomposeLoop — happy path", () => {
  test("returns the proposal on first valid output", async () => {
    const { llm, calls } = script([validProposalJson()]);
    const result = await runDecomposeLoop({ context: ctx, llm });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.children).toHaveLength(2);
      expect(result.attempts).toHaveLength(1);
      expect(result.totalCostUsd).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
    }
  });
});

describe("runDecomposeLoop — retry-with-reframe", () => {
  test("loops cycle → reframe → valid", async () => {
    const { llm, calls } = script([
      cyclicProposalJson(),
      reframeDecisionJson("Remove the cycle between A and B."),
      validProposalJson(),
    ]);
    const result = await runDecomposeLoop({ context: ctx, llm });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toHaveLength(2);
      expect(result.reframes).toEqual([
        "Remove the cycle between A and B.",
      ]);
      // 3 calls: decompose, orient, decompose
      expect(calls).toHaveLength(3);
    }
  });

  test("appends prior reframes to the user message on retry", async () => {
    const { llm, calls } = script([
      cyclicProposalJson(),
      reframeDecisionJson("First reframe."),
      cyclicProposalJson(),
      reframeDecisionJson("Second reframe."),
      validProposalJson(),
    ]);
    const result = await runDecomposeLoop({ context: ctx, llm });

    expect(result.ok).toBe(true);
    // The 5th call (final decompose) should carry both reframes.
    const finalDecompose = calls[4]!;
    expect(finalDecompose.userMessage).toContain("First reframe.");
    expect(finalDecompose.userMessage).toContain("Second reframe.");
  });
});

describe("runDecomposeLoop — accept-with-warn", () => {
  test("ships a partial proposal when orient picks accept-with-warn", async () => {
    // Cycle is a graph-level failure; validation.partial is set.
    const { llm } = script([
      cyclicProposalJson(),
      acceptDecisionJson("Cycle ignored — proposal is otherwise sound."),
    ]);
    const result = await runDecomposeLoop({ context: ctx, llm });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([
        "Cycle ignored — proposal is otherwise sound.",
      ]);
      expect(result.proposal.children).toHaveLength(2);
    }
  });

  test("falls through to abort when accept-with-warn fires on JSON-level failure", async () => {
    const { llm } = script([
      "not json at all",
      acceptDecisionJson("Tried to accept with no usable proposal."),
    ]);
    const result = await runDecomposeLoop({ context: ctx, llm });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no usable proposal");
    }
  });
});

describe("runDecomposeLoop — abort", () => {
  test("returns abort with reason", async () => {
    const { llm } = script([
      "garbage",
      abortDecisionJson("Goal too vague."),
    ]);
    const result = await runDecomposeLoop({ context: ctx, llm });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("Goal too vague.");
      expect(result.attempts).toHaveLength(1);
    }
  });

  test("returns abort when orient returns unparseable JSON", async () => {
    const { llm } = script(["garbage", "this is not json either"]);
    const result = await runDecomposeLoop({ context: ctx, llm });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Orient returned unparseable response");
    }
  });
});

describe("runDecomposeLoop — budget", () => {
  test("aborts when spend cap is exceeded", async () => {
    // Cyclic proposal parses but fails graph validation so orient runs.
    // Each decompose call costs ~$15 input + $7.50 output = $22.50, far above
    // the $1 cap. The cap check at the top of attempt 2 trips.
    const { llm } = script([
      { text: cyclicProposalJson(), inputTokens: 1_000_000, outputTokens: 100_000 },
      { text: reframeDecisionJson("retry"), inputTokens: 100, outputTokens: 50 },
      { text: cyclicProposalJson(), inputTokens: 100_000, outputTokens: 10_000 },
    ]);
    const result = await runDecomposeLoop({
      context: ctx,
      llm,
      maxCostUsd: 1,
      maxAttempts: 8,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Spend cap exceeded");
    }
  });

  test("aborts when attempt cap is exceeded", async () => {
    // Always returns garbage + always says retry.
    const sequence: string[] = [];
    for (let i = 0; i < 20; i++) {
      sequence.push("garbage");
      sequence.push(reframeDecisionJson(`reframe ${i}`));
    }
    const { llm } = script(sequence);
    const result = await runDecomposeLoop({
      context: ctx,
      llm,
      maxAttempts: 3,
      maxCostUsd: 100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Exhausted 3 attempts");
      expect(result.attempts).toHaveLength(3);
    }
  });
});

describe("runDecomposeLoop — onAttempt", () => {
  test("invokes onAttempt for every attempt", async () => {
    const seen: number[] = [];
    const { llm } = script([
      cyclicProposalJson(),
      reframeDecisionJson("fix it"),
      validProposalJson(),
    ]);
    await runDecomposeLoop({
      context: ctx,
      llm,
      onAttempt: (a) => seen.push(a.attempt),
    });
    expect(seen).toEqual([1, 2]);
  });
});
