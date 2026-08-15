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

  // /runs is served and still reachable from any ticket that cites a run, but
  // it is not a destination anyone navigates to on purpose, so it holds no tab.
  test("every page carries the same four-tab nav, and none of them is RUNS", async () => {
    for (const path of ["/", "/tickets", "/taste", "/watches"]) {
      const body = await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
      expect(body).toContain('href="/tickets"');
      expect(body).toContain('href="/taste"');
      expect(body).toContain('href="/watches"');
      expect(body).not.toContain('href="/runs"');
    }
  });

  // --- /runs deep content assertions (TK-091) ---

  test("GET /runs renders arc-first view with direct dispatches", async () => {
    // Seed a completed run — it will appear as a direct dispatch (no parent_epic)
    const runDir = join(home, "runs", "RUN-050");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "status"), "complete");
    await writeFile(join(runDir, "goal.md"), "# Goal\n\nBuild the widget");
    await writeFile(join(runDir, "output.log"), "done.");

    const res = await fetch(`http://127.0.0.1:${port}/runs`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Arc-first page: direct dispatches section for orphan runs
    expect(body).toContain("direct-section");
    expect(body).toContain("RUN-050");
    // Page uses page-wide layout
    expect(body).toContain("page-wide");
  });

  test("GET /runs with empty fixture renders empty state", async () => {
    // No runs, no campaigns seeded — scaffold only
    const res = await fetch(`http://127.0.0.1:${port}/runs`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Arc-first empty state
    expect(body).toContain("No arcs to display");
    // Full document shell
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("HIVE");
  });

  test("GET /runs/RUN-XXX contains goal text and output.log tail", async () => {
    const runDir = join(home, "runs", "RUN-042");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "status"), "complete");
    await writeFile(join(runDir, "goal.md"), "# Goal\n\nRefactor the auth module for clarity");
    // Write multi-line log to verify tail extraction
    const logLines = Array.from({ length: 10 }, (_, i) => `[step ${i + 1}] processing...`);
    logLines.push("All steps complete. Shipped.");
    await writeFile(join(runDir, "output.log"), logLines.join("\n"));

    const res = await fetch(`http://127.0.0.1:${port}/runs/RUN-042`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Goal text rendered
    expect(body).toContain("Refactor the auth module for clarity");
    // Log tail section present
    expect(body).toContain("dispatch-detail-log");
    expect(body).toContain("log-tail");
    // Actual log content visible
    expect(body).toContain("All steps complete. Shipped.");
    expect(body).toContain("[step 1] processing...");
    // Section heading
    expect(body).toContain("Output");
  });

  test("GET /runs/CAMP-XXX contains scorecard header", async () => {
    const campDir = join(home, "campaigns", "CAMP-010");
    await mkdir(campDir, { recursive: true });
    await writeFile(join(campDir, "status"), "complete");
    await writeFile(join(campDir, "config.json"), JSON.stringify({ goal: "Run the optimization campaign" }));
    // Seed a scorecard with one iteration
    const scorecardRow = {
      iteration_n: 1,
      started_at: "2026-05-10T10:00:00Z",
      ended_at: "2026-05-10T10:30:00Z",
      exit_reason: "natural",
      judge_decision: "done",
      tokens_used: 50000,
      cost_usd: 0.42,
    };
    await writeFile(join(campDir, "scorecard.jsonl"), JSON.stringify(scorecardRow) + "\n");

    const res = await fetch(`http://127.0.0.1:${port}/runs/CAMP-010`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Campaign fragment rendered
    expect(body).toContain("campaign-fragment");
    expect(body).toContain("Run the optimization campaign");
    // Scorecard section present
    expect(body).toContain("Scorecard");
    expect(body).toContain("scorecard-table");
    // Scorecard data visible
    expect(body).toContain("Iter 1");
    expect(body).toContain("done");
  });

  test("GET /runs/UNKNOWN-999 returns 404 with styled error, no stack trace", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/runs/UNKNOWN-999`);
    expect(res.status).toBe(404);
    const body = await res.text();
    // Styled 404 page
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Not Found");
    // No stack trace leakage
    expect(body).not.toContain("at Object.");
    expect(body).not.toContain("at Module.");
    expect(body).not.toContain("at async ");
    expect(body).not.toMatch(/\bat \S+\.ts:\d+/);
    expect(body).not.toContain("Error:");
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
