import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDashboardServer } from "../lib/dashboard/serve";
import { ensureHiveScaffold, getHivePaths } from "../lib/paths";
import { probePort } from "../commands/dashboard";

describe("dashboard server end-to-end", () => {
  let home: string;
  let server: ReturnType<typeof startDashboardServer>["server"] | null = null;
  let port: number;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-e2e-"));
    await ensureHiveScaffold(home);
    const paths = getHivePaths(home);
    // Port 0 → OS picks a free port.
    const started = startDashboardServer({
      paths,
      port: 0,
      runCli: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    server?.stop();
    server = null;
    await rm(home, { recursive: true, force: true });
  });

  test("GET / returns interactive HTML", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("<script>");
  });

  test("GET /fragment/tickets returns section HTML", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/fragment/tickets`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="section-tickets"');
  });

  test("GET /tickets returns the tickets-page document", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tickets`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("HIVE · Tickets");
    expect(body).toContain('class="page-nav"');
    expect(body).toContain("nav-active");
  });

  test("GET /fragment/tickets-page returns the new section fragment", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/fragment/tickets-page`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="section-tickets-page"');
  });

  test("POST /action/ticket/close with wrong Origin is 403", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/action/ticket/close`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ id: "TK-001" }),
    });
    expect(res.status).toBe(403);
  });

  test("POST /action/ticket/close with matching Origin is 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/action/ticket/close`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ id: "TK-001" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // --- /runs routes (TK-090) ---

  test("GET /runs returns the runs-page document", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runs`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("HIVE · Runs");
    expect(body).toContain('class="page-nav"');
    expect(body).toContain("nav-active");
  });

  test("GET /runs/RUN-999 returns 404 for unknown dispatch", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runs/RUN-999`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Not Found");
    expect(body).toContain("RUN-999");
    expect(body).toContain("/runs");
  });

  test("GET /runs/CAMP-999 returns 404 for unknown campaign", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runs/CAMP-999`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Not Found");
    expect(body).toContain("CAMP-999");
  });

  test("GET /runs/invalid returns 404 for bad ID format", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runs/invalid`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Not Found");
  });

  test("GET /runs/ with empty ID returns 404", async () => {
    // trailing slash with nothing after it
    const res = await fetch(`http://127.0.0.1:${port}/runs/`);
    expect(res.status).toBe(404);
  });

  test("GET /runs/RUN-001 returns dispatch fragment for known run", async () => {
    // Seed a fixture run
    const runDir = join(home, "runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "status"), "complete");
    await writeFile(join(runDir, "goal.md"), "# Goal\n\nImplement the widget feature");
    await writeFile(join(runDir, "output.log"), "Starting...\nDone.");

    const res = await fetch(`http://127.0.0.1:${port}/runs/RUN-001`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("RUN-001");
    expect(body).toContain("dispatch-detail");
    expect(body).toContain("Implement the widget feature");
  });

  test("GET /runs/CAMP-001 returns campaign fragment for known campaign", async () => {
    // Seed a fixture campaign
    const campDir = join(home, "campaigns", "CAMP-001");
    await mkdir(campDir, { recursive: true });
    await writeFile(join(campDir, "status"), "running");
    await writeFile(join(campDir, "config.json"), JSON.stringify({ goal: "Optimize the pipeline" }));
    await writeFile(join(campDir, "scorecard.jsonl"), "");

    const res = await fetch(`http://127.0.0.1:${port}/runs/CAMP-001`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("CAMP-001");
    expect(body).toContain("campaign-fragment");
    expect(body).toContain("Optimize the pipeline");
  });

  // --- Nav link presence ---

  test("/tickets page includes RUNS nav link", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tickets`);
    const body = await res.text();
    expect(body).toContain('href="/runs"');
    expect(body).toContain("RUNS");
  });

  test("/ home page includes Runs jump link", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.text();
    expect(body).toContain('href="/runs"');
    expect(body).toContain("Runs");
  });

  // --- No regressions ---

  test("GET / still renders (no regression)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
  });

  test("GET /tickets still renders (no regression)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tickets`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("HIVE · Tickets");
  });

  test("probePort returns true for a listening port", async () => {
    const up = await probePort("127.0.0.1", port, 500);
    expect(up).toBe(true);
  });

  test("probePort returns false for an unused port (within timeout)", async () => {
    // Pick a likely-unused port. 2 is reserved/unused in practice.
    const up = await probePort("127.0.0.1", 2, 500);
    expect(up).toBe(false);
  });
});
