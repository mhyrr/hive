import { describe, test, expect } from "bun:test";

import {
  resolveCouncilMembers,
  buildCouncilMemberPrompt,
  formatCouncilResultsForSteward,
  type CouncilResult,
} from "../lib/council";

const testConfig = `# Test Config

## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse
- qwen: ollama, qwen3:4b, local fast triage

pi-provider-claude: anthropic
pi-auth-anthropic: oauth-only
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

  test("reports unknown model names", () => {
    const { members, errors } = resolveCouncilMembers(testConfig, ["opus", "nonexistent"]);
    expect(members.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Unknown model 'nonexistent'");
  });

  test("resolves ollama models", () => {
    const { members } = resolveCouncilMembers(testConfig, ["qwen"]);
    expect(members.length).toBe(1);
    expect(members[0]!.provider).toBe("ollama");
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
