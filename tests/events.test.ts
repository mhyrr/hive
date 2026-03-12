import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
};

let context: TestContext;

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-events-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-09T15:08:00Z";

  return { root, repo, hiveHome };
}

async function initAndAddProject(): Promise<void> {
  await runCli(["init"]);
  await runCli(["project", "add", "TestProject", context.repo]);
}

beforeEach(async () => {
  context = await setupContext();
});

afterEach(async () => {
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  await rm(context.root, { recursive: true, force: true });
});

describe("hive events", () => {
  test("shows empty event stream by default", async () => {
    await initAndAddProject();

    const output = await runCli(["events"]);

    expect(output).toContain("# HIVE Events");
    expect(output).toContain("Recent events: 0");
  });

  test("approval lifecycle is recorded in the internal event ledger", async () => {
    await initAndAddProject();

    await runCli([
      "approval",
      "request",
      "deploy",
      "Promote",
      "the",
      "staging",
      "build",
      "after",
      "review",
    ]);
    await runCli([
      "approval",
      "approve",
      "20260309-150800Z-deploy",
      "Looks",
      "good",
    ]);

    const eventFile = join(context.hiveHome, "events", "internal", "2026-03-09.jsonl");
    const raw = await Bun.file(eventFile).text();
    const rows = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; project?: string; summary?: string });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("approval.requested");
    expect(rows[0]?.project).toBe("testproject");
    expect(rows[1]?.kind).toBe("approval.resolved");

    const output = await runCli(["events", "5", "--scope", "internal"]);

    expect(output).toContain("Internal events: 2");
    expect(output).toContain("approval.requested");
    expect(output).toContain("approval.resolved");
    expect(output).toContain("Promote the staging build after review");
    expect(output).toContain("source: approval");
  });
});
