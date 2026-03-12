import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { handleApi } from "../src/gateway/routes";
import { startGateway, stopGateway } from "../src/gateway/server";
import { listProjectMessages } from "../src/lib/messages";
import { ensureHiveScaffold, getHivePaths, type HivePaths } from "../src/lib/paths";
import { getSessionHistory } from "../src/lib/sessions";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
  paths: HivePaths;
};

let context: TestContext;

function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
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
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/feed?count=5`);
      expect(res.status).toBe(200);

      const data = await res.json() as { result: string };
      expect(data).toHaveProperty("result");
      expect(typeof data.result).toBe("string");
    } finally {
      stopGateway(state);
    }
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
  test("handleApi console send returns immediate ack without a live server", async () => {
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

    const data = await res.json() as { result: string; sessionId: string };
    expect(data.result).toContain("Heard. I'm on it.");
    expect(data.sessionId).toBeTruthy();

    const turns = await getSessionHistory(join(context.hiveHome, "sessions"), data.sessionId);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[0]?.role).toBe("human");
    expect(turns[0]?.content).toContain("Give the hive more personality.");
    expect(turns[1]?.role).toBe("assistant");
    expect(turns[1]?.content).toContain("Heard. I'm on it.");
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

    await Bun.sleep(25);

    const testProjMessages = await listProjectMessages(context.paths.msgDir, "testproj");
    const otherProjMessages = await listProjectMessages(context.paths.msgDir, "otherproj");

    expect(
      testProjMessages.some((message) =>
        message.attributes.type === "nudge" &&
        message.body.includes("Stay focused on the original project."),
      ),
    ).toBe(true);
    expect(
      otherProjMessages.some((message) =>
        message.attributes.type === "nudge" &&
        message.body.includes("Stay focused on the original project."),
      ),
    ).toBe(false);
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

  test("POST /api/console/send responds immediately and writes session turns", async () => {
    const port = randomPort();
    const state = startGateway({ port, hivePaths: context.paths });

    try {
      const res = await fetch(`http://localhost:${port}/api/console/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Give the hive more personality." }),
      });

      expect(res.status).toBe(200);

      const data = await res.json() as { result: string; sessionId: string };
      expect(data.result).toContain("Heard. I'm on it.");
      expect(data.sessionId).toBeTruthy();

      const historyRes = await fetch(`http://localhost:${port}/api/console/history`);
      expect(historyRes.status).toBe(200);

      const history = await historyRes.json() as {
        turns: Array<{ role: string; content: string }>;
        sessionId: string | null;
      };

      expect(history.sessionId).toBe(data.sessionId);
      expect(history.turns.length).toBeGreaterThanOrEqual(2);
      expect(history.turns[0]?.role).toBe("human");
      expect(history.turns[0]?.content).toContain("Give the hive more personality.");
      expect(history.turns[1]?.role).toBe("assistant");
      expect(history.turns[1]?.content).toContain("Heard. I'm on it.");
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
