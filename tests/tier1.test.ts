import { describe, expect, test } from "bun:test";

import {
  compressCompletedRunOutput,
  preprocessHumanMessage,
} from "../src/lib/tier1";
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
  test("returns null when there is nothing meaningful to compress", async () => {
    const digest = await compressCompletedRunOutput({
      run: createRun(),
      globalConfig: "",
      finalVisibleOutput: "",
      changedFiles: [],
      gitSummaryLines: [],
    });

    expect(digest).toBeNull();
  });

  test("skips steward runs", async () => {
    const digest = await compressCompletedRunOutput({
      run: createRun({ agentId: "steward" }),
      globalConfig: "",
      finalVisibleOutput: "Human-facing reply",
      changedFiles: [],
      gitSummaryLines: [],
    });

    expect(digest).toBeNull();
  });

  test("skips console runs", async () => {
    const digest = await compressCompletedRunOutput({
      run: createRun({ agentId: "console" }),
      globalConfig: "",
      finalVisibleOutput: "Some console output",
      changedFiles: [],
      gitSummaryLines: [],
    });

    expect(digest).toBeNull();
  });
});

describe("tier-1 human message preprocessing", () => {
  test("skips tier-1 preprocessing for obviously directive messages", async () => {
    const result = await preprocessHumanMessage({
      globalConfig: "",
      message: "Implement a better review flow for the gateway.",
      compactContext: "project: hive",
    });

    expect(result).toBeNull();
  });

  test("skips messages that are too long", async () => {
    const result = await preprocessHumanMessage({
      globalConfig: "",
      message: "x".repeat(300) + "?",
      compactContext: "project: hive",
    });

    expect(result).toBeNull();
  });

  test("skips messages containing code fences", async () => {
    const result = await preprocessHumanMessage({
      globalConfig: "",
      message: "What does `foo` do?",
      compactContext: "project: hive",
    });

    expect(result).toBeNull();
  });

  test("skips messages with file path references", async () => {
    const result = await preprocessHumanMessage({
      globalConfig: "",
      message: "What is in src/lib/runs.ts?",
      compactContext: "project: hive",
    });

    expect(result).toBeNull();
  });

  test("skips multi-line messages with more than 4 lines", async () => {
    const result = await preprocessHumanMessage({
      globalConfig: "",
      message: "line1\nline2\nline3\nline4\nline5?",
      compactContext: "project: hive",
    });

    expect(result).toBeNull();
  });

  test("skips empty messages", async () => {
    const result = await preprocessHumanMessage({
      globalConfig: "",
      message: "",
      compactContext: "project: hive",
    });

    expect(result).toBeNull();
  });
});
