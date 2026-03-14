import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { handleApi } from "../src/gateway/routes";
import { startGateway, stopGateway } from "../src/gateway/server";
import { createApprovalRequest } from "../src/lib/approvals";
import { writeDetachedSupervisorState } from "../src/lib/detached-supervisor";
import { appendEvent } from "../src/lib/events";
import { createMessage, listProjectMessages } from "../src/lib/messages";
import { ensureHiveScaffold, getProjectPaths, type HivePaths } from "../src/lib/paths";
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
import { getSession, getSessionHistory, getSessionState } from "../src/lib/sessions";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
  paths: HivePaths;
};

let context: TestContext;

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
});

afterEach(async () => {
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  await rm(context.root, { recursive: true, force: true });
});

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
- orchestrator: steward, claude-sonnet-4-6 via claude
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
- orchestrator: steward, claude-sonnet-4-6 via claude
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
      const req = new Request("http://localhost/api/console/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "what's happening right now?" }),
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
        message.body.includes("what's happening right now?")
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

    const req = new Request("http://localhost/api/console/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "what's happening right now?" }),
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
    expect(sessionState?.pendingTurns.map((item) => item.content)).toContain("what's happening right now?");
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
