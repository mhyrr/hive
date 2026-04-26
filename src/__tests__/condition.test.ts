import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildConditionReport, writeConditionReport } from "../lib/condition";
import { ensureHiveScaffold } from "../lib/paths";

const ONE_HOUR = 1000 * 60 * 60;

async function emptyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-condition-"));
  await ensureHiveScaffold(home);
  return home;
}

async function writeProjectConfig(home: string, projectId: string, repoPath: string): Promise<void> {
  const dir = join(home, "projects", projectId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "config.md"),
    `---\nname: ${projectId}\npath: ${repoPath}\n---\n`,
  );
}

describe("buildConditionReport — trivial-day detection", () => {
  test("empty home returns trivial=true with reason", async () => {
    const home = await emptyHome();
    const paths = await ensureHiveScaffold(home);
    const report = await buildConditionReport(paths);
    expect(report.trivial).toBe(true);
    expect(report.trivialReason).toContain("no commits");
    expect(report.totals.projectCount).toBe(0);
    expect(report.totals.commitCount).toBe(0);
    expect(report.totals.exchangeCount).toBe(0);
    expect(report.totals.ticketsMoved).toBe(0);
  });

  test("registered project with no activity stays trivial", async () => {
    const home = await emptyHome();
    const paths = await ensureHiveScaffold(home);
    await writeProjectConfig(home, "quiet-project", "/nonexistent/path");
    const report = await buildConditionReport(paths);
    expect(report.trivial).toBe(true);
    expect(report.totals.projectCount).toBe(1);
    expect(report.projects[0]?.projectName).toBe("quiet-project");
    expect(report.projects[0]?.git.available).toBe(false);
  });

  test("ticket moved within window flips trivial=false", async () => {
    const home = await emptyHome();
    const paths = await ensureHiveScaffold(home);
    await writeProjectConfig(home, "active-project", "/nonexistent/path");

    // Movement timestamp has to be within the 24h window the report uses.
    const recentTs = new Date(Date.now() - 2 * ONE_HOUR).toISOString();
    const ticketsDir = join(home, "projects", "active-project", "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(
      join(ticketsDir, "TK-001.md"),
      `---\nid: TK-001\ntitle: Just moved\nstatus: in_progress\ntype: task\npriority: 2\ntags: \ncreated: 2026-04-01T00:00:00Z\nupdated: ${recentTs}\nclosed: \nref: \ndepends: \n---\n\nBody\n`,
    );

    const report = await buildConditionReport(paths);
    expect(report.trivial).toBe(false);
    expect(report.totals.ticketsMoved).toBe(1);
    expect(report.projects[0]?.tickets.moved[0]?.id).toBe("TK-001");
  });

  test("ticket moved outside window does not register", async () => {
    const home = await emptyHome();
    const paths = await ensureHiveScaffold(home);
    await writeProjectConfig(home, "stale-project", "/nonexistent/path");

    const oldTs = new Date(Date.now() - 30 * 24 * ONE_HOUR).toISOString();
    const ticketsDir = join(home, "projects", "stale-project", "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(
      join(ticketsDir, "TK-001.md"),
      `---\nid: TK-001\ntitle: Old movement\nstatus: closed\ntype: task\npriority: 2\ntags: \ncreated: 2026-01-01T00:00:00Z\nupdated: ${oldTs}\nclosed: ${oldTs}\nref: \ndepends: \n---\n\nBody\n`,
    );

    const report = await buildConditionReport(paths);
    expect(report.totals.ticketsMoved).toBe(0);
    expect(report.trivial).toBe(true);
  });
});

describe("buildConditionReport — heartbeat signal", () => {
  test("counts bullet-list findings in inbox.md", async () => {
    const home = await emptyHome();
    const paths = await ensureHiveScaffold(home);
    await writeProjectConfig(home, "watched", "/nonexistent/path");

    const inboxPath = join(home, "projects", "watched", "inbox.md");
    await writeFile(
      inboxPath,
      "# Inbox: watched\n\n## 2026-04-26 14:00 — Heartbeat tick\n\n" +
        "- finding one — something happened\n" +
        "- finding two — something else\n" +
        "  - sub-bullet should also count as a finding-line\n" +
        "\nNot a bullet line.\n",
    );

    const report = await buildConditionReport(paths);
    expect(report.projects[0]?.heartbeat.findings).toBe(3);
    expect(report.projects[0]?.heartbeat.inboxBytes).toBeGreaterThan(0);
  });

  test("missing inbox returns zeros", async () => {
    const home = await emptyHome();
    const paths = await ensureHiveScaffold(home);
    await writeProjectConfig(home, "no-inbox", "/nonexistent/path");
    const report = await buildConditionReport(paths);
    expect(report.projects[0]?.heartbeat.findings).toBe(0);
    expect(report.projects[0]?.heartbeat.inboxBytes).toBe(0);
  });
});

describe("buildConditionReport — shape + persistence", () => {
  test("report carries per-project signals and totals", async () => {
    const home = await emptyHome();
    const paths = await ensureHiveScaffold(home);
    await writeProjectConfig(home, "alpha", "/nonexistent/alpha");
    await writeProjectConfig(home, "bravo", "/nonexistent/bravo");

    const report = await buildConditionReport(paths);
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.generatedAt).toMatch(/T/);
    expect(report.hoursWindow).toBe(24);
    expect(report.totals.projectCount).toBe(2);
    expect(report.projects.map((p) => p.projectName).sort()).toEqual(["alpha", "bravo"]);
    for (const p of report.projects) {
      expect(p.sessions.tokenEstimate).toBe(0);
      expect(p.sessions.topRanked).toEqual([]);
      expect(p.git.available).toBe(false);
      expect(p.tickets.moved).toEqual([]);
    }
  });

  test("writeConditionReport persists JSON at runs/{DATE}/condition.json", async () => {
    const home = await emptyHome();
    const paths = await ensureHiveScaffold(home);
    const report = await buildConditionReport(paths);
    const outPath = await writeConditionReport(paths, report);
    expect(outPath).toContain(report.date);
    expect(outPath.endsWith("condition.json")).toBe(true);

    const persisted = JSON.parse(await Bun.file(outPath).text());
    expect(persisted.date).toBe(report.date);
    expect(persisted.totals.projectCount).toBe(report.totals.projectCount);
    expect(persisted.trivial).toBe(report.trivial);
  });
});
