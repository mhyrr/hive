import { describe, expect, test } from "bun:test";

import {
  compressCompletedRunOutput,
  preprocessHumanMessage,
  triageRunDiffForSteward,
} from "../src/lib/tier1";
import type { RunRecord, RunResult } from "../src/lib/runs";

function createRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    runId: "20260316-010000-alpha",
    projectId: "hive",
    agentId: "architect",
    status: "exited",
    runtime: "codex",
    model: "gpt-5-codex",
    started: "2026-03-16T01:00:00Z",
    ended: "2026-03-16T01:01:00Z",
    exitCode: 0,
    pid: null,
    promptPath: "/tmp/prompt.md",
    source: "hive launch",
    sourceMessage: "20260316-architect-task.md",
    taskId: "HIVE-201",
    scope: ["src/lib"],
    stopRequestedAt: null,
    stopRequestedBy: null,
    path: "/tmp/run.md",
    ...overrides,
  };
}

function createResult(overrides?: Partial<RunResult>): RunResult {
  return {
    runId: "20260316-010000-alpha",
    agentId: "architect",
    status: "exited",
    exitCode: 0,
    assignmentMessage: "20260316-architect-task.md",
    assignmentStatusAfterExit: "resolved",
    assignmentResolvedByWorker: true,
    changedFiles: ["tests/state.test.ts"],
    gitSummaryLines: ["M tests/state.test.ts"],
    finalVisibleOutput: "Updated the regression coverage.",
    ended: "2026-03-16T01:01:00Z",
    path: "/tmp/result.md",
    authMode: "api",
    costUsd: null,
    durationMs: null,
    numTurns: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    totalTokens: null,
    cognitiveDigest: {
      provider: "ollama",
      model: "qwen3:4b",
      summary: "Updated the regression coverage.",
      outcome: "success",
      keyDecisions: [],
      filesChanged: ["tests/state.test.ts"],
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      durationMs: null,
    },
    ...overrides,
  };
}

describe("tier-1 run compression", () => {
  test("compresses completed worker output with the configured local Ollama model", async () => {
    let chatCalled = false;
    const digest = await compressCompletedRunOutput({
      run: createRun(),
      globalConfig: [
        "tier1_local: qwen3:4b",
        "ollama-base-url: http://127.0.0.1:11434",
      ].join("\n"),
      finalVisibleOutput: "Implemented the runtime digest and updated tests.",
      changedFiles: ["src/lib/runs.ts", "tests/state.test.ts"],
      gitSummaryLines: ["M src/lib/runs.ts", "M tests/state.test.ts"],
      fetchImpl: (async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "http://127.0.0.1:11434/api/tags") {
          return new Response(
            JSON.stringify({
              models: [{ name: "qwen3:4b" }],
            }),
            { status: 200 },
          );
        }

        if (url === "http://127.0.0.1:11434/api/chat") {
          chatCalled = true;
          const body = JSON.parse(String(init?.body)) as {
            model: string;
            messages: Array<{ role: string; content: string }>;
          };

          expect(body.model).toBe("qwen3:4b");
          expect(body.messages[1]?.content).toContain("architect");
          expect(body.messages[1]?.content).toContain("src/lib/runs.ts");

          return new Response(
            JSON.stringify({
              message: {
                content: JSON.stringify({
                  summary: "Architect finished the runtime digest and test updates.",
                  outcome: "success",
                  key_decisions: ["Persist the tier-1 digest in result metadata."],
                  files_changed: ["src/lib/runs.ts", "tests/state.test.ts"],
                }),
              },
              prompt_eval_count: 91,
              eval_count: 27,
              total_duration: 1_800_000_000,
            }),
            { status: 200 },
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch,
    });

    expect(chatCalled).toBeTrue();
    expect(digest?.provider).toBe("ollama");
    expect(digest?.model).toBe("qwen3:4b");
    expect(digest?.summary).toBe("Architect finished the runtime digest and test updates.");
    expect(digest?.filesChanged).toEqual(["src/lib/runs.ts", "tests/state.test.ts"]);
    expect(digest?.inputTokens).toBe(91);
    expect(digest?.outputTokens).toBe(27);
    expect(digest?.totalTokens).toBe(118);
    expect(digest?.durationMs).toBe(1800);
  });

  test("does not invoke tier-1 compression unless tier1_local is explicitly configured", async () => {
    let fetchCalled = false;
    const digest = await compressCompletedRunOutput({
      run: createRun(),
      globalConfig: "",
      finalVisibleOutput: "Implemented the runtime digest and updated tests.",
      changedFiles: ["src/lib/runs.ts"],
      gitSummaryLines: ["M src/lib/runs.ts"],
      fetchImpl: (async () => {
        fetchCalled = true;
        throw new Error("unexpected fetch");
      }) as typeof fetch,
    });

    expect(digest).toBeNull();
    expect(fetchCalled).toBeFalse();
  });

  test("falls back to cloud Haiku via pi-ai when a tier-1 cloud route is explicitly configured", async () => {
    let fetchCalled = false;
    let cloudCalled = false;
    const digest = await compressCompletedRunOutput({
      run: createRun(),
      globalConfig: [
        "tier1_cloud: haiku",
        "tier1_cloud_provider: anthropic",
        "tier1_cloud_model: claude-haiku-4-5-20251001",
      ].join("\n"),
      finalVisibleOutput: "Implemented the runtime digest and updated tests.",
      changedFiles: ["src/lib/runs.ts"],
      gitSummaryLines: ["M src/lib/runs.ts"],
      fetchImpl: (async () => {
        fetchCalled = true;
        throw new Error("local fetch should not run");
      }) as typeof fetch,
      cloudRunner: async (input) => {
        cloudCalled = true;
        expect(input.provider).toBe("anthropic");
        expect(input.modelId).toBe("claude-haiku-4-5-20251001");
        expect(input.userContent).toContain("Implemented the runtime digest");

        return {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          text: JSON.stringify({
            summary: "Haiku compressed the worker result for steward intake.",
            outcome: "success",
            key_decisions: ["Store the digest beside result metadata."],
            files_changed: ["src/lib/runs.ts"],
          }),
          inputTokens: 44,
          outputTokens: 19,
          totalTokens: 63,
          durationMs: 950,
          raw: {} as never,
        };
      },
    });

    expect(fetchCalled).toBeFalse();
    expect(cloudCalled).toBeTrue();
    expect(digest?.provider).toBe("anthropic");
    expect(digest?.model).toBe("claude-haiku-4-5-20251001");
    expect(digest?.summary).toBe("Haiku compressed the worker result for steward intake.");
    expect(digest?.totalTokens).toBe(63);
  });

  test("skips steward runs even when tier-1 local execution is configured", async () => {
    let fetchCalled = false;
    const digest = await compressCompletedRunOutput({
      run: createRun({
        agentId: "steward",
      }),
      globalConfig: "tier1_local: qwen3:4b",
      finalVisibleOutput: "Human-facing reply",
      changedFiles: [],
      gitSummaryLines: [],
      fetchImpl: (async () => {
        fetchCalled = true;
        throw new Error("unexpected fetch");
      }) as typeof fetch,
    });

    expect(digest).toBeNull();
    expect(fetchCalled).toBeFalse();
  });
});

describe("tier-1 human message preprocessing", () => {
  test("classifies a short context-bound question as a simple query", async () => {
    let chatCalled = false;
    const result = await preprocessHumanMessage({
      globalConfig: "tier1_local: qwen3:4b",
      message: "Which lane is the steward using right now?",
      compactContext: [
        "project: hive",
        "session-selection: claude (claude-sonnet-4-6)",
        "current-execution: persistent steward via Pi | claude -> anthropic | model: claude-haiku-4-5-20251001 | auth: env",
      ].join("\n"),
      fetchImpl: (async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "http://127.0.0.1:11434/api/tags") {
          return new Response(
            JSON.stringify({
              models: [{ name: "qwen3:4b" }],
            }),
            { status: 200 },
          );
        }

        if (url === "http://127.0.0.1:11434/api/chat") {
          chatCalled = true;
          return new Response(
            JSON.stringify({
              message: {
                content: JSON.stringify({
                  classification: "simple_query",
                  answer: "Current execution is the persistent Pi-backed Claude lane on Haiku.",
                  reason: "The answer is available directly from the compact routing context.",
                }),
              },
              prompt_eval_count: 63,
              eval_count: 24,
              total_duration: 1_200_000_000,
            }),
            { status: 200 },
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch,
    });

    expect(chatCalled).toBeTrue();
    expect(result?.classification).toBe("simple_query");
    expect(result?.answer).toContain("persistent Pi-backed Claude lane");
    expect(result?.model).toBe("qwen3:4b");
    expect(result?.totalTokens).toBe(87);
  });

  test("skips tier-1 preprocessing for obviously directive messages", async () => {
    let fetchCalled = false;
    const result = await preprocessHumanMessage({
      globalConfig: "tier1_local: qwen3:4b",
      message: "Implement a better review flow for the gateway.",
      compactContext: "project: hive",
      fetchImpl: (async () => {
        fetchCalled = true;
        throw new Error("unexpected fetch");
      }) as typeof fetch,
    });

    expect(result).toBeNull();
    expect(fetchCalled).toBeFalse();
  });
});

describe("tier-1 diff triage", () => {
  test("suppresses steward wakeups for routine support diffs when no tier-1 model is configured", async () => {
    const decision = await triageRunDiffForSteward({
      globalConfig: "",
      result: createResult(),
    });

    expect(decision.stewardWorthy).toBeFalse();
    expect(decision.handledBy).toBe("deterministic");
    expect(decision.reason).toContain("routine support files");
  });

  test("forces steward review when the diff touches steward-owned coordination files", async () => {
    const decision = await triageRunDiffForSteward({
      globalConfig: "",
      result: createResult({
        changedFiles: ["PLAN.md"],
        gitSummaryLines: ["M PLAN.md"],
      }),
    });

    expect(decision.stewardWorthy).toBeTrue();
    expect(decision.handledBy).toBe("deterministic");
    expect(decision.reason).toContain("coordination file");
  });
});
