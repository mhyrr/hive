import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveDir,
  archivePathForDate,
  isValidArchiveDate,
  listArchiveFiles,
  todayDateString,
} from "../lib/dashboard/archive";
import { buildDashboard, dashboardPath } from "../lib/dashboard";
import { ensureHiveScaffold, getHivePaths } from "../lib/paths";

describe("isValidArchiveDate", () => {
  test("accepts YYYY-MM-DD", () => {
    expect(isValidArchiveDate("2026-04-17")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isValidArchiveDate("2026-4-17")).toBe(false);
    expect(isValidArchiveDate("2026-04-17.html")).toBe(false);
    expect(isValidArchiveDate("../../etc/passwd")).toBe(false);
    expect(isValidArchiveDate("")).toBe(false);
    expect(isValidArchiveDate("20260417")).toBe(false);
  });
});

describe("todayDateString", () => {
  test("formats a supplied date", () => {
    expect(todayDateString(new Date("2026-04-17T23:30:00Z"))).toBe("2026-04-17");
  });
});

describe("archive path helpers", () => {
  test("archiveDir and archivePathForDate compose under ~/.hive", () => {
    const paths = getHivePaths("/tmp/fakehive");
    expect(archiveDir(paths)).toBe("/tmp/fakehive/dashboard/archive");
    expect(archivePathForDate(paths, "2026-04-17")).toBe(
      "/tmp/fakehive/dashboard/archive/2026-04-17.html",
    );
  });
});

describe("listArchiveFiles", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-archive-"));
    await ensureHiveScaffold(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("returns [] when archive dir missing", async () => {
    const paths = getHivePaths(home);
    const entries = await listArchiveFiles(paths);
    expect(entries).toEqual([]);
  });

  test("lists dated files newest first", async () => {
    const paths = getHivePaths(home);
    const dir = archiveDir(paths);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-04-15.html"), "<p>old</p>");
    await writeFile(join(dir, "2026-04-17.html"), "<p>new</p>");
    await writeFile(join(dir, "2026-04-16.html"), "<p>mid</p>");

    const entries = await listArchiveFiles(paths);
    expect(entries.map((e) => e.date)).toEqual([
      "2026-04-17",
      "2026-04-16",
      "2026-04-15",
    ]);
  });

  test("ignores non-matching filenames", async () => {
    const paths = getHivePaths(home);
    const dir = archiveDir(paths);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-04-17.html"), "<p>ok</p>");
    await writeFile(join(dir, "index.html"), "<p>skip</p>");
    await writeFile(join(dir, "README.md"), "skip");
    await writeFile(join(dir, "2026-4-17.html"), "skip");

    const entries = await listArchiveFiles(paths);
    expect(entries.map((e) => e.date)).toEqual(["2026-04-17"]);
  });

  test("respects the 30-day window (maxDays)", async () => {
    const paths = getHivePaths(home);
    const dir = archiveDir(paths);
    await mkdir(dir, { recursive: true });
    // Write 35 distinct dates spanning March + early April.
    // Days 1-31 in March, then 2026-04-01 through 2026-04-04.
    for (let i = 1; i <= 31; i++) {
      const day = String(i).padStart(2, "0");
      await writeFile(join(dir, `2026-03-${day}.html`), "<p>x</p>");
    }
    for (let i = 1; i <= 4; i++) {
      const day = String(i).padStart(2, "0");
      await writeFile(join(dir, `2026-04-${day}.html`), "<p>x</p>");
    }
    const all = await listArchiveFiles(paths, 30);
    expect(all).toHaveLength(30);
    // Newest first: 2026-04-04 ... back to 2026-03-06 (30 total)
    expect(all[0]!.date).toBe("2026-04-04");
    expect(all[29]!.date).toBe("2026-03-06");
  });
});

describe("buildDashboard archive write", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-build-"));
    await ensureHiveScaffold(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("writes both index.html and archive/YYYY-MM-DD.html with identical content", async () => {
    const paths = getHivePaths(home);
    const result = await buildDashboard(paths);

    const index = await readFile(dashboardPath(paths), "utf-8");
    const archive = await readFile(result.archive, "utf-8");

    expect(result.archive).toContain("dashboard/archive/");
    expect(result.archive).toEndWith(".html");
    expect(index).toBe(archive);
    // Static builds are frozen: no <script> block.
    expect(index).not.toContain("<script>");
  });
});

describe("renderDashboard { interactive: false }", () => {
  test("omits the client JS block", async () => {
    const { renderDashboard } = await import("../lib/dashboard/render");
    // A minimal DashboardData that just round-trips through the renderer.
    const data = {
      generatedAt: "2026-04-17T00:00:00Z",
      volumeNumber: 0,
      today: "2026-04-17",
      health: [],
      projects: [],
      inboxes: [],
      tickets: { ready: [], inProgress: [], blocked: [] },
      runs: [],
      briefings: [],
      todayBriefing: null,
    } as any;

    const staticHtml = renderDashboard(data, { interactive: false });
    const liveHtml = renderDashboard(data);

    expect(staticHtml).not.toContain("<script>");
    expect(liveHtml).toContain("<script>");
  });
});
