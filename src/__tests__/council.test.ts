import { describe, test, expect } from "bun:test";

import {
  resolveCouncilMembers,
  buildCouncilMemberPrompt,
  formatCouncilResultsForSteward,
  assignCamps,
  buildDialecticPrompt,
  formatDialecticResultsForSteward,
  clampRounds,
  type CouncilResult,
  type CouncilMember,
  type Camp,
  type DialecticRound,
  type DialecticResult,
} from "../lib/council";

const testConfig = `# Test Config

## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse
- gpt54: codex, gpt-5.4, OpenAI frontier
- gemini: gemini-cli, gemini-2.5-pro, Google frontier
- qwen: ollama, qwen3:4b, local fast triage
`;

// ---------------------------------------------------------------------------
// resolveCouncilMembers
// ---------------------------------------------------------------------------

describe("resolveCouncilMembers", () => {
  test("resolves valid model names", () => {
    const { members, errors } = resolveCouncilMembers(testConfig, ["opus", "sonnet"]);
    expect(members.length).toBe(2);
    expect(errors.length).toBe(0);
    expect(members[0]!.model.name).toBe("opus");
    expect(members[1]!.model.name).toBe("sonnet");
  });

  test("resolves claude runtime models", () => {
    const { members } = resolveCouncilMembers(testConfig, ["opus"]);
    expect(members.length).toBe(1);
    expect(members[0]!.runtime).toBe("claude");
    expect(members[0]!.modelId).toBe("claude-opus-4-6");
  });

  test("resolves codex runtime models", () => {
    const { members } = resolveCouncilMembers(testConfig, ["gpt54"]);
    expect(members.length).toBe(1);
    expect(members[0]!.runtime).toBe("codex");
    expect(members[0]!.modelId).toBe("gpt-5.4");
  });

  test("resolves gemini runtime models", () => {
    const { members } = resolveCouncilMembers(testConfig, ["gemini"]);
    expect(members.length).toBe(1);
    expect(members[0]!.runtime).toBe("gemini");
    expect(members[0]!.modelId).toBe("gemini-2.5-pro");
  });

  test("reports unknown model names", () => {
    const { members, errors } = resolveCouncilMembers(testConfig, ["opus", "nonexistent"]);
    expect(members.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Unknown model 'nonexistent'");
  });

  test("resolves ollama models", () => {
    const { members } = resolveCouncilMembers(testConfig, ["qwen"]);
    expect(members.length).toBe(1);
    expect(members[0]!.runtime).toBe("ollama");
    expect(members[0]!.modelId).toBe("qwen3:4b");
  });

  test("returns empty for all unknown", () => {
    const { members, errors } = resolveCouncilMembers(testConfig, ["fake1", "fake2"]);
    expect(members.length).toBe(0);
    expect(errors.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildCouncilMemberPrompt
// ---------------------------------------------------------------------------

describe("buildCouncilMemberPrompt", () => {
  test("default persona has basic guidelines", () => {
    const prompt = buildCouncilMemberPrompt(null);
    expect(prompt).toContain("council member");
    expect(prompt).toContain("uncertainty");
    expect(prompt).not.toContain("analyst");
  });

  test("analyst persona adds analytical framing", () => {
    const prompt = buildCouncilMemberPrompt("analyst");
    expect(prompt).toContain("analyst");
    expect(prompt).toContain("multiple angles");
    expect(prompt).toContain("recommendation");
  });
});

// ---------------------------------------------------------------------------
// formatCouncilResultsForSteward
// ---------------------------------------------------------------------------

describe("formatCouncilResultsForSteward", () => {
  const mockResult: CouncilResult = {
    question: "Should we use TOML?",
    positions: [
      {
        modelName: "opus",
        modelId: "claude-opus-4-6",
        provider: "anthropic",
        text: "Yes, TOML is better for config.",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 2000,
        error: null,
      },
      {
        modelName: "gpt54",
        modelId: "gpt-5.4",
        provider: "openai",
        text: "Markdown is fine for now.",
        inputTokens: 100,
        outputTokens: 40,
        durationMs: 1500,
        error: null,
      },
    ],
    durationMs: 2500,
  };

  test("formats positions with model names", () => {
    const output = formatCouncilResultsForSteward(mockResult);
    expect(output).toContain("### opus");
    expect(output).toContain("### gpt54");
    expect(output).toContain("Should we use TOML?");
  });

  test("includes timing and token info", () => {
    const output = formatCouncilResultsForSteward(mockResult);
    expect(output).toContain("2.0s");
    expect(output).toContain("100→50 tokens");
  });

  test("includes structured synthesis prompt", () => {
    const output = formatCouncilResultsForSteward(mockResult);
    expect(output).toContain("**Consensus:**");
    expect(output).toContain("**Divergence:**");
    expect(output).toContain("**Recommendation:**");
  });

  test("handles error positions", () => {
    const withError: CouncilResult = {
      ...mockResult,
      positions: [
        {
          ...mockResult.positions[0]!,
          text: "",
          error: "API timeout",
        },
      ],
    };
    const output = formatCouncilResultsForSteward(withError);
    expect(output).toContain("**Error:** API timeout");
  });
});

// ---------------------------------------------------------------------------
// Dialectic: clampRounds
// ---------------------------------------------------------------------------

describe("clampRounds", () => {
  test("defaults to 3", () => {
    expect(clampRounds(undefined)).toBe(3);
    expect(clampRounds(null)).toBe(3);
  });

  test("clamps to min 1", () => {
    expect(clampRounds(0)).toBe(1);
    expect(clampRounds(-5)).toBe(1);
  });

  test("clamps to max 5", () => {
    expect(clampRounds(10)).toBe(5);
    expect(clampRounds(6)).toBe(5);
  });

  test("passes through valid values", () => {
    expect(clampRounds(1)).toBe(1);
    expect(clampRounds(2)).toBe(2);
    expect(clampRounds(4)).toBe(4);
    expect(clampRounds(5)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Dialectic: assignCamps
// ---------------------------------------------------------------------------

describe("assignCamps", () => {
  const makeMember = (name: string): CouncilMember => ({
    model: { name, runtime: "claude", model: `model-${name}`, description: "" },
    runtime: "claude",
    modelId: `model-${name}`,
  });

  const camps: Camp[] = [
    { name: "rewrite", position: "Full rewrite of the auth system" },
    { name: "refactor", position: "Incremental refactoring over 3 sprints" },
  ];

  test("assigns camps round-robin with equal members and camps", () => {
    const members = [makeMember("a"), makeMember("b")];
    const assignments = assignCamps(members, camps);

    expect(assignments.length).toBe(2);
    expect(assignments[0]!.role).toBe("advocate");
    expect(assignments[0]!.camp!.name).toBe("rewrite");
    expect(assignments[1]!.role).toBe("advocate");
    expect(assignments[1]!.camp!.name).toBe("refactor");
  });

  test("first extra member becomes skeptic", () => {
    const members = [makeMember("a"), makeMember("b"), makeMember("c")];
    const assignments = assignCamps(members, camps);

    expect(assignments.length).toBe(3);
    expect(assignments[0]!.role).toBe("advocate");
    expect(assignments[1]!.role).toBe("advocate");
    expect(assignments[2]!.role).toBe("skeptic");
    expect(assignments[2]!.camp).toBeUndefined();
  });

  test("further extras round-robin back to camps", () => {
    const members = [makeMember("a"), makeMember("b"), makeMember("c"), makeMember("d")];
    const assignments = assignCamps(members, camps);

    expect(assignments.length).toBe(4);
    expect(assignments[2]!.role).toBe("skeptic");
    expect(assignments[3]!.role).toBe("advocate");
    expect(assignments[3]!.camp!.name).toBe("rewrite"); // round-robin back
  });

  test("handles 3 camps with 3 members — no skeptic", () => {
    const threeCamps: Camp[] = [
      { name: "a", position: "pos a" },
      { name: "b", position: "pos b" },
      { name: "c", position: "pos c" },
    ];
    const members = [makeMember("m1"), makeMember("m2"), makeMember("m3")];
    const assignments = assignCamps(members, threeCamps);

    expect(assignments.length).toBe(3);
    expect(assignments.every((a) => a.role === "advocate")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dialectic: buildDialecticPrompt
// ---------------------------------------------------------------------------

describe("buildDialecticPrompt", () => {
  const makeMember = (name: string): CouncilMember => ({
    model: { name, runtime: "claude", model: `model-${name}`, description: "" },
    runtime: "claude",
    modelId: `model-${name}`,
  });

  const camps: Camp[] = [
    { name: "rewrite", position: "Full rewrite" },
    { name: "refactor", position: "Incremental refactor" },
  ];

  test("round 1 advocate prompt argues for position", () => {
    const assignment = { member: makeMember("a"), role: "advocate" as const, camp: camps[0] };
    const prompt = buildDialecticPrompt(assignment, 1, [], camps);

    expect(prompt).toContain("Full rewrite");
    expect(prompt).toContain("STRONGEST possible case");
    expect(prompt).not.toContain("previous round");
  });

  test("round 1 advocate prompt includes brief when present", () => {
    const campWithBrief = { ...camps[0]!, brief: "The current auth code is 5 years old" };
    const assignment = { member: makeMember("a"), role: "advocate" as const, camp: campWithBrief };
    const prompt = buildDialecticPrompt(assignment, 1, [], camps);

    expect(prompt).toContain("5 years old");
  });

  test("round 1 skeptic prompt references all camps", () => {
    const assignment = { member: makeMember("c"), role: "skeptic" as const };
    const prompt = buildDialecticPrompt(assignment, 1, [], camps);

    expect(prompt).toContain("skeptic");
    expect(prompt).toContain("rewrite");
    expect(prompt).toContain("refactor");
    expect(prompt).toContain("pressure-test");
  });

  test("round 2+ advocate prompt includes previous round content", () => {
    const prevRound: DialecticRound = {
      roundNumber: 1,
      durationMs: 1000,
      positions: [
        {
          modelName: "a", modelId: "model-a", provider: "anthropic",
          text: "Rewriting is better because the code is legacy.",
          inputTokens: null, outputTokens: null, durationMs: 500, error: null,
          role: "advocate", campName: "rewrite", roundNumber: 1,
        },
        {
          modelName: "b", modelId: "model-b", provider: "anthropic",
          text: "Refactoring preserves working knowledge.",
          inputTokens: null, outputTokens: null, durationMs: 500, error: null,
          role: "advocate", campName: "refactor", roundNumber: 1,
        },
      ],
    };

    const assignment = { member: makeMember("a"), role: "advocate" as const, camp: camps[0] };
    const prompt = buildDialecticPrompt(assignment, 2, [prevRound], camps);

    expect(prompt).toContain("round 2");
    expect(prompt).toContain("previous round");
    expect(prompt).toContain("Rewriting is better");
    expect(prompt).toContain("Refactoring preserves");
    expect(prompt).toContain("Refine your position");
  });

  test("final round prompt says 'final round'", () => {
    const prevRounds: DialecticRound[] = [
      { roundNumber: 1, durationMs: 1000, positions: [] },
      { roundNumber: 2, durationMs: 1000, positions: [] },
    ];

    const assignment = { member: makeMember("a"), role: "advocate" as const, camp: camps[0] };
    const prompt = buildDialecticPrompt(assignment, 3, prevRounds, camps);

    expect(prompt).toContain("final round");
  });

  test("round 2 (non-final) prompt says 'Evolve'", () => {
    const prevRounds: DialecticRound[] = [
      { roundNumber: 1, durationMs: 1000, positions: [] },
    ];

    const assignment = { member: makeMember("a"), role: "advocate" as const, camp: camps[0] };
    // Round 2 of a 4-round dialectic — not final
    const prompt = buildDialecticPrompt(assignment, 2, prevRounds, camps);

    expect(prompt).toContain("Evolve");
    expect(prompt).not.toContain("final round");
  });

  test("round 2 skeptic prompt references previous arguments", () => {
    const prevRound: DialecticRound = {
      roundNumber: 1,
      durationMs: 1000,
      positions: [
        {
          modelName: "a", modelId: "model-a", provider: "anthropic",
          text: "Rewriting gives us a clean slate.",
          inputTokens: null, outputTokens: null, durationMs: 500, error: null,
          role: "advocate", campName: "rewrite", roundNumber: 1,
        },
      ],
    };

    const assignment = { member: makeMember("c"), role: "skeptic" as const };
    const prompt = buildDialecticPrompt(assignment, 2, [prevRound], camps);

    expect(prompt).toContain("round 2");
    expect(prompt).toContain("clean slate");
    expect(prompt).toContain("Which positions got stronger");
  });
});

// ---------------------------------------------------------------------------
// Dialectic: formatDialecticResultsForSteward
// ---------------------------------------------------------------------------

describe("formatDialecticResultsForSteward", () => {
  const mockResult: DialecticResult = {
    question: "Rewrite vs refactor?",
    camps: [
      { name: "rewrite", position: "Full rewrite" },
      { name: "refactor", position: "Incremental refactor" },
    ],
    rounds: [
      {
        roundNumber: 1,
        durationMs: 3000,
        positions: [
          {
            modelName: "opus", modelId: "claude-opus-4-6", provider: "anthropic",
            text: "Rewriting is the right call because the code is unmaintainable.",
            inputTokens: 200, outputTokens: 100, durationMs: 1500, error: null,
            role: "advocate", campName: "rewrite", roundNumber: 1,
          },
          {
            modelName: "sonnet", modelId: "claude-sonnet-4-6", provider: "anthropic",
            text: "Refactoring preserves institutional knowledge in the code.",
            inputTokens: 200, outputTokens: 80, durationMs: 1200, error: null,
            role: "advocate", campName: "refactor", roundNumber: 1,
          },
        ],
      },
      {
        roundNumber: 2,
        durationMs: 3500,
        positions: [
          {
            modelName: "opus", modelId: "claude-opus-4-6", provider: "anthropic",
            text: "The refactor argument about knowledge preservation is valid but overrated.",
            inputTokens: 400, outputTokens: 120, durationMs: 1800, error: null,
            role: "advocate", campName: "rewrite", roundNumber: 2,
          },
          {
            modelName: "sonnet", modelId: "claude-sonnet-4-6", provider: "anthropic",
            text: "The rewrite advocate concedes the code is hard to work with. But risk is underweighted.",
            inputTokens: 400, outputTokens: 100, durationMs: 1500, error: null,
            role: "advocate", campName: "refactor", roundNumber: 2,
          },
        ],
      },
    ],
    totalDurationMs: 6500,
  };

  test("includes question and camps", () => {
    const output = formatDialecticResultsForSteward(mockResult);
    expect(output).toContain("Rewrite vs refactor?");
    expect(output).toContain("rewrite");
    expect(output).toContain("refactor");
    expect(output).toContain("vs.");
  });

  test("shows round structure", () => {
    const output = formatDialecticResultsForSteward(mockResult);
    expect(output).toContain("### Round 1");
    expect(output).toContain("### Round 2");
  });

  test("labels advocates with camp names", () => {
    const output = formatDialecticResultsForSteward(mockResult);
    expect(output).toContain("[ADVOCATE: rewrite]");
    expect(output).toContain("[ADVOCATE: refactor]");
  });

  test("includes dialectic-specific synthesis prompt", () => {
    const output = formatDialecticResultsForSteward(mockResult);
    expect(output).toContain("**Evolution:**");
    expect(output).toContain("**Strongest surviving argument");
    expect(output).toContain("**Exposed weaknesses:**");
    expect(output).toContain("**Emerged insights:**");
    expect(output).toContain("Take a position");
  });

  test("handles skeptic in output", () => {
    const withSkeptic: DialecticResult = {
      ...mockResult,
      rounds: [{
        roundNumber: 1,
        durationMs: 2000,
        positions: [
          ...mockResult.rounds[0]!.positions,
          {
            modelName: "gpt54", modelId: "gpt-5.4", provider: "openai",
            text: "Both sides underweight migration cost.",
            inputTokens: 200, outputTokens: 60, durationMs: 1000, error: null,
            role: "skeptic", campName: undefined, roundNumber: 1,
          },
        ],
      }],
    };

    const output = formatDialecticResultsForSteward(withSkeptic);
    expect(output).toContain("[SKEPTIC]");
    expect(output).toContain("migration cost");
  });

  test("shows total timing", () => {
    const output = formatDialecticResultsForSteward(mockResult);
    expect(output).toContain("6.5s");
  });

  test("handles error positions", () => {
    const withError: DialecticResult = {
      ...mockResult,
      rounds: [{
        roundNumber: 1,
        durationMs: 1000,
        positions: [{
          modelName: "opus", modelId: "claude-opus-4-6", provider: "anthropic",
          text: "", inputTokens: null, outputTokens: null, durationMs: 0, error: "API timeout",
          role: "advocate", campName: "rewrite", roundNumber: 1,
        }],
      }],
    };

    const output = formatDialecticResultsForSteward(withError);
    expect(output).toContain("**Error:** API timeout");
  });
});
