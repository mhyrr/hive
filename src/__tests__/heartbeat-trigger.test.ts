import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { execSync } from "node:child_process";

import { shouldInvokeHeartbeat } from "../lib/heartbeat-trigger";
import { createTicket } from "../lib/ticket";
import type { HivePaths } from "../lib/paths";

let tempHome: string;
let tempProject: string;
let paths: HivePaths;
const projectId = "testproj";

function mkPaths(home: string): HivePaths {
  return {
    home,
    projectsDir: join(home, "projects"),
    memoryDir: join(home, "memory"),
    memoryProjectsDir: join(home, "memory", "projects"),
    memoryDailyDir: join(home, "memory", "daily"),
    runsDir: join(home, "runs"),
    reflectionsDir: join(home, "reflections"),
  };
}

function initGitRepo(dir: string): void {
  execSync(`git init -q`, { cwd: dir });
  execSync(`git config user.email test@example.com`, { cwd: dir });
  execSync(`git config user.name Test`, { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync(`git add README.md && git commit -qm "initial"`, { cwd: dir });
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "hive-trigger-home-"));
  tempProject = await mkdtemp(join(tmpdir(), "hive-trigger-proj-"));
  paths = mkPaths(tempHome);
  mkdirSync(join(tempHome, "projects", projectId, "tickets"), { recursive: true });
  initGitRepo(tempProject);
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
  await rm(tempProject, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// First tick & edge cases
// ---------------------------------------------------------------------------

describe("shouldInvokeHeartbeat — edge cases", () => {
  test("first tick (no lastTick) always invokes", async () => {
    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: "",
      paths,
    });
    expect(result.invoke).toBe(true);
    expect(result.reasons[0]).toContain("first tick");
  });

  test("unparseable lastTick fails open and invokes", async () => {
    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: "not-a-timestamp",
      paths,
    });
    expect(result.invoke).toBe(true);
    expect(result.reasons[0]).toContain("unparseable");
  });
});

// ---------------------------------------------------------------------------
// No-op path — should skip
// ---------------------------------------------------------------------------

describe("shouldInvokeHeartbeat — no signals", () => {
  test("quiet project with recent lastTick and nothing changed → skip", async () => {
    // Wait a beat so lastTick is guaranteed to be after the initial git commit
    // (otherwise `git log --since=lastTick` would return the setup commit and
    // spuriously trigger the "new commit" signal).
    await new Promise((r) => setTimeout(r, 1100));
    const recent = new Date().toISOString();
    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: recent,
      paths,
    });
    expect(result.invoke).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hourly forced tick
// ---------------------------------------------------------------------------

describe("shouldInvokeHeartbeat — hourly force", () => {
  test("invokes when lastTick > 60 minutes ago even with no other signals", async () => {
    const stale = new Date(Date.now() - 65 * 60 * 1000).toISOString(); // 65 min ago
    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: stale,
      paths,
    });
    expect(result.invoke).toBe(true);
    expect(result.reasons.some((r) => r.includes("hourly forced"))).toBe(true);
  });

  test("does NOT force when lastTick is under 60 minutes", async () => {
    // Wait past the initial commit so `git log --since` doesn't spuriously trigger.
    await new Promise((r) => setTimeout(r, 1100));
    const recent = new Date().toISOString();
    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: recent,
      paths,
    });
    expect(result.invoke).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Git commit detection
// ---------------------------------------------------------------------------

describe("shouldInvokeHeartbeat — git commits", () => {
  test("new commit since lastTick → invoke with commit reason", async () => {
    const before = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    // Wait 1s to ensure git timestamp is after lastTick, then make a commit.
    await new Promise((r) => setTimeout(r, 1000));
    writeFileSync(join(tempProject, "newfile.md"), "new\n");
    execSync(`git add newfile.md && git commit -qm "add newfile"`, { cwd: tempProject });

    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: before,
      paths,
    });
    expect(result.invoke).toBe(true);
    expect(result.reasons.some((r) => r.includes("new commit"))).toBe(true);
  });

  test("no new commits → no commit reason", async () => {
    // Use a lastTick from 2 seconds ago — after the initial commit but before now.
    await new Promise((r) => setTimeout(r, 2000));
    const lastTick = new Date(Date.now() - 1000).toISOString();

    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick,
      paths,
    });
    expect(result.reasons.every((r) => !r.includes("new commit"))).toBe(true);
  });

  test("non-git directory does not throw, just skips the signal", async () => {
    const notGit = await mkdtemp(join(tmpdir(), "hive-trigger-notgit-"));
    try {
      const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const result = await shouldInvokeHeartbeat({
        projectId,
        projectPath: notGit,
        lastTick: recent,
        paths,
      });
      // Should not throw. Should return skip (no other signals).
      expect(result.invoke).toBe(false);
    } finally {
      await rm(notGit, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ticket changes
// ---------------------------------------------------------------------------

describe("shouldInvokeHeartbeat — ticket updates", () => {
  test("ticket created after lastTick → invoke", async () => {
    const before = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await createTicket(paths, projectId, {
      title: "test ticket",
      type: "task",
      priority: 2,
    });

    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: before,
      paths,
    });
    expect(result.invoke).toBe(true);
    expect(result.reasons.some((r) => r.includes("updated since last tick"))).toBe(true);
  });

  test("ready auto-dispatch ticket → invoke with auto-dispatch reason", async () => {
    await createTicket(paths, projectId, {
      title: "dispatchable",
      type: "chore",
      priority: 2,
      tags: ["auto-dispatch"],
    });
    // Ticket was just created so "updated" also triggers. Use a future lastTick
    // to suppress the "updated" signal and isolate the auto-dispatch signal.
    const future = new Date(Date.now() + 60000).toISOString();

    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: future,
      paths,
    });
    expect(result.invoke).toBe(true);
    expect(result.reasons.some((r) => r.includes("auto-dispatch"))).toBe(true);
  });

  test("auto-dispatch ticket with unresolved deps does NOT trigger", async () => {
    // Blocker is still open.
    const blocker = await createTicket(paths, projectId, {
      title: "blocker",
      type: "task",
      priority: 2,
    });
    await createTicket(paths, projectId, {
      title: "blocked",
      type: "chore",
      priority: 2,
      tags: ["auto-dispatch"],
      depends: [blocker.id],
    });
    const future = new Date(Date.now() + 60000).toISOString();

    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: future,
      paths,
    });
    expect(result.reasons.every((r) => !r.includes("auto-dispatch"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dispatch run changes
// ---------------------------------------------------------------------------

describe("shouldInvokeHeartbeat — dispatch runs", () => {
  test("run status file modified after lastTick → invoke", async () => {
    const runDir = join(paths.home, "runs", "RUN-001");
    mkdirSync(runDir, { recursive: true });
    const statusPath = join(runDir, "status");
    writeFileSync(statusPath, "running\n");

    // Set lastTick to 5 minutes ago (before the file was just created).
    const before = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: before,
      paths,
    });
    expect(result.invoke).toBe(true);
    expect(result.reasons.some((r) => r.includes("dispatch run"))).toBe(true);
  });

  test("old run that hasn't changed → does not trigger", async () => {
    const runDir = join(paths.home, "runs", "RUN-OLD");
    mkdirSync(runDir, { recursive: true });
    const statusPath = join(runDir, "status");
    writeFileSync(statusPath, "completed\n");
    // Backdate the file.
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(statusPath, oldTime, oldTime);

    // lastTick is 5 minutes ago, after the file's backdated mtime.
    const lastTick = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick,
      paths,
    });
    expect(result.reasons.every((r) => !r.includes("dispatch run"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail-open behavior
// ---------------------------------------------------------------------------

describe("shouldInvokeHeartbeat — fail-open", () => {
  test("invalid project (no tickets dir) does not throw", async () => {
    // Remove the tickets directory to simulate a read failure.
    await rm(join(tempHome, "projects", projectId), { recursive: true, force: true });
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Should not throw. listTickets fails silently per existing code. We should
    // at least not crash.
    const result = await shouldInvokeHeartbeat({
      projectId,
      projectPath: tempProject,
      lastTick: recent,
      paths,
    });
    // We're just checking it didn't throw — either outcome (invoke or skip) is
    // acceptable for this smoke test.
    expect(typeof result.invoke).toBe("boolean");
  });
});
