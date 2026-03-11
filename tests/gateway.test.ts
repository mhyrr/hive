import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";
import { startGateway, stopGateway } from "../src/gateway/server";
import { ensureHiveScaffold, getHivePaths, type HivePaths } from "../src/lib/paths";

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
