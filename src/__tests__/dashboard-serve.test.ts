import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleRequest,
  dispatchAction,
  isAllowedOrigin,
  type CliRunner,
  type CliResult,
} from "../lib/dashboard/serve";
import { ensureHiveScaffold, getHivePaths } from "../lib/paths";
import { archiveDir, archivePathForDate } from "../lib/dashboard/archive";

// A spyable CliRunner: returns exitCode 0 with empty stdout/stderr
// and records each invocation for later assertion.
type StubState = {
  calls: string[][];
  nextResult: CliResult;
};

function makeStubRunner(state: StubState): CliRunner {
  return async (argv: string[]) => {
    state.calls.push(argv);
    return state.nextResult;
  };
}

function buildCtx(paths: ReturnType<typeof getHivePaths>, state: StubState, port = 7777) {
  return {
    paths,
    runCli: makeStubRunner(state),
    port,
  };
}

function requestFor(
  method: string,
  path: string,
  {
    port = 7777,
    origin = `http://127.0.0.1:${port}`,
    body,
  }: { port?: number; origin?: string; body?: any } = {},
): Request {
  const headers: Record<string, string> = { origin };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    (init as any).body = typeof body === "string" ? body : JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  return new Request(`http://127.0.0.1:${port}${path}`, init);
}

// ---------------------------------------------------------------------------
// Origin check
// ---------------------------------------------------------------------------

describe("isAllowedOrigin", () => {
  test("accepts 127.0.0.1 and localhost", () => {
    expect(isAllowedOrigin("http://127.0.0.1:7777", 7777)).toBe(true);
    expect(isAllowedOrigin("http://localhost:7777", 7777)).toBe(true);
  });
  test("rejects wrong port", () => {
    expect(isAllowedOrigin("http://127.0.0.1:8080", 7777)).toBe(false);
  });
  test("rejects external origins", () => {
    expect(isAllowedOrigin("http://evil.example.com", 7777)).toBe(false);
  });
  test("rejects null", () => {
    expect(isAllowedOrigin(null, 7777)).toBe(false);
  });
  test("rejects https (no TLS on localhost)", () => {
    expect(isAllowedOrigin("https://127.0.0.1:7777", 7777)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("server routes", () => {
  let home: string;
  let state: StubState;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-serve-"));
    await ensureHiveScaffold(home);
    state = { calls: [], nextResult: { exitCode: 0, stdout: "", stderr: "" } };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("GET / serves interactive dashboard HTML", async () => {
    const paths = getHivePaths(home);
    const res = await handleRequest(requestFor("GET", "/"), buildCtx(paths, state));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toStartWith("<!doctype html>");
    expect(body).toContain("<script>");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /archive/:date returns frozen HTML when file exists", async () => {
    const paths = getHivePaths(home);
    await mkdir(archiveDir(paths), { recursive: true });
    await writeFile(archivePathForDate(paths, "2026-04-17"), "<p>hi</p>");

    const res = await handleRequest(requestFor("GET", "/archive/2026-04-17"), buildCtx(paths, state));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>hi</p>");
  });

  test("GET /archive/:date rejects bad dates with 400", async () => {
    const paths = getHivePaths(home);
    const res = await handleRequest(requestFor("GET", "/archive/not-a-date"), buildCtx(paths, state));
    expect(res.status).toBe(400);
  });

  test("GET /archive/:date returns 404 for missing day", async () => {
    const paths = getHivePaths(home);
    const res = await handleRequest(requestFor("GET", "/archive/2026-04-17"), buildCtx(paths, state));
    expect(res.status).toBe(404);
  });

  test("GET /fragment/tickets returns section HTML", async () => {
    const paths = getHivePaths(home);
    const res = await handleRequest(requestFor("GET", "/fragment/tickets"), buildCtx(paths, state));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="section-tickets"');
  });

  test("GET /fragment/bogus returns 404", async () => {
    const paths = getHivePaths(home);
    const res = await handleRequest(requestFor("GET", "/fragment/bogus"), buildCtx(paths, state));
    expect(res.status).toBe(404);
  });

  test("GET /watches/:name serves the per-watch prompt page", async () => {
    const paths = getHivePaths(home);
    await writeFile(
      join(paths.watchesDir, "bets.md"),
      "---\nname: bets\ncadence: @nightly\nscope: runs\n---\n\nWhat bets?",
    );

    const res = await handleRequest(requestFor("GET", "/watches/bets"), buildCtx(paths, state));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Prompt as it fires now");
    expect(body).toContain("What bets?");
  });

  test("GET /watches/:name returns 404 for an unknown watch", async () => {
    const paths = getHivePaths(home);
    const res = await handleRequest(requestFor("GET", "/watches/ghost"), buildCtx(paths, state));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No watch named");
  });

  test("unknown route returns 404", async () => {
    const paths = getHivePaths(home);
    const res = await handleRequest(requestFor("GET", "/nope"), buildCtx(paths, state));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /action guarded by Origin
// ---------------------------------------------------------------------------

describe("POST /action origin enforcement", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-act-"));
    await ensureHiveScaffold(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("rejects missing Origin with 403", async () => {
    const paths = getHivePaths(home);
    const state: StubState = { calls: [], nextResult: { exitCode: 0, stdout: "", stderr: "" } };
    const req = new Request("http://127.0.0.1:7777/action/ticket/close", {
      method: "POST",
      body: JSON.stringify({ id: "TK-007" }),
      headers: { "content-type": "application/json" },
    });
    const res = await handleRequest(req, buildCtx(paths, state));
    expect(res.status).toBe(403);
    expect(state.calls).toEqual([]); // handler never reached
  });

  test("rejects evil Origin with 403", async () => {
    const paths = getHivePaths(home);
    const state: StubState = { calls: [], nextResult: { exitCode: 0, stdout: "", stderr: "" } };
    const req = requestFor("POST", "/action/ticket/close", {
      origin: "http://evil.example.com",
      body: { id: "TK-007" },
    });
    const res = await handleRequest(req, buildCtx(paths, state));
    expect(res.status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  test("accepts localhost Origin", async () => {
    const paths = getHivePaths(home);
    const state: StubState = { calls: [], nextResult: { exitCode: 0, stdout: "", stderr: "" } };
    const req = requestFor("POST", "/action/ticket/close", {
      origin: "http://localhost:7777",
      body: { id: "TK-007" },
    });
    const res = await handleRequest(req, buildCtx(paths, state));
    expect(res.status).toBe(200);
    expect(state.calls).toEqual([["ticket", "close", "TK-007"]]);
  });
});

// ---------------------------------------------------------------------------
// Action dispatch — CLI builds
// ---------------------------------------------------------------------------

describe("dispatchAction — CLI actions", () => {
  let home: string;
  let state: StubState;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-disp-"));
    await ensureHiveScaffold(home);
    state = { calls: [], nextResult: { exitCode: 0, stdout: "", stderr: "" } };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("ticket/close invokes [ticket, close, ID]", async () => {
    const paths = getHivePaths(home);
    const res = await dispatchAction(buildCtx(paths, state), "ticket/close", { id: "TK-007" });
    expect(res.message).toContain("TK-007 closed");
    expect(res.refreshedSection).toBe("tickets");
    expect(state.calls).toEqual([["ticket", "close", "TK-007"]]);
  });

  test("ticket/dispatch-run invokes [dispatch, --ticket, ID]", async () => {
    const paths = getHivePaths(home);
    await dispatchAction(buildCtx(paths, state), "ticket/dispatch-run", { id: "TK-007" });
    expect(state.calls[0]).toEqual(["dispatch", "--ticket", "TK-007"]);
  });

  test("ticket/tag-dispatch invokes [ticket, dispatch, ID]", async () => {
    const paths = getHivePaths(home);
    await dispatchAction(buildCtx(paths, state), "ticket/tag-dispatch", { id: "TK-007" });
    expect(state.calls[0]).toEqual(["ticket", "dispatch", "TK-007"]);
  });

  test("dispatch/kill invokes [kill, RUN-ID]", async () => {
    const paths = getHivePaths(home);
    await dispatchAction(buildCtx(paths, state), "dispatch/kill", { runId: "RUN-009" });
    expect(state.calls[0]).toEqual(["kill", "RUN-009"]);
  });

  test("CLI nonzero exit becomes 500 error", async () => {
    const paths = getHivePaths(home);
    state.nextResult = { exitCode: 1, stdout: "", stderr: "boom" };
    // We get here through POST, which converts to 500 via the catch block in serveAction.
    const req = requestFor("POST", "/action/ticket/close", { body: { id: "TK-007" } });
    const res = await handleRequest(req, buildCtx(paths, state));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("boom");
  });

  test("bad input returns 400", async () => {
    const paths = getHivePaths(home);
    const req = requestFor("POST", "/action/ticket/close", { body: { id: "not-a-ticket" } });
    const res = await handleRequest(req, buildCtx(paths, state));
    expect(res.status).toBe(400);
  });

  test("unknown action path returns 404", async () => {
    const paths = getHivePaths(home);
    const req = requestFor("POST", "/action/made-up", { body: {} });
    const res = await handleRequest(req, buildCtx(paths, state));
    expect(res.status).toBe(404);
  });

  test("malformed JSON body returns 400", async () => {
    const paths = getHivePaths(home);
    const req = requestFor("POST", "/action/ticket/close", { body: "not-json{" });
    const res = await handleRequest(req, buildCtx(paths, state));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Direct-file actions — hit real files in tmp HIVE
// ---------------------------------------------------------------------------

describe("dispatchAction — direct-file actions", () => {
  let home: string;
  let state: StubState;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-df-"));
    await ensureHiveScaffold(home);
    state = { calls: [], nextResult: { exitCode: 0, stdout: "", stderr: "" } };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("dispatch/override-status writes status file", async () => {
    const paths = getHivePaths(home);
    await mkdir(join(paths.runsDir, "RUN-010"), { recursive: true });
    const res = await dispatchAction(buildCtx(paths, state), "dispatch/override-status", {
      runId: "RUN-010",
      status: "complete",
    });
    expect(res.message).toContain("complete");
    const body = await readFile(join(paths.runsDir, "RUN-010", "status"), "utf-8");
    expect(body.trim()).toBe("complete");
  });

  test("dispatch/override-status rejects bogus status", async () => {
    const paths = getHivePaths(home);
    await mkdir(join(paths.runsDir, "RUN-010"), { recursive: true });
    const req = requestFor("POST", "/action/dispatch/override-status", {
      body: { runId: "RUN-010", status: "pwned" },
    });
    const res = await handleRequest(req, buildCtx(paths, state));
    expect(res.status).toBe(400);
  });

  test("inbox/ack writes acknowledgement", async () => {
    const paths = getHivePaths(home);
    await mkdir(join(paths.projectsDir, "hive"), { recursive: true });
    await dispatchAction(buildCtx(paths, state), "inbox/ack", {
      project: "hive",
      entry: "some text",
    });
    const body = await readFile(join(paths.projectsDir, "hive", "inbox-ack.json"), "utf-8");
    expect(JSON.parse(body)).toHaveLength(1);
  });

  test("identity/propose writes proposal file", async () => {
    const paths = getHivePaths(home);
    const res = await dispatchAction(buildCtx(paths, state), "identity/propose", {
      text: "Never assume",
    });
    expect(res.message).toContain("proposal filed at");
  });

  test("reflection/dismiss writes hash to dismissed list", async () => {
    const paths = getHivePaths(home);
    await dispatchAction(buildCtx(paths, state), "reflection/dismiss", {
      reflection: "nope",
    });
    const body = await readFile(join(paths.reflectionsDir, "_dismissed.json"), "utf-8");
    expect(JSON.parse(body)).toHaveLength(1);
  });
});
