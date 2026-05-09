import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
