import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "hive-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-09T15:08:00Z";

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

describe("HIVE CLI", () => {
  test("init scaffolds the hive home and activates the project", async () => {
    const output = await runCli(["init", "DealSplit", context.repo]);

    expect(output).toContain("Initialized dealsplit");
    expect(await Bun.file(join(context.hiveHome, "SOUL.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "SELF.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "personas", "steward.md")).exists()).toBeTrue();
    expect((await Bun.file(join(context.hiveHome, "active-project.txt")).text()).trim()).toBe(
      "dealsplit",
    );
  });

  test("status shows the board and open messages for the active project", async () => {
    await runCli(["init", "DealSplit", context.repo]);
    await runCli(["log", "Session kickoff"]);
    await runCli([
      "msg",
      "--type",
      "question",
      "beta",
      "alpha",
      "Need",
      "the",
      "auth",
      "contract",
    ]);

    const status = await runCli(["status"]);
    const log = await Bun.file(
      join(context.hiveHome, "projects", "dealsplit", "LOG.md"),
    ).text();

    expect(status).toContain("Project: dealsplit");
    expect(status).toContain("BOARD.md");
    expect(status).toContain("Need the auth contract");
    expect(log).toContain("Session kickoff");
  });

  test("prompt assembles persona, plan assignment, and agent messages", async () => {
    await runCli(["init", "DealSplit", context.repo]);

    await Bun.write(
      join(context.hiveHome, "projects", "dealsplit", "PLAN.md"),
      `# Plan: DealSplit

## Goal
Ship the login flow.

## Agents
### orchestrator (steward)
Task: Run the board.

### alpha (craftsman -> src/api/**)
Task: Build the auth endpoint and publish the contract.

## Rules
- Keep the board current via messages.
`,
    );

    await runCli([
      "msg",
      "--type",
      "question",
      "beta",
      "alpha",
      "Need",
      "the",
      "login",
      "contract",
      "shape",
    ]);

    const prompt = await runCli(["prompt", "alpha"]);

    expect(prompt).toContain("You are alpha for project dealsplit.");
    expect(prompt).toContain("# HIVE Soul");
    expect(prompt).toContain("# Persona: Craftsman");
    expect(prompt).toContain("Task: Build the auth endpoint and publish the contract.");
    expect(prompt).toContain("Need the login contract shape");
  });

  test("sync copies PLAN.md into the repo and archive snapshots the session", async () => {
    await runCli(["init", "DealSplit", context.repo]);
    await runCli(["log", "Captured session context"]);

    const syncOutput = await runCli(["sync"]);

    expect(syncOutput).toContain(join(context.repo, ".hive", "PLAN.md"));
    expect(await Bun.file(join(context.repo, ".hive", "PLAN.md")).exists()).toBeTrue();

    const archiveOutput = await runCli(["archive"]);
    const archivedEntries = await readdir(join(context.hiveHome, "archive", "2026", "03"));
    const refreshedLog = await Bun.file(
      join(context.hiveHome, "projects", "dealsplit", "LOG.md"),
    ).text();

    expect(archiveOutput).toContain(join(context.hiveHome, "archive", "2026", "03"));
    expect(archivedEntries.some((entry) => entry.endsWith("-dealsplit.md"))).toBeTrue();
    expect(refreshedLog).toContain("# Log: 2026-03-09 dealsplit");
    expect(refreshedLog).not.toContain("Captured session context");
  });

  test("orchestrate kickoff records a human goal and prints a steward prompt", async () => {
    await runCli(["init", "DealSplit", context.repo]);

    const prompt = await runCli(["orchestrate", "Build", "the", "auth", "flow"]);
    const log = await Bun.file(
      join(context.hiveHome, "projects", "dealsplit", "LOG.md"),
    ).text();
    const msgDirEntries = await readdir(join(context.hiveHome, "msg"));
    const messageText = await Bun.file(join(context.hiveHome, "msg", msgDirEntries[0])).text();

    expect(prompt).toContain("# HIVE Steward Prompt");
    expect(prompt).toContain("Interactive mode.");
    expect(prompt).toContain("Build the auth flow");
    expect(prompt).toContain("Human nudge pending: Build the auth flow");
    expect(log).toContain("Goal: Build the auth flow");
    expect(messageText).toContain("type: nudge");
    expect(messageText).toContain("to: orchestrator");
  });

  test("orchestrate loop mode resumes state and surfaces stale-agent signals", async () => {
    await runCli(["init", "DealSplit", context.repo]);

    await Bun.write(
      join(context.hiveHome, "projects", "dealsplit", "BOARD.md"),
      `# Board

## Tasks
- 001: Auth endpoint [alpha] [active] [14:50]

## Agents
### alpha (craftsman -> backend)
status: active on 001
last-active: 14:50

### beta (craftsman -> frontend)
status: waiting
last-active: 15:03

## Blockers
(none)

## Decisions
(none)
`,
    );

    await Bun.write(
      join(context.hiveHome, "msg", "20260309-144000-beta-to-alpha-manual.md"),
      `---
from: beta
to: alpha
type: question
status: open
ts: 2026-03-09T14:40:00Z
project: dealsplit
---

Need the auth contract shape.
`,
    );

    const beforeLog = await Bun.file(
      join(context.hiveHome, "projects", "dealsplit", "LOG.md"),
    ).text();
    const prompt = await runCli(["orchestrate", "--mode", "loop", "--interval", "30"]);
    const afterLog = await Bun.file(
      join(context.hiveHome, "projects", "dealsplit", "LOG.md"),
    ).text();

    expect(prompt).toContain("Loop mode. Run one assessment/action cycle, then pause 30 seconds");
    expect(prompt).toContain("alpha is marked active but last-active was 18 minutes ago.");
    expect(prompt).toContain("Open question from beta to alpha has been waiting 28 minutes.");
    expect(afterLog).toBe(beforeLog);
  });
});
