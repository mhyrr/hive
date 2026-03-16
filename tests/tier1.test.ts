import { describe, expect, test } from "bun:test";

import { compressCompletedRunOutput } from "../src/lib/tier1";
import type { RunRecord } from "../src/lib/runs";

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
