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

async function initHive(): Promise<string> {
  return runCli(["init"]);
}

async function addProject(): Promise<string> {
  return runCli(["project", "add", "DealSplit", context.repo]);
}

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
  test("init scaffolds the hive home without registering a project", async () => {
    const output = await initHive();

    expect(output).toContain("Initialized hive home");
    expect(await Bun.file(join(context.hiveHome, "SOUL.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "SELF.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "personas", "steward.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "active-project.txt")).exists()).toBeFalse();
  });

  test("project add registers the repo and activates the project", async () => {
    await initHive();

    const output = await addProject();

    expect(output).toContain("Registered project dealsplit");
    expect((await Bun.file(join(context.hiveHome, "active-project.txt")).text()).trim()).toBe(
      "dealsplit",
    );
    expect(await Bun.file(join(context.hiveHome, "projects", "dealsplit", "PLAN.md")).exists()).toBeTrue();
  });

  test("status shows the board and open messages for the active project", async () => {
    await initHive();
    await addProject();
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

  test("inbox and message lifecycle commands keep open queues clean", async () => {
    await initHive();
    await addProject();

    const createOutput = await runCli([
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
    const filename = createOutput.match(/([^\s]+\.md)$/)?.[1];

    expect(filename).toBeString();

    const inboxBefore = await runCli(["inbox", "alpha"]);
    const rawBefore = await runCli(["msg", "show", filename!]);

    expect(inboxBefore).toContain("Inbox: alpha");
    expect(inboxBefore).toContain(filename!);
    expect(rawBefore).toContain("status: open");
    expect(rawBefore).toContain("Need the auth contract");

    const resolveOutput = await runCli([
      "msg",
      "resolve",
      filename!,
      "alpha",
      "Published",
      "the",
      "contract",
      "in",
      "src/api/auth.ts",
    ]);
    const rawAfter = await Bun.file(join(context.hiveHome, "msg", filename!)).text();
    const inboxAfter = await runCli(["inbox", "alpha"]);
    const statusAfter = await runCli(["status"]);

    expect(resolveOutput).toContain(`Resolved ${filename!}`);
    expect(rawAfter).toContain("status: resolved");
    expect(rawAfter).toContain("resolved: 2026-03-09T15:08:00Z");
    expect(rawAfter).toContain("## Answer (alpha, 2026-03-09T15:08:00Z)");
    expect(rawAfter).toContain("Published the contract in src/api/auth.ts");
    expect(inboxAfter).toContain("No open messages.");
    expect(statusAfter).not.toContain(filename!);
    expect(statusAfter).not.toContain("Need the auth contract");

    const secondCreateOutput = await runCli([
      "msg",
      "--type",
      "notify",
      "orchestrator",
      "alpha",
      "Hold",
      "for",
      "task",
      "004",
    ]);
    const secondFilename = secondCreateOutput.match(/([^\s]+\.md)$/)?.[1];

    expect(secondFilename).toBeString();

    const closeOutput = await runCli([
      "msg",
      "close",
      secondFilename!,
      "alpha",
      "Superseded",
      "by",
      "task",
      "004",
    ]);
    const closedRaw = await Bun.file(join(context.hiveHome, "msg", secondFilename!)).text();
    const finalInbox = await runCli(["inbox", "alpha"]);

    expect(closeOutput).toContain(`Closed ${secondFilename!}`);
    expect(closedRaw).toContain("status: closed");
    expect(closedRaw).toContain("closed: 2026-03-09T15:08:00Z");
    expect(closedRaw).toContain("## Closed (alpha, 2026-03-09T15:08:00Z)");
    expect(closedRaw).toContain("Superseded by task 004");
    expect(finalInbox).toContain("No open messages.");
  });

  test("prompt assembles persona, plan assignment, and agent messages", async () => {
    await initHive();
    await addProject();

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
    await initHive();
    await addProject();
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
    await initHive();
    await addProject();

    const prompt = await runCli(["orchestrate", "Build", "the", "auth", "flow"]);
    const log = await Bun.file(
      join(context.hiveHome, "projects", "dealsplit", "LOG.md"),
    ).text();
    const msgDirEntries = await readdir(join(context.hiveHome, "msg"));
    const messageText = await Bun.file(join(context.hiveHome, "msg", msgDirEntries[0])).text();

    expect(prompt).toContain("# HIVE Steward Prompt");
    expect(prompt).toContain("Human-driven single-pass mode.");
    expect(prompt).toContain("Build the auth flow");
    expect(prompt).toContain("Human nudge pending: Build the auth flow");
    expect(prompt).toContain("When you fully handle a message, resolve it or close it so the open queue stays clean.");
    expect(prompt).toContain("hive msg resolve <message> orchestrator <answer>");
    expect(prompt).toContain("hive inbox <agent>");
    expect(log).toContain("Goal: Build the auth flow");
    expect(messageText).toContain("type: nudge");
    expect(messageText).toContain("to: orchestrator");
  });

  test("orchestrate loop mode resumes state and surfaces stale-agent signals", async () => {
    await initHive();
    await addProject();

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
