import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { handleApi } from "../src/gateway/routes";
import { startGateway, stopGateway } from "../src/gateway/server";
import { createApprovalRequest } from "../src/lib/approvals";
import { compileIdleProjectCognition } from "../src/lib/cognition";
import { writeDetachedSupervisorState } from "../src/lib/detached-supervisor";
import { appendEvent } from "../src/lib/events";
import { createMessage, listProjectMessages } from "../src/lib/messages";
import { ensureHiveScaffold, getProjectPaths, type HivePaths } from "../src/lib/paths";
import {
  disposePersistentStewardsForHome,
  runPersistentStewardTurn,
} from "../src/lib/persistent-steward";
import {
  createRunDraft,
  finalizeRun,
  getRunOutputPath,
  listActiveRuns,
  listAllRuns,
  listRecentRunResults,
  markRunActive,
  readActiveRun,
  readRunRecord,
  writeRunResult,
} from "../src/lib/runs";
import {
  createSession,
  getSession,
  getSessionHistory,
  getSessionState,
  updateSessionMeta,
} from "../src/lib/sessions";
import { refreshProjectRuntimeState } from "../src/lib/state";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
  paths: HivePaths;
};

let context: TestContext;
let originalPath = process.env.PATH;
let originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
let originalAnthropicOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
let originalFetch = globalThis.fetch;

function randomPort(): number {
  return 12000 + Math.floor(Math.random() * 30000);
}

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-gw-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-11T14:00:00Z";

  const paths = await ensureHiveScaffold(hiveHome);

  return { root, repo, hiveHome, paths };
}

beforeEach(async () => {
  context = await setupContext();
  originalPath = process.env.PATH;
  originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  originalAnthropicOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  originalFetch = globalThis.fetch;
  process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "0";
});

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  delete process.env.HIVE_PI_IDLE_MS;
  delete process.env.HIVE_ENABLE_PERSISTENT_STEWARD;
  delete process.env.HIVE_TEST_PI_BEHAVIOR;
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  }
  if (originalAnthropicOAuthToken === undefined) {
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
  } else {
    process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOAuthToken;
  }
  globalThis.fetch = originalFetch;
  await disposePersistentStewardsForHome(context.paths.home);
  await rm(context.root, { recursive: true, force: true });
});

async function installMockPi(root: string): Promise<void> {
  process.env.HIVE_TEST_PI_BEHAVIOR ||= "reply";

  const binDir = join(root, "bin");
  const scriptPath = join(binDir, "pi");

  await mkdir(binDir, { recursive: true });
  await Bun.write(
    scriptPath,
    `#!/usr/bin/env node
const readline = require("node:readline");

const args = process.argv.slice(2);
const providerIndex = args.indexOf("--provider");
const modelIndex = args.indexOf("--model");
const provider = providerIndex >= 0 ? args[providerIndex + 1] : "anthropic";
const model = modelIndex >= 0 ? args[modelIndex + 1] : "mock-steward";
const behavior = process.env.HIVE_TEST_PI_BEHAVIOR || "reply";
const anthropicAuth = process.env.ANTHROPIC_OAUTH_TOKEN
  ? (process.env.ANTHROPIC_API_KEY ? "both" : "oauth")
  : (process.env.ANTHROPIC_API_KEY ? "api" : "none");
let isStreaming = false;
let pendingMessageCount = 0;
let assistantMessages = 0;
let userMessages = 0;
let totalInput = 0;
let totalOutput = 0;
let totalCost = 0;
let lastAssistantText = "";
let activeTimers = [];
let idleTimer = null;

function scheduleIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), 800);
}

function clearActiveTimers() {
  for (const timer of activeTimers) clearTimeout(timer);
  activeTimers = [];
}

function out(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

function success(id, command, data) {
  out(data === undefined
    ? { id, type: "response", command, success: true }
    : { id, type: "response", command, success: true, data });
}

function state() {
  return {
    model: { provider, id: model },
    isStreaming,
    pendingMessageCount,
    messageCount: assistantMessages + userMessages,
    sessionFile: null,
    sessionId: "mock-pi-session",
  };
}

function stats() {
  return {
    sessionId: "mock-pi-session",
    assistantMessages,
    userMessages,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: 0,
      cacheWrite: 0,
      total: totalInput + totalOutput,
    },
    cost: totalCost,
  };
}

function emitAssistantReply(reply) {
  clearActiveTimers();
  isStreaming = true;
  pendingMessageCount = 1;
  const halfway = Math.max(1, Math.floor(reply.length / 2));
  const partial = reply.slice(0, halfway);
  const baseDelay = behavior === "slow" ? 900 : 0;

  activeTimers.push(setTimeout(() => {
    out({ type: "agent_start" });
    out({ type: "turn_start" });
  }, baseDelay + 10));

  activeTimers.push(setTimeout(() => {
    out({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: partial }],
      },
    });
  }, baseDelay + 20));

  activeTimers.push(setTimeout(() => {
    out({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
      },
    });
  }, baseDelay + 40));

  activeTimers.push(setTimeout(() => {
    assistantMessages += 1;
    totalInput += 21;
    totalOutput += 13;
    totalCost += 0.02;
    lastAssistantText = reply;
    isStreaming = false;
    pendingMessageCount = 0;
    out({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
        usage: {
          input: 21,
          output: 13,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.02 },
        },
      },
    });
    out({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
      },
      toolResults: [],
    });
    out({
      type: "agent_end",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: reply }],
      }],
    });
    scheduleIdleExit();
  }, baseDelay + 70));
}

function emitAssistantFailure(errorMessage) {
  clearActiveTimers();
  isStreaming = true;
  pendingMessageCount = 1;

  activeTimers.push(setTimeout(() => {
    out({ type: "agent_start" });
    out({ type: "turn_start" });
    out({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        provider,
        model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { total: 0 },
        },
        stopReason: "stop",
      },
    });
  }, 10));

  activeTimers.push(setTimeout(() => {
    isStreaming = false;
    pendingMessageCount = 0;
    const failedMessage = {
      role: "assistant",
      content: [],
      provider,
      model,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { total: 0 },
      },
      stopReason: "error",
      errorMessage,
    };

    out({ type: "message_end", message: failedMessage });
    out({ type: "turn_end", message: failedMessage, toolResults: [] });
    out({ type: "agent_end", messages: [failedMessage] });
  }, 40));

  activeTimers.push(setTimeout(() => {
    out({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 1,
      delayMs: 10,
      errorMessage,
    });
  }, 180));

  activeTimers.push(setTimeout(() => {
    out({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: errorMessage,
    });
    scheduleIdleExit();
  }, 220));
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

scheduleIdleExit();

rl.on("line", (line) => {
  scheduleIdleExit();
  const command = JSON.parse(line);

  switch (command.type) {
    case "get_state":
      success(command.id, "get_state", state());
      return;
    case "get_session_stats":
      success(command.id, "get_session_stats", stats());
      return;
    case "get_last_assistant_text":
      success(command.id, "get_last_assistant_text", { text: lastAssistantText });
      return;
    case "abort":
      clearActiveTimers();
      isStreaming = false;
      pendingMessageCount = 0;
      success(command.id, "abort");
      return;
    case "prompt": {
      userMessages += 1;
      success(command.id, "prompt");
      if (behavior === "error") {
        emitAssistantFailure("Connection error.");
        return;
      }
      const humanTurnMatch = /## Human Turn\\n([\\s\\S]*)$/m.exec(command.message || "");
      const humanTurn = humanTurnMatch ? humanTurnMatch[1].trim() : "mock task";
      const replyPrefix = behavior === "auth"
        ? "Mock persistent steward auth: " + anthropicAuth + " | "
        : "Mock persistent steward reply: ";
      emitAssistantReply(replyPrefix + humanTurn);
      return;
    }
    default:
      out({
        id: command.id,
        type: "response",
        command: command.type,
        success: false,
        error: "Unknown command: " + command.type,
      });
  }
});
`,
  );
  await chmod(scriptPath, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.HIVE_PI_IDLE_MS = "200";
}

describe("Gateway HTTP Server", () => {
  test("serves static index.html at /", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html");

      const body = await res.text();
      expect(body).toContain("HIVE");
      expect(body).toContain("console-history");
    } finally {
      stopGateway(state);
    }
  });

  test("returns 404 for unknown static files", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/nonexistent.html`);
      expect(res.status).toBe(404);
    } finally {
      stopGateway(state);
    }
  });

  test("CORS headers on all API responses", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/projects`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      stopGateway(state);
    }
  });

  test("CORS preflight OPTIONS request", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/status`, {
        method: "OPTIONS",
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    } finally {
      stopGateway(state);
    }
  });
});

describe("Gateway REST API", () => {
  test("GET /api/projects returns project list", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/projects`);
      expect(res.status).toBe(200);

      const data = await res.json() as { projects: string[] };
      expect(data).toHaveProperty("projects");
      expect(Array.isArray(data.projects)).toBe(true);
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/runtimes returns supported runtimes", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/runtimes`);
      expect(res.status).toBe(200);

      const data = await res.json() as { result: string };
      expect(data.result).toContain("claude");
      expect(data.result).toContain("codex");
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/cognition returns session-aware routing policy and local model discovery", async () => {
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
      ].join("\n"),
    );
    const session = await createSession({
      sessionsDir: context.paths.sessionsDir,
      project: "hive",
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
    const req = new Request("http://localhost/api/cognition");
    const res = await handleApi(req, new URL(req.url), {
      hivePaths: context.paths,
      projectsDir: context.paths.projectsDir,
      runsActiveDir: "",
    }, () => {});

    expect(res.status).toBe(200);

    const data = await res.json() as {
      rendered: string;
      policy: {
        bias: string;
        maxFanOut: number;
        maxParallel: number;
        runtimeLanes: Array<{
          runtime: string;
          piRoute: {
            provider: string | null;
            model: string | null;
          };
        }>;
      };
      activeSession: {
        sessionId: string;
        project: string;
        runtime: string;
        model: string | null;
      } | null;
      activeLane: {
        runtime: string;
      } | null;
      activeExecution: {
        mode: string;
        runtime: string;
        selectedModel: string | null;
        executedModel: string | null;
      } | null;
      defaultExecution: {
        mode: string;
        runtime: string;
        selectedModel: string | null;
        executedModel: string | null;
      } | null;
      tier1: {
        localModel: string;
      };
      localModels: {
        available: boolean;
        configuredModelStatus: string;
        models: Array<{ name: string }>;
      };
      usage: {
        project: string;
        summary: {
          stewardWakes: number;
          workerRuns: number;
          tier1Calls: number;
        };
      } | null;
    };
    expect(data.rendered).toContain("Cognitive routing policy:");
    expect(data.policy.bias).toBe("quality");
    expect(data.policy.maxFanOut).toBe(4);
    expect(data.policy.maxParallel).toBe(3);
    expect(data.rendered).toContain(`active session: ${session.sessionId}`);
    expect(data.rendered).toContain("session selection: codex (gpt-5-codex)");
    expect(data.rendered).toContain("current execution: direct runtime | codex (gpt-5-codex) | auth: cli");
    expect(data.activeSession?.runtime).toBe("codex");
    expect(data.activeLane?.runtime).toBe("codex");
    expect(data.activeExecution?.mode).toBe("direct-runtime");
    expect(data.activeExecution?.executedModel).toBe("gpt-5-codex");
    expect(data.defaultExecution?.mode).toBe("direct-runtime");
    expect(data.tier1.localModel).toBe("qwen3:4b");
    expect(data.localModels.available).toBeTrue();
    expect(data.localModels.configuredModelStatus).toBe("available");
    expect(data.usage?.project).toBe("hive");
    expect(data.usage?.summary.stewardWakes).toBe(0);
    expect(data.usage?.summary.workerRuns).toBe(0);
    expect(data.usage?.summary.tier1Calls).toBe(0);
    expect(data.localModels.models.map((model) => model.name)).toEqual([
      "gemma3:4b",
      "qwen3:4b",
    ]);
    expect(data.policy.runtimeLanes.some((lane) =>
      lane.runtime === "codex" &&
      lane.piRoute.provider === "openai" &&
      lane.piRoute.model === "gpt-5",
    )).toBeTrue();
  });

  test("GET /api/cognition surfaces Pi execution for persistent steward sessions", async () => {
    process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "1";
    await Bun.write(
      join(context.hiveHome, "config.md"),
      [
        "# Hive Config",
        "",
        "runtime: codex",
        "model: gpt-5-codex",
        "pi-provider-codex: openai",
        "pi-model-codex: gpt-5",
      ].join("\n"),
    );
    await createSession({
      sessionsDir: context.paths.sessionsDir,
      project: "hive",
      runtime: "codex",
      model: "gpt-5-codex",
      systemPrompt: "You are the steward.",
    });
    const req = new Request("http://localhost/api/cognition");
    const res = await handleApi(req, new URL(req.url), {
      hivePaths: context.paths,
      projectsDir: context.paths.projectsDir,
      runsActiveDir: "",
    }, () => {});

    expect(res.status).toBe(200);

    const data = await res.json() as {
      rendered: string;
      activeExecution: {
        mode: string;
        executedModel: string | null;
      } | null;
    };

    expect(data.activeExecution?.mode).toBe("persistent-pi");
    expect(data.activeExecution?.executedModel).toBe("gpt-5");
    expect(data.rendered).toContain("current execution: persistent steward via Pi | codex -> openai | model: gpt-5 | auth: env");
  });

  test("GET /api/cognition returns project-focused compiled working set and idle packets", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const projectPaths = getProjectPaths(context.paths, "testproj");
    await Bun.write(
      projectPaths.board,
      `# Board: TestProj

## Tasks
- HIVE-100 | ship auth flow | done
- HIVE-101 | wire gateway cognition rail | active

## Agents
- steward | status: active on HIVE-101 | role: steward
- alpha | status: idle | role: worker

## Blockers
- Need sign-off on gateway messaging copy
`,
    );
    await Bun.write(
      projectPaths.log,
      `# Log: 2026-03-11 TestProj

## 2026-03-11T14:00:00Z — steward
Captured gateway cognition snapshot and prepared the compiled-state rail.
`,
    );
    await Bun.write(
      projectPaths.memory,
      `# Project Memory: TestProj

## Durable Facts
- The gateway UI lives in src/gateway/static/app.js

## Conventions
- Prefer exposing compiled summaries before raw derived files in UI surfaces

## Decisions
- [2026-03-11T14:00:00Z] Keep cognition routing and compiled-state inspection in one rail

## Open Questions
- Should idle packet freshness be shown directly in the rail?
`,
    );

    const message = await createMessage(context.paths.msgDir, {
      from: "human",
      to: "steward",
      type: "question",
      project: "testproj",
      body: "Show me the new compiled cognition state in the gateway.",
    });

    let run = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "Wire the compiled cognition rail.",
      source: "gateway-test",
      sourceMessage: message.filename,
      taskId: "HIVE-101",
      scope: ["src/gateway"],
    });
    run = await finalizeRun({
      projectPaths,
      run,
      status: "exited",
      exitCode: 0,
    });
    await writeRunResult(run, {
      assignmentStatusAfterExit: "open",
      assignmentResolvedByWorker: false,
      changedFiles: ["docs/gateway-cognition.md", "tests/gateway.test.ts"],
      gitSummaryLines: ["Wired the gateway cognition rail to compiled working-set state."],
      finalVisibleOutput: "Compiled cognition rail wired.",
      cognitiveDigest: {
        provider: "ollama",
        model: "qwen3:4b",
        summary: "Gateway cognition rail now shows compiled working-set and idle packet state.",
        outcome: "success",
        keyDecisions: ["Use /api/cognition as the single project-aware rail payload."],
        filesChanged: ["docs/gateway-cognition.md", "tests/gateway.test.ts"],
        inputTokens: 96,
        outputTokens: 33,
        totalTokens: 129,
        durationMs: 1200,
      },
    });

    const runtimeState = await refreshProjectRuntimeState({
      hivePaths: context.paths,
      projectId: "testproj",
      projectPaths,
    });
    const plan = await Bun.file(projectPaths.plan).text();
    await compileIdleProjectCognition({
      hivePaths: context.paths,
      projectId: "testproj",
      projectPaths,
      plan,
      runtimeState,
    });

    const req = new Request("http://localhost/api/cognition?project=testproj");
    const res = await handleApi(req, new URL(req.url), {
      hivePaths: context.paths,
      projectsDir: context.paths.projectsDir,
      runsActiveDir: "",
    }, () => {});

    expect(res.status).toBe(200);

    const data = await res.json() as {
      project: string | null;
      usage: {
        project: string;
      } | null;
      compiled: {
        workingSetDigests: Array<{
          label: string;
          body: string;
        }>;
        idlePackets: Array<{
          label: string;
          body: string;
          kicker: string | null;
        }>;
      } | null;
    };

    expect(data.project).toBe("testproj");
    expect(data.usage?.project).toBe("testproj");
    expect(data.compiled).not.toBeNull();

    const boardDigest = data.compiled?.workingSetDigests.find((item) => item.label === "board");
    const openDecisionsDigest = data.compiled?.workingSetDigests.find((item) => item.label === "open decisions");
    const recentResultsDigest = data.compiled?.workingSetDigests.find((item) => item.label === "recent results");
    const humanInboxDigest = data.compiled?.workingSetDigests.find((item) => item.label === "human inbox");

    expect(boardDigest?.body).toContain("2 task");
    expect(openDecisionsDigest?.body).toContain("gateway messaging copy");
    expect(recentResultsDigest?.body).toContain("Gateway cognition rail now shows compiled working-set and idle packet state.");
    expect(humanInboxDigest?.body).toContain("Show me the new compiled cognition state in the gateway.");

    const idleLabels = (data.compiled?.idlePackets ?? []).map((packet) => packet.label);
    expect(idleLabels).toEqual([
      "log rollup",
      "phase summary",
      "memory hotset",
      "stale memory",
    ]);

    expect(data.compiled?.idlePackets.find((packet) => packet.label === "log rollup")?.body).toContain(
      "Captured gateway cognition snapshot",
    );
    expect(data.compiled?.idlePackets.find((packet) => packet.label === "phase summary")?.body).toContain(
      "ship auth flow",
    );
    expect(data.compiled?.idlePackets.find((packet) => packet.label === "memory hotset")?.body).toContain(
      "The gateway UI lives in src/gateway/static/app.js",
    );
    expect(data.compiled?.idlePackets.find((packet) => packet.label === "stale memory")?.body).toContain(
      "Stale memory review",
    );
  });

  test("GET /api/feed returns feed data", async () => {
    const req = new Request("http://localhost/api/feed?count=5");
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as { result: string; entries: unknown[] };
    expect(data).toHaveProperty("result");
    expect(data).toHaveProperty("entries");
    expect(typeof data.result).toBe("string");
    expect(Array.isArray(data.entries)).toBe(true);
  });

  test("GET /api/status with active project returns status", async () => {
    const port = randomPort();
    // Set up a project first
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/status`);
      expect(res.status).toBe(200);

      const data = await res.json() as { result: string };
      expect(data).toHaveProperty("result");
      expect(data.result).toContain("testproj");
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/ps with active project returns run info", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/ps`);
      expect(res.status).toBe(200);

      const data = await res.json() as { result: string };
      expect(data).toHaveProperty("result");
      expect(data.result).toContain("testproj");
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/inbox returns inbox messages", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/inbox`);
      expect(res.status).toBe(200);

      const data = await res.json() as { result: string };
      expect(data).toHaveProperty("result");
      expect(data.result).toContain("testproj");
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/inbox/:agent filters by agent", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/inbox/alpha`);
      expect(res.status).toBe(200);

      const data = await res.json() as { result: string };
      expect(data).toHaveProperty("result");
      expect(data.result).toContain("alpha");
    } finally {
      stopGateway(state);
    }
  });

  test("POST /api/log appends log entry", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test log entry" }),
      });
      expect(res.status).toBe(200);

      const data = await res.json() as { result: string };
      expect(data.result).toContain("Appended log entry");
    } finally {
      stopGateway(state);
    }
  });

  test("POST /api/msg creates a message", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/msg`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "alpha",
          to: "beta",
          body: "hello from the gateway",
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json() as { result: string };
      expect(data.result).toContain("Created");
      expect(data.result).toContain("message");
    } finally {
      stopGateway(state);
    }
  });
});

describe("Gateway error handling", () => {
  test("unknown API endpoint returns 404", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/nonexistent`);
      expect(res.status).toBe(404);

      const data = await res.json() as { error: string };
      expect(data).toHaveProperty("error");
    } finally {
      stopGateway(state);
    }
  });

  test("POST with invalid JSON returns 400", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      });
      expect(res.status).toBe(400);

      const data = await res.json() as { error: string };
      expect(data.error).toContain("Invalid JSON");
    } finally {
      stopGateway(state);
    }
  });

  test("POST with missing required field returns 400", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      const data = await res.json() as { error: string };
      expect(data.error).toContain("Missing");
    } finally {
      stopGateway(state);
    }
  });

  test("POST /api/say with missing message returns 400", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/say`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      const data = await res.json() as { error: string };
      expect(data.error).toContain("Missing");
    } finally {
      stopGateway(state);
    }
  });

  test("POST /api/msg with missing fields returns 400", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/msg`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "alpha" }),
      });
      expect(res.status).toBe(400);

      const data = await res.json() as { error: string };
      expect(data.error).toContain("Missing required fields");
    } finally {
      stopGateway(state);
    }
  });

  test("POST /api/nudge with missing message returns 400", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/nudge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      const data = await res.json() as { error: string };
      expect(data.error).toContain("Missing");
    } finally {
      stopGateway(state);
    }
  });
});

describe("Gateway state file", () => {
  test("gateway status reports not running when no state file", async () => {
    const result = await runCli(["gateway", "status"]);
    expect(result).toContain("not running");
  });

  test("gateway stop reports not running when no state file", async () => {
    const result = await runCli(["gateway", "stop"]);
    expect(result).toContain("not running");
  });
});

describe("Gateway port conflict", () => {
  test("two gateways on the same port fails cleanly", async () => {
    const port = randomPort();
    const state1 = startGateway({ port, hivePaths: context.paths });

    try {
      expect(() => {
        startGateway({ port, hivePaths: context.paths });
      }).toThrow();
    } finally {
      stopGateway(state1);
    }
  });
});

describe("Gateway CLI wiring", () => {
  test("help includes gateway commands", async () => {
    const result = await runCli(["help"]);
    expect(result).toContain("hive gateway");
    expect(result).toContain("gateway status");
    expect(result).toContain("gateway stop");
  });
});

describe("Gateway session endpoints", () => {
  test("handleApi console new creates a steward session without a live server", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const projectPaths = getProjectPaths(context.paths, "testproj");
    await Bun.write(
      projectPaths.config,
      `# Project: TestProj

## Repo
path: ${context.repo}

## Default Team
- steward: steward, claude-sonnet-4-6 via claude
- alpha: craftsman via codex
`,
    );

    const req = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);

    const data = await res.json() as { sessionId: string; project: string };
    expect(data.sessionId).toBeTruthy();
    expect(data.project).toBe("testproj");

    const sessionDir = join(context.hiveHome, "sessions", data.sessionId);
    expect(await Bun.file(join(sessionDir, "state.json")).exists()).toBeTrue();
    const sessionMeta = await getSession(join(context.hiveHome, "sessions"), data.sessionId);
    expect(sessionMeta?.runtime).toBe("claude");
    expect(sessionMeta?.model).toBe("claude-sonnet-4-6");
    const sessionState = await Bun.file(join(sessionDir, "state.json")).json() as {
      currentProject: string;
    };
    expect(sessionState.currentProject).toBe("testproj");

    await Bun.sleep(150);

    const refreshedProjectPaths = getProjectPaths(context.paths, "testproj");
    const sessionContext = await Bun.file(refreshedProjectPaths.stateSessionContext).json() as {
      activeSession: { sessionId: string } | null;
    };
    expect(sessionContext.activeSession?.sessionId).toBe(data.sessionId);
  });

  test("handleApi console send responds immediately without persisting a synthetic ack turn", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Give the hive more personality." }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);

    const data = await res.json() as {
      accepted: boolean;
      sessionId: string;
      project: string;
    };
    expect(data.accepted).toBe(true);
    expect(data.sessionId).toBeTruthy();
    expect(data.project).toBe("testproj");

    const turns = await getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId);
    expect(turns.length).toBeGreaterThanOrEqual(1);
    expect(turns[0]?.role).toBe("human");
    expect(turns[0]?.content).toContain("Give the hive more personality.");
    expect(turns[0]?.source).toBe("human");
    expect(turns.some((turn) =>
      turn.role === "assistant" &&
      turn.source === "system" &&
      turn.content.includes("Heard. I'm on it.")
    )).toBe(false);

    await Bun.sleep(150);

    const projectPaths = getProjectPaths(context.paths, "testproj");
    const sessionContext = await Bun.file(projectPaths.stateSessionContext).json() as {
      activeSession: { sessionId: string } | null;
      recentTurns: Array<{ role: string; content: string }>;
    };

    expect(sessionContext.activeSession?.sessionId).toBe(data.sessionId);
    expect(
      sessionContext.recentTurns.some((turn) => turn.content.includes("Heard. I'm on it.")),
    ).toBe(false);
  });

  test("console send answers explicit status checks from deterministic state without waking the steward", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const projectPaths = getProjectPaths(context.paths, "testproj");
    let workerRun = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "Inspect the failing tests.",
      source: "gateway-test",
    });
    workerRun = await markRunActive(projectPaths, workerRun, 81234);
    await Bun.write(getRunOutputPath(workerRun), "checking failing specs\n");

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What's happening right now?" }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);

    const data = await res.json() as { accepted: boolean; sessionId: string };
    expect(data.accepted).toBe(true);

    await Bun.sleep(250);

    const [turns, activeConsoleRun] = await Promise.all([
      getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId),
      readActiveRun(projectPaths, "console"),
    ]);

    const statusTurn = turns.find((turn) =>
      turn.role === "assistant" &&
      turn.source === "system" &&
      turn.content.includes("Here's what the hive is doing right now:")
    );
    expect(statusTurn).toBeDefined();
    expect(statusTurn?.details?.runtime).toBe("deterministic");
    expect(statusTurn?.details?.routing?.tier).toBe("tier0");
    expect(statusTurn?.details?.routing?.handledBy).toBe("deterministic-status");
    expect(statusTurn?.details?.routing?.lane).toBe("deterministic gateway preprocessor");
    expect(activeConsoleRun).toBeNull();
  });

  test("console send uses tier-1 preprocessing for short status-like questions", async () => {
    await runCli(["init"]);
    await Bun.write(context.paths.config, "tier1_local: qwen3:4b\n");
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    globalThis.fetch = (async (input, init) => {
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
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        expect(body.messages[1]?.content).toContain("Should I be paying attention right now?");

        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                classification: "status_check",
                answer: "",
                reason: "This is asking whether current activity needs attention, which can be answered from live state.",
              }),
            },
            prompt_eval_count: 52,
            eval_count: 21,
            total_duration: 900_000_000,
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Should I be paying attention right now?" }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);

    const data = await res.json() as { accepted: boolean; sessionId: string };
    expect(data.accepted).toBe(true);

    await Bun.sleep(250);

    const turns = await getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId);
    const tier1Turn = turns.find((turn) =>
      turn.role === "assistant" &&
      turn.source === "system" &&
      turn.content.includes("Here's what the hive is doing right now:")
    );

    expect(tier1Turn).toBeDefined();
    expect(tier1Turn?.details?.runtime).toBe("ollama");
    expect(tier1Turn?.details?.model).toBe("qwen3:4b");
    expect(tier1Turn?.details?.routing?.tier).toBe("tier1");
    expect(tier1Turn?.details?.routing?.handledBy).toBe("tier1-preprocessor");
    expect(tier1Turn?.details?.routing?.lane).toBe("tier-1 local via Ollama | model: qwen3:4b");
  });

  test("console send uses the persistent Pi steward when Pi is available", async () => {
    await installMockPi(context.root);
    process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "1";
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Summarize the current state." }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);

    const data = await res.json() as { accepted: boolean; sessionId: string };
    expect(data.accepted).toBe(true);

    await Bun.sleep(900);

    const projectPaths = getProjectPaths(context.paths, "testproj");
    const [turns, activeRun, sessionState] = await Promise.all([
      getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId),
      readActiveRun(projectPaths, "console"),
      getSessionState(join(context.hiveHome, "sessions"), data.sessionId),
    ]);

    const modelTurn = turns.find((turn) =>
      turn.role === "assistant" &&
      turn.source === "model" &&
      turn.content.includes("Mock persistent steward reply:")
    );
    expect(modelTurn).toBeDefined();
    expect(modelTurn?.details?.runtime).toBe("pi");
    expect(modelTurn?.details?.routing?.tier).toBe("tier3");
    expect(modelTurn?.details?.routing?.handledBy).toBe("persistent-steward");
    expect(modelTurn?.details?.routing?.trace[0]).toContain("persistent steward lane");
    expect(activeRun).toBeNull();
    expect(sessionState?.projectStates.testproj?.lastRevisionSeen).toBeGreaterThan(0);
  });

  test("tier-1 preprocessing falls back to the steward when the question still needs depth", async () => {
    await installMockPi(context.root);
    process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "1";
    await runCli(["init"]);
    await Bun.write(context.paths.config, "tier1_local: qwen3:4b\n");
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    let preprocessCalls = 0;
    globalThis.fetch = (async (input) => {
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
        preprocessCalls += 1;
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                classification: "complex",
                answer: "",
                reason: "Choosing the next refactor needs judgment and planning.",
              }),
            },
            prompt_eval_count: 48,
            eval_count: 16,
            total_duration: 850_000_000,
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Should we tackle the gateway next?" }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);

    const data = await res.json() as { accepted: boolean; sessionId: string };
    expect(data.accepted).toBe(true);

    await Bun.sleep(900);

    const turns = await getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId);
    const modelTurn = turns.find((turn) =>
      turn.role === "assistant" &&
      turn.source === "model" &&
      turn.content.includes("Mock persistent steward reply:")
    );

    expect(preprocessCalls).toBe(1);
    expect(modelTurn).toBeDefined();
    expect(modelTurn?.details?.routing?.tier).toBe("tier3");
    expect(turns.some((turn) => turn.details?.routing?.tier === "tier1")).toBe(false);
  });

  test("persistent Pi prefers Anthropic OAuth over API key when both are present", async () => {
    await installMockPi(context.root);
    process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "1";
    process.env.HIVE_TEST_PI_BEHAVIOR = "auth";
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    process.env.ANTHROPIC_OAUTH_TOKEN = "test-oauth-token";
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Which Anthropic auth lane did you use?" }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);

    const data = await res.json() as { accepted: boolean; sessionId: string };
    expect(data.accepted).toBe(true);

    await Bun.sleep(900);

    const turns = await getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId);
    expect(turns.some((turn) =>
      turn.role === "assistant" &&
      turn.source === "model" &&
      turn.content.includes("Mock persistent steward auth: oauth |")
    )).toBe(true);
  });

  test("persistent Pi does not inherit Anthropic API keys from the shell env", async () => {
    await installMockPi(context.root);
    process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "1";
    process.env.HIVE_TEST_PI_BEHAVIOR = "auth";
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Which Anthropic auth lane did you use?" }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);

    const data = await res.json() as { accepted: boolean; sessionId: string };
    expect(data.accepted).toBe(true);

    await Bun.sleep(900);

    const turns = await getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId);
    expect(turns.some((turn) =>
      turn.role === "assistant" &&
      turn.source === "model" &&
      turn.content.includes("Mock persistent steward auth: none |")
    )).toBe(true);
  });

  test("persistent steward falls back when Pi ends with an error and no visible reply", async () => {
    await installMockPi(context.root);
    process.env.HIVE_TEST_PI_BEHAVIOR = "error";
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const createReq = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const createRes = await handleApi(
      createReq,
      new URL(createReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(createRes.status).toBe(200);

    const createData = await createRes.json() as { sessionId: string };
    const result = await runPersistentStewardTurn({
      hivePaths: context.paths,
      projectId: "testproj",
      sessionId: createData.sessionId,
      humanMessage: "Say hello.",
    });

    expect(result.mode).toBe("fallback");
    if (result.mode === "fallback") {
      expect(result.reason).toContain("Connection error.");
    }
  });

  test("persistent steward falls back for codex sessions when no Pi route is configured", async () => {
    await installMockPi(context.root);
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const createReq = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const createRes = await handleApi(
      createReq,
      new URL(createReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(createRes.status).toBe(200);

    const createData = await createRes.json() as { sessionId: string };
    await updateSessionMeta({
      sessionsDir: join(context.hiveHome, "sessions"),
      sessionId: createData.sessionId,
      runtime: "codex",
      model: null,
    });

    const result = await runPersistentStewardTurn({
      hivePaths: context.paths,
      projectId: "testproj",
      sessionId: createData.sessionId,
      humanMessage: "Say hello.",
    });

    expect(result.mode).toBe("fallback");
    if (result.mode === "fallback") {
      expect(result.reason).toContain("No Pi provider route is configured for runtime 'codex'");
    }
  });

  test("console send does not persist an empty Pi completion status when the persistent steward fails", async () => {
    await installMockPi(context.root);
    process.env.HIVE_TEST_PI_BEHAVIOR = "error";
    process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "1";
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Morning team." }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as { accepted: boolean; sessionId: string };
    expect(data.accepted).toBe(true);

    await Bun.sleep(900);

    const turns = await getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId);
    expect(turns.some((turn) =>
      turn.role === "assistant" &&
      turn.content.includes("The persistent steward turn finished without a visible reply.")
    )).toBe(false);
  });

  test("console send does not broadcast synthetic one-second filler while waiting for a live Pi reply", async () => {
    await installMockPi(context.root);
    process.env.HIVE_TEST_PI_BEHAVIOR = "slow";
    process.env.HIVE_ENABLE_PERSISTENT_STEWARD = "1";
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const events: Array<{ type?: string; data?: { content?: string } | null }> = [];
    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello there." }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      (event) => {
        events.push(event as { type?: string; data?: { content?: string } | null });
      },
    );
    expect(res.status).toBe(200);

    await Bun.sleep(800);

    expect(events.some((event) =>
      event.type === "session-stream" &&
      (event.data?.content || "").includes("One second")
    )).toBe(false);

    await Bun.sleep(500);

    expect(events.some((event) =>
      event.type === "session-stream" &&
      (event.data?.content || "").includes("Mock persistent steward reply:")
    )).toBe(true);
  });

  test("console send routes follow-up work to the session project, not the current active project", async () => {
    const otherRepo = join(context.root, "other-repo");
    await mkdir(otherRepo, { recursive: true });

    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["project", "add", "OtherProj", otherRepo]);
    await runCli(["work", "testproj"]);

    const newReq = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const newRes = await handleApi(
      newReq,
      new URL(newReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(newRes.status).toBe(200);

    await runCli(["work", "otherproj"]);

    const sendReq = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Stay focused on the original project." }),
    });
    const sendRes = await handleApi(
      sendReq,
      new URL(sendReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(sendRes.status).toBe(200);

    await Bun.sleep(150);

    const testProjMessages = await listProjectMessages(context.paths.msgDir, "testproj");
    const otherProjMessages = await listProjectMessages(context.paths.msgDir, "otherproj");
    const testProjPaths = getProjectPaths(context.paths, "testproj");
    const otherProjPaths = getProjectPaths(context.paths, "otherproj");
    const [testProjRuns, otherProjRuns, testProjActiveRuns, otherProjActiveRuns] = await Promise.all([
      listAllRuns(testProjPaths),
      listAllRuns(otherProjPaths),
      listActiveRuns(testProjPaths),
      listActiveRuns(otherProjPaths),
    ]);

    expect(
      testProjMessages.some((message) =>
        message.attributes.type === "nudge" &&
        message.body.includes("Stay focused on the original project."),
      ) ||
      testProjRuns.some((run) => run.agentId === "console") ||
      testProjActiveRuns.some((run) => run.agentId === "console"),
    ).toBe(true);
    expect(
      otherProjMessages.some((message) =>
        message.attributes.type === "nudge" &&
        message.body.includes("Stay focused on the original project."),
      ) ||
      otherProjRuns.some((run) => run.agentId === "console") ||
      otherProjActiveRuns.some((run) => run.agentId === "console"),
    ).toBe(false);
  });

  test("session can switch project focus and route subsequent turns there", async () => {
    const otherRepo = join(context.root, "other-repo");
    await mkdir(otherRepo, { recursive: true });

    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["project", "add", "OtherProj", otherRepo]);
    await runCli(["work", "testproj"]);

    const createReq = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const createRes = await handleApi(
      createReq,
      new URL(createReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(createRes.status).toBe(200);

    const switchReq = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/project otherproj" }),
    });
    const switchRes = await handleApi(
      switchReq,
      new URL(switchReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(switchRes.status).toBe(200);

    const switchData = await switchRes.json() as { result: string; sessionId: string; project: string };
    expect(switchData.result).toContain("otherproj");
    expect(switchData.project).toBe("otherproj");

    const sendReq = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Stay focused here." }),
    });
    const sendRes = await handleApi(
      sendReq,
      new URL(sendReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(sendRes.status).toBe(200);
    const sendData = await sendRes.json() as { project: string };
    expect(sendData.project).toBe("otherproj");

    await Bun.sleep(150);

    const sessionState = await Bun.file(
      join(context.hiveHome, "sessions", switchData.sessionId, "state.json"),
    ).json() as {
      currentProject: string;
    };
    expect(sessionState.currentProject).toBe("otherproj");

    const testProjPaths = getProjectPaths(context.paths, "testproj");
    const otherProjPaths = getProjectPaths(context.paths, "otherproj");
    const [testProjRuns, otherProjRuns, testProjActiveRuns, otherProjActiveRuns, testProjMessages, otherProjMessages] = await Promise.all([
      listAllRuns(testProjPaths),
      listAllRuns(otherProjPaths),
      listActiveRuns(testProjPaths),
      listActiveRuns(otherProjPaths),
      listProjectMessages(context.paths.msgDir, "testproj"),
      listProjectMessages(context.paths.msgDir, "otherproj"),
    ]);

    expect(
      otherProjRuns.some((run) => run.agentId === "console") ||
      otherProjActiveRuns.some((run) => run.agentId === "console") ||
      otherProjMessages.some((message) => message.body.includes("Stay focused here.")),
    ).toBe(true);
    expect(
      testProjRuns.some((run) => run.agentId === "console") ||
      testProjActiveRuns.some((run) => run.agentId === "console") ||
      testProjMessages.some((message) => message.body.includes("Stay focused here.")),
    ).toBe(false);
  });

  test("direct session APIs expose current project focus", async () => {
    const otherRepo = join(context.root, "other-repo");
    await mkdir(otherRepo, { recursive: true });

    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["project", "add", "OtherProj", otherRepo]);
    await runCli(["work", "testproj"]);

    const createReq = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const createRes = await handleApi(
      createReq,
      new URL(createReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    const createData = await createRes.json() as { sessionId: string };

    const switchReq = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/project otherproj" }),
    });
    const switchRes = await handleApi(
      switchReq,
      new URL(switchReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(switchRes.status).toBe(200);

    const historyReq = new Request("http://localhost/api/console/history");
    const historyRes = await handleApi(
      historyReq,
      new URL(historyReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(historyRes.status).toBe(200);

    const historyData = await historyRes.json() as {
      sessionId: string | null;
      project: string | null;
    };
    expect(historyData.sessionId).toBe(createData.sessionId);
    expect(historyData.project).toBe("otherproj");

    const detailReq = new Request(`http://localhost/api/sessions/${createData.sessionId}`);
    const detailRes = await handleApi(
      detailReq,
      new URL(detailReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(detailRes.status).toBe(200);

    const detailData = await detailRes.json() as {
      session: { currentProject: string };
    };
    expect(detailData.session.currentProject).toBe("otherproj");
  });

  test("session can inspect and switch steward runtime with /runtime", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const projectPaths = getProjectPaths(context.paths, "testproj");
    await Bun.write(
      projectPaths.config,
      `# Project: TestProj

## Repo
path: ${context.repo}

## Default Team
- steward: steward, claude-sonnet-4-6 via claude
- alpha: craftsman via codex
`,
    );

    const createReq = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const createRes = await handleApi(
      createReq,
      new URL(createReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(createRes.status).toBe(200);
    const createData = await createRes.json() as { sessionId: string };

    const inspectReq = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/runtime" }),
    });
    const inspectRes = await handleApi(
      inspectReq,
      new URL(inspectReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(inspectRes.status).toBe(200);
    const inspectData = await inspectRes.json() as { result: string };
    expect(inspectData.result).toContain("claude");
    expect(inspectData.result).toContain("claude-sonnet-4-6");

    const switchReq = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/runtime codex" }),
    });
    const switchRes = await handleApi(
      switchReq,
      new URL(switchReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(switchRes.status).toBe(200);
    const switchData = await switchRes.json() as { result: string; sessionId: string };
    expect(switchData.result).toContain("Switched the steward session to codex");

    const switchedMeta = await getSession(join(context.hiveHome, "sessions"), createData.sessionId);
    expect(switchedMeta?.runtime).toBe("codex");
    expect(switchedMeta?.model).toBeNull();
    expect(await Bun.file(join(context.hiveHome, "sessions", "active.md")).text()).toContain("runtime: codex");

    const switchBackReq = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/runtime claude" }),
    });
    const switchBackRes = await handleApi(
      switchBackReq,
      new URL(switchBackReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(switchBackRes.status).toBe(200);
    const switchBackData = await switchBackRes.json() as { result: string };
    expect(switchBackData.result).toContain("claude-sonnet-4-6");

    const switchedBackMeta = await getSession(join(context.hiveHome, "sessions"), createData.sessionId);
    expect(switchedBackMeta?.runtime).toBe("claude");
    expect(switchedBackMeta?.model).toBe("claude-sonnet-4-6");
  });

  test("session /help lists slash commands, routing shortcuts, and examples", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const createReq = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const createRes = await handleApi(
      createReq,
      new URL(createReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(createRes.status).toBe(200);

    const helpReq = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "/help" }),
    });
    const helpRes = await handleApi(
      helpReq,
      new URL(helpReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(helpRes.status).toBe(200);

    const helpData = await helpRes.json() as { result: string };
    expect(helpData.result).toContain("HIVE session help");
    expect(helpData.result).toContain("Current project: testproj");
    expect(helpData.result).toContain("Slash commands");
    expect(helpData.result).toContain("/runtime <runtime> <model>");
    expect(helpData.result).toContain("Routing shortcuts");
    expect(helpData.result).toContain("@<project>: <message>");
    expect(helpData.result).toContain("Examples");
    expect(helpData.result).toContain("what's happening right now?");
  });

  test("process logs endpoint exposes supervisor and active run tails", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "testproj");
    let run = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "# Prompt",
      source: "gateway-test",
    });
    run = await markRunActive(projectPaths, run, 81234);
    await Bun.write(getRunOutputPath(run), "booting\nchecking board\n");

    await writeDetachedSupervisorState(projectPaths, {
      projectId: "testproj",
      pid: 99123,
      status: "active",
      mode: "detached",
      intervalSeconds: 30,
      maxParallel: 3,
      startedAt: "2026-03-11T14:00:00Z",
      updatedAt: "2026-03-11T14:00:00Z",
      lastPassAt: "2026-03-11T14:00:00Z",
      stoppedAt: null,
      stopRequestedAt: null,
      stopRequestedBy: null,
      logPath: join(projectPaths.supervisorDir, "detached.log"),
    });
    await Bun.write(join(projectPaths.supervisorDir, "detached.log"), "tick one\ntick two\n");

    const req = new Request("http://localhost/api/process-logs?project=testproj");
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as {
      project: string | null;
      supervisor: { status: string; tail: string[] } | null;
      runs: Array<{ agentId: string; tail: string[] }>;
    };

    expect(data.project).toBe("testproj");
    expect(data.supervisor?.status).toBe("exited");
    expect(data.supervisor?.tail).toEqual(["tick one", "tick two"]);
    expect(data.runs.some((entry) =>
      entry.agentId === "alpha" &&
      entry.tail.join("\n").includes("checking board")
    )).toBe(true);
  });

  test("process logs endpoint expands the focused run tail when requested", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "testproj");
    let run = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "# Prompt",
      source: "gateway-test",
    });
    run = await markRunActive(projectPaths, run, 81234);
    await Bun.write(
      getRunOutputPath(run),
      Array.from({ length: 75 }, (_value, index) => `line ${index + 1}`).join("\n") + "\n",
    );

    const req = new Request(
      `http://localhost/api/process-logs?project=testproj&run=${encodeURIComponent(run.runId)}&lines=60`,
    );
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as {
      project: string | null;
      selectedRunId: string | null;
      runs: Array<{ runId: string; tail: string[] }>;
    };
    const selectedRun = data.runs.find((entry) => entry.runId === run.runId) ?? null;

    expect(data.project).toBe("testproj");
    expect(data.selectedRunId).toBe(run.runId);
    expect(selectedRun).not.toBeNull();
    expect(selectedRun?.tail.length).toBe(60);
    expect(selectedRun?.tail[0]).toBe("line 16");
    expect(selectedRun?.tail[selectedRun.tail.length - 1]).toBe("line 75");
  });

  test("live snapshot endpoint returns structured agents, activity, and recent completions", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "testproj");
    let activeRun = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "alpha",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "# Prompt",
      source: "gateway-test",
    });
    activeRun = await markRunActive(projectPaths, activeRun, process.pid);
    await Bun.write(getRunOutputPath(activeRun), "reading compact state\nassigning worker\n");

    let completedRun = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "beta",
      runtime: "claude",
      model: "claude-opus-4-6",
      prompt: "# Prompt",
      source: "gateway-test",
    });
    completedRun = await finalizeRun({
      projectPaths,
      run: completedRun,
      status: "exited",
      exitCode: 0,
    });
    await writeRunResult(completedRun, {
      finalVisibleOutput: "Implemented the auth fix and updated the tests.",
      changedFiles: ["src/auth.ts", "tests/auth.test.ts"],
      durationMs: 4200,
      numTurns: 2,
      totalTokens: 1800,
    });

    await writeDetachedSupervisorState(projectPaths, {
      projectId: "testproj",
      pid: process.pid,
      status: "active",
      mode: "detached",
      intervalSeconds: 30,
      maxParallel: 3,
      startedAt: "2026-03-11T14:00:00Z",
      updatedAt: "2026-03-11T14:00:00Z",
      lastPassAt: "2026-03-11T14:00:00Z",
      stoppedAt: null,
      stopRequestedAt: null,
      stopRequestedBy: null,
      logPath: join(projectPaths.supervisorDir, "detached.log"),
    });
    await Bun.write(join(projectPaths.supervisorDir, "detached.log"), "tick one\nchecking assignments\n");

    const req = new Request("http://localhost/api/live?project=testproj");
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as {
      project: string | null;
      summary: string | null;
      supervisor: { status: string; tail: string[] } | null;
      agents: Array<{ agentId: string; latestOutput: string | null; runtime: string; descriptor: string }>;
      recentCompletions: Array<{ agentId: string; summary: string; changedFiles: string[] }>;
      activity: Array<{ title: string; detail: string }>;
    };

    expect(data.project).toBe("testproj");
    expect(typeof data.summary).toBe("string");
    expect(data.supervisor?.status).toBe("active");
    expect(data.supervisor?.tail).toEqual(["tick one", "checking assignments"]);
    expect(data.agents.some((agent) =>
      agent.agentId === "alpha" &&
      agent.runtime === "codex" &&
      !agent.descriptor.includes("via codex") &&
      agent.latestOutput?.includes("assigning worker")
    )).toBe(true);
    expect(data.recentCompletions.some((completion) =>
      completion.agentId === "beta" &&
      completion.summary.includes("Implemented the auth fix") &&
      completion.changedFiles.includes("src/auth.ts")
    )).toBe(true);
    expect(data.activity.length).toBeGreaterThan(0);
  });

  test("queue snapshot endpoint returns approvals, waiting on human, and incidents", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    await createApprovalRequest({
      paths: context.paths,
      kind: "deploy",
      summary: "Deploy the login fix",
      note: "Need confirmation before rolling the hotfix.",
      project: "testproj",
      requestedBy: "steward",
    });
    await createMessage(context.paths.msgDir, {
      from: "alpha",
      to: "human",
      type: "question",
      project: "testproj",
      body: "Which rollout window should I target?",
    });
    await appendEvent({
      paths: context.paths,
      scope: "external",
      kind: "sentry.alert",
      source: "sentry",
      project: "testproj",
      severity: "warning",
      summary: "Login failures are spiking",
      details: ["error rate exceeded threshold", "route: /login"],
      data: { routed: true },
    });

    const req = new Request("http://localhost/api/queue?project=testproj");
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as {
      project: string | null;
      approvals: Array<{ kind: string; summary: string }>;
      waitingOnHuman: Array<{ from: string; to: string; needsHumanReply: boolean; summary: string }>;
      incidents: Array<{ source: string; severity: string; routed: boolean; summary: string }>;
    };

    expect(data.project).toBe("testproj");
    expect(data.approvals.some((approval) =>
      approval.kind === "deploy" &&
      approval.summary.includes("Deploy the login fix")
    )).toBe(true);
    expect(data.waitingOnHuman.some((item) =>
      item.from === "alpha" &&
      item.to === "human" &&
      item.needsHumanReply === true &&
      item.summary.includes("rollout window")
    )).toBe(true);
    expect(data.incidents.some((incident) =>
      incident.source === "sentry" &&
      incident.severity === "warning" &&
      incident.routed === true &&
      incident.summary.includes("Login failures")
    )).toBe(true);
  });

  test("timeline endpoint returns unified feed and event items", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    await createApprovalRequest({
      paths: context.paths,
      kind: "deploy",
      summary: "Deploy the login fix",
      project: "testproj",
      requestedBy: "steward",
    });
    await appendEvent({
      paths: context.paths,
      kind: "memory.extracted",
      source: "memory",
      project: "testproj",
      summary: "Daily memory extract completed",
      details: ["journal updated", "project summary refreshed"],
    });

    const req = new Request("http://localhost/api/timeline?project=testproj&count=10");
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as {
      project: string | null;
      items: Array<{ source: string; title: string; project: string | null; details: string[] }>;
    };

    expect(data.project).toBe("testproj");
    expect(data.items.some((item) =>
      item.source === "feed" &&
      item.title.includes("Approval requested")
    )).toBe(true);
    expect(data.items.some((item) =>
      item.source === "event" &&
      item.title.includes("Daily memory extract completed") &&
      item.project === "testproj" &&
      item.details.some((detail) => detail.includes("memory.extracted"))
    )).toBe(true);
  });

  test("file endpoint returns plain text for absolute file paths", async () => {
    const target = join(context.root, "linked-file.md");
    await Bun.write(target, "# linked\nhello gateway\n");

    const req = new Request(`http://localhost/api/file?path=${encodeURIComponent(target)}`);
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("hello gateway");
  });

  test("open endpoint launches a local path through the configured opener", async () => {
    const target = join(context.root, "open-me.ts");
    await Bun.write(target, "export const opened = true;\n");
    process.env.HIVE_OPEN_COMMAND = "/usr/bin/true";

    try {
      const req = new Request("http://localhost/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target, line: 12 }),
      });
      const res = await handleApi(
        req,
        new URL(req.url),
        { port: 0, hivePaths: context.paths },
        () => {},
      );

      expect(res.status).toBe(200);

      const data = await res.json() as { ok: boolean; strategy: string };
      expect(data.ok).toBe(true);
      expect(data.strategy).toBe("editor-cli");
    } finally {
      delete process.env.HIVE_OPEN_COMMAND;
    }
  });

  test("active steward turn interrupts the current web reply and restarts on the newest follow-up", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "testproj");
    const createReq = new Request("http://localhost/api/console/new", {
      method: "POST",
    });
    const createRes = await handleApi(
      createReq,
      new URL(createReq.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(createRes.status).toBe(200);
    const createData = await createRes.json() as { sessionId: string };

    await Bun.sleep(200);

    const sleeper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let run = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "console",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "# Prompt",
      source: "console",
      sourceMessage: createData.sessionId,
    });
    run = await markRunActive(projectPaths, run, sleeper.pid);
    await Bun.write(getRunOutputPath(run), "Inspecting recent progress\nChecking latest activity\n");

    try {
      const followUpMessage = "take the next step on the current goal";
      const req = new Request("http://localhost/api/console/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: followUpMessage }),
      });
      const res = await handleApi(
        req,
        new URL(req.url),
        { port: 0, hivePaths: context.paths },
        () => {},
      );
      expect(res.status).toBe(200);

      const data = await res.json() as { sessionId: string };
      expect(data.sessionId).toBe(createData.sessionId);
      await Bun.sleep(200);

      const [history, persistedRun] = await Promise.all([
        getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId),
        readRunRecord(run.path),
      ]);
      expect(history.some((turn) =>
        turn.role === "assistant" &&
        turn.source === "system" &&
        turn.content.includes("interrupting the current live steward draft")
      )).toBe(true);
      expect(history.some((turn) =>
        turn.role === "assistant" &&
        turn.details?.statusNotes?.some((note) => note.includes("Requested stop for live steward run"))
      )).toBe(true);
      expect(history.some((turn) =>
        turn.role === "assistant" &&
        turn.details?.statusNotes?.some((note) => note.includes("Queued 1 follow-up message(s) behind the restart"))
      )).toBe(true);
      expect(persistedRun?.stopRequestedAt).toBeTruthy();
      expect(persistedRun?.stopRequestedBy).toBe("human-follow-up");

      const messages = await listProjectMessages(context.paths.msgDir, "testproj");
      expect(messages.some((message) =>
        message.attributes.type === "nudge" &&
        message.body.includes(followUpMessage)
      )).toBe(false);
    } finally {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Process already exited.
      }
      await sleeper.exited;
    }
  });

  test("unowned active console turn keeps follow-ups queued instead of preempting", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "testproj");
    let run = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "console",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "# Prompt",
      source: "console",
    });
    run = await markRunActive(projectPaths, run, process.pid);
    await Bun.write(getRunOutputPath(run), "Inspecting recent progress\nChecking latest activity\n");

    const followUpMessage = "take the next step on the current goal";
    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: followUpMessage }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as { sessionId: string };
    await Bun.sleep(200);

    const [history, sessionState, persistedRun] = await Promise.all([
      getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId),
      getSessionState(join(context.hiveHome, "sessions"), data.sessionId),
      readRunRecord(run.path),
    ]);
    expect(history.some((turn) =>
      turn.role === "assistant" &&
      turn.source === "system" &&
      turn.content.includes("queued your latest note")
    )).toBe(true);
    expect(history.some((turn) =>
      turn.role === "assistant" &&
      turn.details?.statusNotes?.some((note) => note.includes("Queued 1 follow-up message(s) for the live steward"))
    )).toBe(true);
    expect(sessionState?.pendingTurns.map((item) => item.content)).toContain(followUpMessage);
    expect(persistedRun?.stopRequestedAt).toBeNull();
  });

  test("stale console run is cleared before gateway decides a turn is already in progress", async () => {
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const paths = await ensureHiveScaffold();
    const projectPaths = getProjectPaths(paths, "testproj");
    let run = await createRunDraft({
      projectId: "testproj",
      projectPaths,
      agentId: "console",
      runtime: "codex",
      model: "gpt-5-codex",
      prompt: "# Prompt",
      source: "console",
    });
    run = await markRunActive(projectPaths, run, 84567);
    await Bun.write(getRunOutputPath(run), "Stale output\nLast visible line\n");

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "can you answer for real now?" }),
    });
    const res = await handleApi(
      req,
      new URL(req.url),
      { port: 0, hivePaths: context.paths },
      () => {},
    );
    expect(res.status).toBe(200);

    const data = await res.json() as { sessionId: string };
    await Bun.sleep(250);

    const [history, activeRun, recentResults] = await Promise.all([
      getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId),
      readActiveRun(projectPaths, "console"),
      listRecentRunResults(projectPaths, 5),
    ]);

    expect(history.some((turn) =>
      turn.role === "assistant" &&
      turn.content.includes("I already have a live turn in progress")
    )).toBe(false);
    expect(activeRun?.agentId).toBe("console");
    expect(activeRun?.runId).not.toBe(run.runId);
    expect(recentResults.some((result) =>
      result.agentId === "console" &&
      result.status === "failed" &&
      result.finalVisibleOutput.includes("Last visible line")
    )).toBe(true);
  });

  test("POST /api/console/new creates a session", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/console/new`, {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const data = await res.json() as { sessionId: string };
      expect(data).toHaveProperty("sessionId");
      expect(typeof data.sessionId).toBe("string");
      expect(data.sessionId.length).toBeGreaterThan(0);
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/sessions lists sessions after creating one", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      // Create a session first
      const createRes = await fetch(`http://localhost:${port}/api/console/new`, {
        method: "POST",
      });
      const createData = await createRes.json() as { sessionId: string };
      const sessionId = createData.sessionId;

      // List sessions
      const listRes = await fetch(`http://localhost:${port}/api/sessions`);
      expect(listRes.status).toBe(200);

      const listData = await listRes.json() as { sessions: Array<{ sessionId: string }> };
      expect(listData).toHaveProperty("sessions");
      expect(Array.isArray(listData.sessions)).toBe(true);
      expect(listData.sessions.length).toBeGreaterThanOrEqual(1);

      // The created session should be in the list
      const found = listData.sessions.some((s) => s.sessionId === sessionId);
      expect(found).toBe(true);
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/sessions/:id returns session details and turns", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      // Create a session
      const createRes = await fetch(`http://localhost:${port}/api/console/new`, {
        method: "POST",
      });
      const createData = await createRes.json() as { sessionId: string };
      const sessionId = createData.sessionId;

      // Get session details
      const detailRes = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`);
      expect(detailRes.status).toBe(200);

      const detailData = await detailRes.json() as { session: { sessionId: string }; turns: unknown[] };
      expect(detailData).toHaveProperty("session");
      expect(detailData).toHaveProperty("turns");
      expect(detailData.session.sessionId).toBe(sessionId);
      expect(Array.isArray(detailData.turns)).toBe(true);
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/sessions/:id returns 404 for unknown session", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/sessions/nonexistent-session`);
      expect(res.status).toBe(404);

      const data = await res.json() as { error: string };
      expect(data).toHaveProperty("error");
    } finally {
      stopGateway(state);
    }
  });

  test("POST /api/console/send with missing message returns 400", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/console/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      const data = await res.json() as { error: string };
      expect(data.error).toContain("Missing");
    } finally {
      stopGateway(state);
    }
  });

  test("POST /api/console/send responds immediately without writing a synthetic ack turn", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/console/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Give the hive more personality." }),
      });

      expect(res.status).toBe(200);

      const data = await res.json() as { accepted: boolean; sessionId: string };
      expect(data.accepted).toBe(true);
      expect(data.sessionId).toBeTruthy();

      const historyRes = await fetch(`http://localhost:${port}/api/console/history`);
      expect(historyRes.status).toBe(200);

      const history = await historyRes.json() as {
        turns: Array<{ role: string; content: string }>;
        sessionId: string | null;
      };

      expect(history.sessionId).toBe(data.sessionId);
      expect(history.turns.length).toBeGreaterThanOrEqual(1);
      expect(history.turns[0]?.role).toBe("human");
      expect(history.turns[0]?.content).toContain("Give the hive more personality.");
      expect(history.turns.some((turn) => turn.content.includes("Heard. I'm on it."))).toBe(false);
    } finally {
      stopGateway(state);
    }
  });

  test("GET /api/console/history returns turns and sessionId", async () => {
    const port = randomPort();
    await runCli(["init"]);
    await runCli(["project", "add", "TestProj", context.repo]);
    await runCli(["work", "testproj"]);

    const state = startGateway({ port, hivePaths: context.paths });

    try {
      // Initially no session — should return empty
      const res1 = await fetch(`http://localhost:${port}/api/console/history`);
      expect(res1.status).toBe(200);
      const data1 = await res1.json() as { turns: unknown[]; sessionId: string | null };
      expect(data1).toHaveProperty("turns");
      expect(data1).toHaveProperty("sessionId");

      // Create a session
      await fetch(`http://localhost:${port}/api/console/new`, { method: "POST" });

      // Now history should return the session
      const res2 = await fetch(`http://localhost:${port}/api/console/history`);
      expect(res2.status).toBe(200);
      const data2 = await res2.json() as { turns: unknown[]; sessionId: string };
      expect(data2.sessionId).toBeTruthy();
    } finally {
      stopGateway(state);
    }
  });
});
