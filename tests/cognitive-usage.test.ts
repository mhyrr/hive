import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildProjectCognitiveUsageSnapshot, refreshProjectCognitiveUsageSnapshot } from "../src/lib/cognitive-usage";
import { ensureHiveScaffold, ensureProjectScaffold, getHivePaths } from "../src/lib/paths";
import { createRunDraft, finalizeRun, writeRunResult } from "../src/lib/runs";
import { appendTurn, createSession } from "../src/lib/sessions";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
};

let context: TestContext;

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-usage-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });
  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-16T12:00:00Z";

  return { root, repo, hiveHome };
}

beforeEach(async () => {
  context = await setupContext();
});

afterEach(async () => {
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  await rm(context.root, { recursive: true, force: true });
});

describe("cognitive usage snapshot", () => {
  test("aggregates tier-1 worker compression, tier-2 runs, and tier-3 session turns", async () => {
    const paths = getHivePaths(context.hiveHome);
    await ensureHiveScaffold(context.hiveHome);
    const projectPaths = await ensureProjectScaffold(paths, {
      projectId: "hive",
      projectName: "Hive",
      repoPath: context.repo,
    });
    const session = await createSession({
      sessionsDir: paths.sessionsDir,
      project: "hive",
      runtime: "claude",
      model: "claude-sonnet-4-6",
      systemPrompt: "You are the steward.",
    });

    await appendTurn({
      sessionsDir: paths.sessionsDir,
      sessionId: session.sessionId,
      role: "assistant",
      source: "model",
      content: "Persistent steward reply.",
      details: {
        project: "hive",
        runId: null,
        runtime: "pi",
        model: "anthropic/claude-haiku-4-5-20251001",
        authMode: "unknown",
        durationMs: 1800,
        numTurns: 1,
        costUsd: 0.03,
        inputTokens: 900,
        outputTokens: 300,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 1200,
        board: null,
        messages: null,
        runs: null,
        routing: {
          tier: "tier3",
          mode: "direct-answer",
          handledBy: "persistent-steward",
          lane: "persistent steward via Pi | claude -> anthropic | model: claude-haiku-4-5-20251001 | auth: env",
          fanOutUsed: 0,
          parallelismUsed: 1,
          reusedFreshWorkerOutput: false,
          trace: ["The message was routed to the persistent steward lane."],
        },
        statusNotes: null,
      },
    });

    const run = await createRunDraft({
      projectId: "hive",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "Implement the API change.",
      source: "steward",
      sourceMessage: "Implement the API change.",
    });
    const finalized = await finalizeRun({
      projectPaths,
      run,
      status: "exited",
      exitCode: 0,
    });
    await writeRunResult(finalized, {
      finalVisibleOutput: "Implemented the API change and added tests.",
      authMode: "api",
      costUsd: 0.02,
      durationMs: 4200,
      numTurns: 1,
      inputTokens: 500,
      outputTokens: 400,
      totalTokens: 900,
      cognitiveDigest: {
        provider: "ollama",
        model: "qwen3:4b",
        summary: "Alpha implemented the API change.",
        outcome: "success",
        keyDecisions: ["Updated the controller contract."],
        filesChanged: ["src/api.ts"],
        inputTokens: 70,
        outputTokens: 40,
        totalTokens: 110,
        durationMs: 240,
      },
    });

    const snapshot = await buildProjectCognitiveUsageSnapshot({
      hivePaths: paths,
      projectId: "hive",
      globalConfig: [
        "cognitive-window-hours: 24",
        "cognitive-budget-tier1-tokens: 500",
        "cognitive-budget-tier2-tokens: 2000",
        "cognitive-budget-tier3-tokens: 2000",
      ].join("\n"),
    });

    expect(snapshot.project).toBe("hive");
    expect(snapshot.tiers.tier1.totalTokens).toBe(110);
    expect(snapshot.tiers.tier2.totalTokens).toBe(900);
    expect(snapshot.tiers.tier3.totalTokens).toBe(1200);
    expect(snapshot.summary.tier1Calls).toBe(1);
    expect(snapshot.summary.workerRuns).toBe(1);
    expect(snapshot.summary.stewardWakes).toBe(1);
    expect(snapshot.summary.lastStewardWakeAt).toBe("2026-03-16T12:00:00Z");
    expect(snapshot.budgets.tier1.status).toBe("ok");
    expect(snapshot.budgets.tier2.status).toBe("ok");
    expect(snapshot.budgets.tier3.status).toBe("ok");

    const persisted = await refreshProjectCognitiveUsageSnapshot({
      hivePaths: paths,
      projectId: "hive",
      globalConfig: "cognitive-budget-tier3-tokens: 1000",
    });

    expect(persisted.budgets.tier3.status).toBe("over");
    expect(await Bun.file(projectPaths.stateUsage).exists()).toBeTrue();
  });
});
