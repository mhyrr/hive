import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { ensureHiveScaffold, getProjectPaths } from "../src/lib/paths";
import {
  createRunDraft,
  finalizeRun,
  writeRunResult,
} from "../src/lib/runs";
import { createSession } from "../src/lib/sessions";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
};

let context: TestContext;
let originalFetch = globalThis.fetch;

async function initHive(): Promise<string> {
  return runCli(["init"]);
}

async function addProject(): Promise<string> {
  return runCli(["project", "add", "MyProject", context.repo]);
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
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  delete process.env.HIVE_ENABLE_PERSISTENT_STEWARD;
  globalThis.fetch = originalFetch;
  await rm(context.root, { recursive: true, force: true });
});

describe("HIVE CLI", () => {
  test("init scaffolds the hive home without registering a project", async () => {
    const output = await initHive();

    expect(output).toContain("Initialized hive home");
    expect(await Bun.file(join(context.hiveHome, "SOUL.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "IDENTITY.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "SELF.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "TRUST.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "feed.md")).exists()).toBeTrue();
    expect(await Bun.file(join(context.hiveHome, "personas", "steward.md")).exists()).toBeTrue();
    expect((await readdir(join(context.hiveHome, "approvals"))).sort()).toEqual(["pending", "resolved"]);
    expect((await readdir(join(context.hiveHome, "events"))).sort()).toEqual(["external", "internal"]);
    expect((await readdir(join(context.hiveHome, "memory"))).sort()).toEqual([
      "decisions.md",
      "entities",
      "journal",
      "knowledge.md",
      "personas",
      "projects",
      "state",
    ]);
    expect(await Bun.file(join(context.hiveHome, "active-project.txt")).exists()).toBeFalse();
  });

  test("project add registers the repo and activates the project", async () => {
    await initHive();

    const output = await addProject();
    const feed = await Bun.file(join(context.hiveHome, "feed.md")).text();

    expect(output).toContain("Registered project myproject");
    expect((await Bun.file(join(context.hiveHome, "active-project.txt")).text()).trim()).toBe(
      "myproject",
    );
    expect(await Bun.file(join(context.hiveHome, "projects", "myproject", "PLAN.md")).exists()).toBeTrue();
    expect(feed).toContain("Registered project myproject");
    expect(feed).toContain(`repo: ${context.repo}`);
  });

  test("feed shows recent high-signal events", async () => {
    await initHive();
    await addProject();
    await runCli(["nudge", "Auth", "takes", "priority"]);

    const feed = await runCli(["feed", "2"]);

    expect(feed).toContain("# HIVE Feed");
    expect(feed).toContain("Registered project myproject");
    expect(feed).toContain("Human nudge");
    expect(feed).toContain("Auth takes priority");
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
      join(context.hiveHome, "projects", "myproject", "LOG.md"),
    ).text();

    expect(status).toContain("Runtime");
    expect(status).toContain("gateway: not running");
    expect(status).toContain("persistent steward: offline");
    expect(status).toContain("Project: myproject");
    expect(status).toContain("BOARD.md");
    expect(status).toContain("Need the auth contract");
    expect(log).toContain("Session kickoff");
  });

  test("status still reports runtime state when no active project is selected", async () => {
    await initHive();

    const status = await runCli(["status"]);

    expect(status).toContain("Runtime");
    expect(status).toContain("active project: none");
    expect(status).toContain("gateway: not running");
    expect(status).toContain("Project: none");
  });

  test("console dry run prompt encodes routing guidance", async () => {
    await initHive();
    await addProject();

    const output = await runCli(["console", "--dry-run"]);
    const promptPath = output.match(/^Prompt:\s+(.+)$/m)?.[1]?.trim();

    expect(output).toContain("Console dry run");
    expect(promptPath).toBeString();

    const prompt = await Bun.file(promptPath!).text();
    expect(prompt).toContain("Answer directly when you can");
    expect(prompt).toContain("cognitive-resource-routing.md");
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
    expect(inboxBefore).toContain("Open messages: 1");
    expect(inboxBefore).toContain(filename!);
    expect(inboxBefore).toContain("./hive msg resolve <message> <actor> <answer>");
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
    expect(inboxAfter).toContain("Open messages: 0");
    expect(inboxAfter).toContain("No open messages. Queue is clean.");
    expect(statusAfter).not.toContain(filename!);
    expect(statusAfter).not.toContain("Need the auth contract");

    const secondCreateOutput = await runCli([
      "msg",
      "--type",
      "notify",
      "steward",
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
    expect(finalInbox).toContain("Open messages: 0");
    expect(finalInbox).toContain("No open messages. Queue is clean.");
  });

  test("msg command can write machine-readable assignment frontmatter", async () => {
    await initHive();
    await addProject();

    const createOutput = await runCli([
      "msg",
      "--type",
      "assign",
      "--task",
      "HIVE-321",
      "--scope",
      "src/gateway src/lib/steward",
      "--launch",
      "auto",
      "steward",
      "alpha",
      "Audit the live gateway delegation path.",
    ]);
    const filename = createOutput.match(/([^\s]+\.md)$/)?.[1];
    const raw = await runCli(["msg", "show", filename!]);

    expect(filename).toBeString();
    expect(raw).toContain("type: assign");
    expect(raw).toContain("task: HIVE-321");
    expect(raw).toContain("scope: src/gateway src/lib/steward");
    expect(raw).toContain("launch: auto");
    expect(raw).toContain("Audit the live gateway delegation path.");
  });

  test("prompt assembles persona, plan assignment, and agent messages", async () => {
    await initHive();
    await addProject();
    const hivePaths = await ensureHiveScaffold(context.hiveHome);
    const projectPaths = getProjectPaths(hivePaths, "myproject");

    await Bun.write(
      join(context.hiveHome, "projects", "myproject", "PLAN.md"),
      `# Plan: MyProject

## Goal
Ship the login flow.

## Agents
### steward (steward)
Task: Run the board.

### alpha (craftsman -> src/api/**)
Task: Build the auth endpoint and publish the contract.

## Rules
- Keep the board current via messages.
`,
    );

    let run = await createRunDraft({
      projectId: "myproject",
      projectPaths,
      agentId: "beta",
      runtime: "codex",
      model: null,
      prompt: "Ship the auth contract.",
      source: "test",
      taskId: "HIVE-201",
      scope: ["src/api"],
    });
    run = await finalizeRun({
      projectPaths,
      run,
      status: "exited",
      exitCode: 0,
    });
    await writeRunResult(run, {
      changedFiles: ["src/api/auth.ts"],
      gitSummaryLines: ["M src/api/auth.ts"],
      finalVisibleOutput: "Published the auth contract for the login flow.",
      cognitiveDigest: {
        provider: "ollama",
        model: "qwen3:4b",
        summary: "Published the auth contract for the login flow.",
        outcome: "success",
        keyDecisions: ["Kept the contract boundary in src/api/auth.ts."],
        filesChanged: ["src/api/auth.ts"],
        inputTokens: 88,
        outputTokens: 21,
        totalTokens: 109,
        durationMs: 900,
      },
    });

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
    const workerBriefPath = join(
      context.hiveHome,
      "projects",
      "myproject",
      "state",
      "packets",
      "worker-brief",
      "alpha.json",
    );
    const workerBrief = await Bun.file(workerBriefPath).json() as {
      relevantRunResults: Array<{ summary: string }>;
    };

    expect(prompt).toContain("You are alpha for project myproject.");
    expect(prompt).toContain("# HIVE Soul");
    expect(prompt).toContain(`Read agent identity: ${join(context.hiveHome, "IDENTITY.md")}`);
    expect(prompt).toContain("persona: craftsman");
    expect(prompt).toContain("The authoritative hive files are not in the repo root.");
    expect(prompt).toContain("## Files");
    expect(prompt).toContain(`IDENTITY.md: ${join(context.hiveHome, "IDENTITY.md")}`);
    expect(prompt).toContain(`BOARD.md: ${join(context.hiveHome, "projects", "myproject", "BOARD.md")}`);
    expect(prompt).toContain(`LOG.md: ${join(context.hiveHome, "projects", "myproject", "LOG.md")}`);
    expect(prompt).toContain(`worker-brief-json: ${workerBriefPath}`);
    expect(prompt).toContain("hive inbox alpha");
    expect(prompt).toContain("./hive inbox alpha");
    expect(prompt).toContain("hive msg resolve <message> alpha <answer>");
    expect(prompt).toContain("./hive msg resolve <message> alpha <answer>");
    expect(prompt).toContain("hive msg close <message> alpha [note]");
    expect(prompt).toContain("./hive msg close <message> alpha [note]");
    expect(prompt).toContain("## Worker Brief");
    expect(prompt).toContain("Task: Build the auth endpoint and publish the contract.");
    expect(prompt).toContain("Need the login contract shape");
    expect(prompt).toContain("Published the auth contract for the login flow.");
    expect(workerBrief.relevantRunResults[0]?.summary).toContain(
      "Published the auth contract for the login flow.",
    );
  });

  test("ad-hoc assignment agents can render prompts and dry-run launches from assignment frontmatter", async () => {
    await initHive();
    await addProject();

    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
runtime: claude
model: claude-sonnet-4-6
`,
    );
    await Bun.write(
      join(context.hiveHome, "msg", "20260309-150700Z-steward-to-eval-codex-HIVE-777.md"),
      `---
from: steward
to: eval-codex
type: assign
status: open
project: myproject
task: HIVE-777
runtime: codex
model: gpt-5-codex
launch: auto
scope: src/gateway,tests
ts: 2026-03-09T15:07:00Z
---

You are a critic evaluating the gateway implementation.

Review the current change set and produce a blunt technical assessment.
`,
    );

    const prompt = await runCli(["prompt", "eval-codex"]);
    const launchDryRun = await runCli(["launch", "--dry-run", "eval-codex"]);
    const promptArtifactPath = join(
      context.hiveHome,
      "projects",
      "myproject",
      "runs",
      "2026",
      "03",
      "20260309-150800Z-eval-codex",
      "prompt.md",
    );
    const promptArtifact = await Bun.file(promptArtifactPath).text();

    expect(prompt).toContain("You are eval-codex for project myproject.");
    expect(prompt).toContain("persona: critic");
    expect(prompt).toContain("descriptor: critic, gpt-5-codex via codex");
    expect(prompt).toContain("You are a critic evaluating the gateway implementation.");
    expect(launchDryRun).toContain("Agent: eval-codex");
    expect(launchDryRun).toContain("Runtime: codex");
    expect(launchDryRun).toContain("Model: gpt-5-codex");
    expect(launchDryRun).toContain("Command: codex exec");
    expect(promptArtifact).toContain("persona: critic");
    expect(promptArtifact).toContain("You are a critic evaluating the gateway implementation.");
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
      join(context.hiveHome, "projects", "myproject", "LOG.md"),
    ).text();

    expect(archiveOutput).toContain(join(context.hiveHome, "archive", "2026", "03"));
    expect(archivedEntries.some((entry) => entry.endsWith("-myproject.md"))).toBeTrue();
    expect(refreshedLog).toContain("# Log: 2026-03-09 myproject");
    expect(refreshedLog).not.toContain("Captured session context");
  });

  test("launch dry run resolves runtime settings and writes prompt artifacts", async () => {
    await initHive();
    await addProject();

    await Bun.write(
      join(context.hiveHome, "config.md"),
      `# Hive Config

## Hive Mind
model: gpt-5.4-medium
runtime: codex

## Defaults
steward: steward
message-check-seconds: 30
archive-curation: deferred
`,
    );

    await Bun.write(
      join(context.hiveHome, "projects", "myproject", "config.md"),
      `# Project: MyProject

## Repo
path: ${context.repo}

## Stack
- Bun + TypeScript

## Default Team
- steward: steward, gpt-5.4-medium via codex
- alpha: craftsman, gpt-5.4-medium via codex
- beta: craftsman
- gamma: critic

## Rules
- Keep the board current via messages.
`,
    );

    const launchDryRun = await runCli(["launch", "--dry-run", "alpha"]);

    expect(launchDryRun).toContain("Launch dry run");
    expect(launchDryRun).toContain("Agent: alpha");
    expect(launchDryRun).toContain("Runtime: codex");
    expect(launchDryRun).toContain("Command: codex exec");

    expect(
      await Bun.file(
        join(
          context.hiveHome,
          "projects",
          "myproject",
          "runs",
          "2026",
          "03",
          "20260309-150800Z-alpha",
          "prompt.md",
        ),
      ).exists(),
    ).toBeTrue();
    expect(
      await Bun.file(
        join(
          context.hiveHome,
          "projects",
          "myproject",
          "runs",
          "2026",
          "03",
          "20260309-150800Z-alpha",
          "run.md",
        ),
      ).exists(),
    ).toBeFalse();
  });

  test("runtimes shows direct auth and Pi routing policy from config", async () => {
    await initHive();
    await Bun.write(
      join(context.hiveHome, "config.md"),
      [
        "# Hive Config",
        "",
        "runtime: claude",
        "model: claude-sonnet-4-6",
        "direct-auth-codex: cli",
        "pi-provider-claude: anthropic",
        "pi-model-claude: claude-sonnet-4-6",
        "pi-auth-anthropic: oauth-only",
      ].join("\n"),
    );

    const output = await runCli(["runtimes"]);

    expect(output).toContain("Available runtimes:");
    expect(output).toContain("direct auth: subscription");
    expect(output).toContain("pi route: config -> anthropic | model: claude-sonnet-4-6 | auth: oauth-only");
    expect(output).toContain("pi route: not configured by default -> direct runtime fallback");
    expect(output).toContain(`config: ${join(context.hiveHome, "config.md")}`);
  });

  test("cognition shows inspectable routing policy and lane map", async () => {
    await initHive();
    process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "1";
    await Bun.write(
      join(context.hiveHome, "config.md"),
      [
        "# Hive Config",
        "",
        "runtime: claude",
        "model: claude-sonnet-4-6",
        "cognitive-bias: quality",
        "cognitive-max-fanout: 4",
        "cognitive-max-parallel: 3",
        "tier1_local: qwen3:4b",
        "pi-provider-codex: openai",
        "pi-model-codex: gpt-5",
        "pi-auth-openai: env",
      ].join("\n"),
    );
    const session = await createSession({
      sessionsDir: join(context.hiveHome, "sessions"),
      project: "default",
      runtime: "codex",
      model: "gpt-5-codex",
      systemPrompt: "You are the steward.",
    });
    globalThis.fetch = (async (input) => {
      const url = String(input);

      if (url === "http://127.0.0.1:11434/api/tags") {
        return new Response(
          JSON.stringify({
            models: [{ name: "qwen3:4b" }, { name: "gemma3:4b" }],
          }),
          { status: 200 },
        );
      }

      return originalFetch(input);
    }) as typeof fetch;

    const output = await runCli(["cognition"]);

    expect(output).toContain("Cognitive routing policy:");
    expect(output).toContain("bias: quality");
    expect(output).toContain("max fan-out: 4");
    expect(output).toContain("max parallel workers: 3");
    expect(output).toContain(`active session: ${session.sessionId}`);
    expect(output).toContain("session selection: codex (gpt-5-codex)");
    expect(output).toContain("current execution: persistent steward via Pi | codex -> openai | model: gpt-5 | auth: env");
    expect(output).toContain("local model: qwen3:4b");
    expect(output).toContain("configured local status: available");
    expect(output).toContain("discovered local models: gemma3:4b, qwen3:4b");
    expect(output).toContain("pi route: Pi implicit -> anthropic | auth: oauth-only");
    expect(output).toContain("pi route: Pi config -> openai | model: gpt-5 | auth: env");
    expect(output).toContain(`Skill: ${join(context.hiveHome, "skills", "cognitive-resource-routing.md")}`);
    expect(output).toContain(`Config: ${join(context.hiveHome, "config.md")}`);
  });
});
