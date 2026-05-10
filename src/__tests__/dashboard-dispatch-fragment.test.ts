import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderDispatchFragment,
  type DispatchDetail,
} from "../lib/dashboard/render-dispatch";
import {
  collectDispatchDetail,
} from "../lib/dashboard/runs/collect-detail";
import { ensureHiveScaffold } from "../lib/paths";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function shippedFixture(): DispatchDetail {
  return {
    id: "RUN-022",
    status: "shipped",
    startedAt: "2026-05-10T02:00:00.000Z",
    endedAt: "2026-05-10T03:30:00.000Z",
    elapsedSec: 5400,
    costUsd: 0.56,
    ticketId: "TK-074",
    goalFull: [
      "Implement ticket TK-074: Build campaign state directory and data model",
      "",
      "## Scope",
      "Create the state management layer for campaigns.",
      "",
      "## Acceptance",
      "- [ ] State directory created",
      "- [ ] Data model defined",
      "",
      "```typescript",
      "interface CampaignState {",
      "  id: string;",
      "  status: 'running' | 'done';",
      "}",
      "```",
    ].join("\n"),
    worktreeBranch: "worktree-run-022",
    worktreeState: "merged",
    logTail: [
      "✓ 18 tests passed",
      "✓ All acceptance criteria met",
      "Committing changes...",
      "feat(campaign): build state directory and data model (TK-074)",
      "Merging to main...",
      "Branch worktree-run-022 merged successfully",
    ].join("\n"),
    logAvailable: true,
    runDir: "/Users/test/.hive/runs/RUN-022",
  };
}

function crashedFixture(): DispatchDetail {
  return {
    id: "RUN-015",
    status: "crashed",
    startedAt: "2026-05-09T22:15:00.000Z",
    endedAt: "2026-05-09T22:17:30.000Z",
    elapsedSec: 150,
    ticketId: "TK-041",
    goalFull: "Fix the false-negative dispatch status reporting bug.\n\nThe plan.md heuristic is unreliable.",
    worktreeBranch: "worktree-run-015",
    worktreeState: "pruned",
    logTail: "",
    logAvailable: false,
    runDir: "/Users/test/.hive/runs/RUN-015",
  };
}

function noLogFixture(): DispatchDetail {
  return {
    id: "RUN-005",
    status: "failed",
    startedAt: "2026-04-20T10:00:00.000Z",
    endedAt: "2026-04-20T10:05:00.000Z",
    elapsedSec: 300,
    goalFull: "Quick task that failed immediately.",
    logTail: "",
    logAvailable: false,
    runDir: "/Users/test/.hive/runs/RUN-005",
  };
}

function runningFixture(): DispatchDetail {
  return {
    id: "RUN-034",
    status: "running",
    startedAt: "2026-05-10T20:00:00.000Z",
    elapsedSec: 600,
    goalFull: "Implement TK-088: Render dispatch drill-in fragment",
    worktreeBranch: "worktree-run-034",
    worktreeState: "alive",
    logTail: "Reading codebase...\nWriting render-dispatch.ts...",
    logAvailable: true,
    runDir: "/Users/test/.hive/runs/RUN-034",
  };
}

// ---------------------------------------------------------------------------
// Render tests
// ---------------------------------------------------------------------------

describe("renderDispatchFragment", () => {
  // ------ Structural tests ------

  test("returns HTML string", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });

  test("contains run ID", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("RUN-022");
    expect(html).toContain('data-run-id="RUN-022"');
  });

  test("contains dispatch eyebrow", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("dispatch-detail-eyebrow");
    expect(html).toContain("Dispatch");
  });

  // ------ Status rendering ------

  test("shipped status renders with correct class", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("status-shipped");
    expect(html).toContain("Shipped");
  });

  test("crashed status renders with correct class", () => {
    const html = renderDispatchFragment(crashedFixture());
    expect(html).toContain("status-crashed");
    expect(html).toContain("Crashed");
  });

  test("running status renders with correct class", () => {
    const html = renderDispatchFragment(runningFixture());
    expect(html).toContain("status-running");
    expect(html).toContain("Running");
  });

  // ------ Ticket link ------

  test("shows ticket ID when present, linking to /tickets#TK-NNN", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("TK-074");
    expect(html).toContain("dispatch-detail-ticket");
    expect(html).toContain('href="/tickets#TK-074"');
  });

  test("omits ticket link when absent", () => {
    const html = renderDispatchFragment(noLogFixture());
    expect(html).not.toContain("dispatch-detail-ticket");
  });

  // ------ Worktree branch ------

  test("shows worktree branch with merged state", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("worktree-run-022");
    expect(html).toContain("branch-merged");
    expect(html).toContain("merged");
  });

  test("shows worktree branch with alive state", () => {
    const html = renderDispatchFragment(runningFixture());
    expect(html).toContain("worktree-run-034");
    expect(html).toContain("branch-alive");
    expect(html).toContain("alive");
  });

  test("shows worktree branch with pruned state", () => {
    const html = renderDispatchFragment(crashedFixture());
    expect(html).toContain("worktree-run-015");
    expect(html).toContain("branch-pruned");
    expect(html).toContain("pruned");
  });

  test("omits branch when not present", () => {
    const html = renderDispatchFragment(noLogFixture());
    expect(html).not.toContain("dispatch-detail-branch");
  });

  // ------ Metadata strip ------

  test("shows started timestamp", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("started");
    // Should contain a formatted date
    expect(html).toContain("May 10, 2026");
  });

  test("shows ended timestamp when available", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("ended");
  });

  test("omits ended for running dispatch", () => {
    const html = renderDispatchFragment(runningFixture());
    // The metadata should not have an ended entry (count occurrences)
    const metaSection = html.match(/dispatch-detail-meta[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(metaSection).not.toContain('"meta-label">ended');
  });

  test("shows elapsed time", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("elapsed");
    expect(html).toContain("1h 30m"); // 5400 seconds
  });

  test("shows cost when available", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("cost");
    expect(html).toContain("$0.56");
  });

  test("omits cost when not available", () => {
    const html = renderDispatchFragment(crashedFixture());
    const metaSection = html.match(/dispatch-detail-meta[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(metaSection).not.toContain('"meta-label">cost');
  });

  // ------ Goal rendering ------

  test("renders goal text as markdown", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("dispatch-detail-goal");
    // Markdown headings should be rendered
    expect(html).toContain("<h2>");
    expect(html).toContain("Scope");
  });

  test("preserves code-fenced sections in goal", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("<code");
    expect(html).toContain("CampaignState");
  });

  test("shows empty state for missing goal", () => {
    const fixture = { ...noLogFixture(), goalFull: "" };
    const html = renderDispatchFragment(fixture);
    expect(html).toContain("(no goal text)");
    expect(html).toContain("empty-state");
  });

  test("renders checkboxes in goal", () => {
    const html = renderDispatchFragment(shippedFixture());
    // GFM checkboxes
    expect(html).toContain("checkbox");
  });

  // ------ Log tail ------

  test("shows log tail when available", () => {
    const html = renderDispatchFragment(shippedFixture());
    expect(html).toContain("log-tail");
    expect(html).toContain("18 tests passed");
    expect(html).toContain("Merging to main");
  });

  test("shows empty state for missing log", () => {
    const html = renderDispatchFragment(crashedFixture());
    expect(html).toContain("(no output captured");
    expect(html).toContain("RUN-015/output.log");
  });

  test("includes run dir path in log fallback message", () => {
    const html = renderDispatchFragment(noLogFixture());
    expect(html).toContain("/Users/test/.hive/runs/RUN-005/output.log");
  });

  test("escapes HTML in log output", () => {
    const fixture = {
      ...shippedFixture(),
      logTail: "Processing <script>alert('xss')</script> done",
    };
    const html = renderDispatchFragment(fixture);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // ------ Snapshot: shipped dispatch ------

  test("snapshot: shipped dispatch structure", () => {
    const html = renderDispatchFragment(shippedFixture());

    // Verify the overall structure has all major sections
    expect(html).toContain("dispatch-detail-head");
    expect(html).toContain("dispatch-detail-meta");
    expect(html).toContain("dispatch-detail-goal");
    expect(html).toContain("dispatch-detail-log");

    // Header area
    expect(html).toContain("RUN-022");
    expect(html).toContain("Shipped");
    expect(html).toContain("TK-074");
    expect(html).toContain("worktree-run-022");
    expect(html).toContain("merged");

    // Meta strip
    expect(html).toContain("$0.56");
    expect(html).toContain("1h 30m");

    // Goal rendered as HTML
    expect(html).toContain("<h2>");
    expect(html).toContain("Build campaign state directory");

    // Log
    expect(html).toContain("18 tests passed");
  });

  // ------ Snapshot: crashed dispatch ------

  test("snapshot: crashed dispatch structure", () => {
    const html = renderDispatchFragment(crashedFixture());

    // Header
    expect(html).toContain("RUN-015");
    expect(html).toContain("Crashed");
    expect(html).toContain("status-crashed");
    expect(html).toContain("TK-041");

    // Branch pruned
    expect(html).toContain("worktree-run-015");
    expect(html).toContain("pruned");
    expect(html).toContain("branch-pruned");

    // No cost
    const metaSection = html.match(/dispatch-detail-meta[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(metaSection).not.toContain('"meta-label">cost');

    // Elapsed
    expect(html).toContain("2m 30s"); // 150 seconds

    // No log — fallback message
    expect(html).toContain("(no output captured");
    expect(html).toContain("RUN-015/output.log");
  });
});

// ---------------------------------------------------------------------------
// Collect detail tests (with fixture directories)
// ---------------------------------------------------------------------------

describe("collectDispatchDetail", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-dispatch-detail-"));
    await ensureHiveScaffold(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function createRun(
    id: string,
    opts: {
      status: string;
      goal?: string;
      pid?: string;
      outputLog?: string;
      runSh?: string;
    },
  ): Promise<void> {
    const dir = join(home, "runs", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "status"), opts.status);
    await writeFile(
      join(dir, "goal.md"),
      opts.goal ?? `# Goal\n\nImplement ${id}.\n`,
    );
    if (opts.pid !== undefined) {
      await writeFile(join(dir, "pid"), opts.pid);
    }
    if (opts.outputLog !== undefined) {
      await writeFile(join(dir, "output.log"), opts.outputLog);
    }
    if (opts.runSh !== undefined) {
      await writeFile(join(dir, "run.sh"), opts.runSh);
    }
  }

  function paths() {
    return {
      home,
      soul: join(home, "SOUL.md"),
      identity: join(home, "IDENTITY.md"),
      self: join(home, "SELF.md"),
      agents: join(home, "AGENTS.md"),
      trust: join(home, "TRUST.md"),
      config: join(home, "config.md"),
      memoryDir: join(home, "memory"),
      memoryProjectsDir: join(home, "memory", "projects"),
      memoryDailyDir: join(home, "memory", "daily"),
      memoryRunsDir: join(home, "memory", "runs"),
      projectsDir: join(home, "projects"),
      runsDir: join(home, "runs"),
      campaignsDir: join(home, "campaigns"),
      reflectionsDir: join(home, "reflections"),
    };
  }

  test("returns null for missing status", async () => {
    const dir = join(home, "runs", "RUN-099");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "goal.md"), "# Goal\nSomething");
    // No status file

    const result = await collectDispatchDetail(paths(), "RUN-099", {
      checkPid: false,
      skipGit: true,
    });
    expect(result).toBeNull();
  });

  test("collects shipped dispatch with full goal", async () => {
    const goal = [
      "# Goal",
      "",
      "Implement ticket TK-050: Build the widget.",
      "",
      "## Scope",
      "Build a widget that does things.",
    ].join("\n");
    const log = "Line 1\nLine 2\nLine 3\nDone.\n";

    await createRun("RUN-010", {
      status: "complete",
      goal,
      outputLog: log,
      runSh: `"--name" "RUN-010"`,
    });

    const result = await collectDispatchDetail(paths(), "RUN-010", {
      checkPid: false,
      skipGit: true,
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe("RUN-010");
    expect(result!.status).toBe("shipped");
    expect(result!.ticketId).toBe("TK-050");
    expect(result!.goalFull).toContain("Build a widget");
    expect(result!.goalFull).toContain("## Scope");
    expect(result!.logAvailable).toBe(true);
    expect(result!.logTail).toContain("Done.");
  });

  test("handles 0-byte output.log gracefully", async () => {
    await createRun("RUN-011", {
      status: "failed",
      outputLog: "",
    });

    const result = await collectDispatchDetail(paths(), "RUN-011", {
      checkPid: false,
      skipGit: true,
    });

    expect(result).not.toBeNull();
    expect(result!.logAvailable).toBe(false);
    expect(result!.logTail).toBe("");
  });

  test("handles missing output.log", async () => {
    await createRun("RUN-012", {
      status: "crashed",
      // No outputLog written
    });

    const result = await collectDispatchDetail(paths(), "RUN-012", {
      checkPid: false,
      skipGit: true,
    });

    expect(result).not.toBeNull();
    expect(result!.logAvailable).toBe(false);
    expect(result!.logTail).toBe("");
  });

  test("tails log to configured line count", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
    await createRun("RUN-013", {
      status: "complete",
      outputLog: lines.join("\n"),
    });

    const result = await collectDispatchDetail(paths(), "RUN-013", {
      checkPid: false,
      skipGit: true,
      logTailLines: 10,
    });

    expect(result).not.toBeNull();
    expect(result!.logTail).toContain("Line 191");
    expect(result!.logTail).toContain("Line 200");
    expect(result!.logTail).not.toContain("Line 100");
  });

  test("extracts ticket ID from goal", async () => {
    await createRun("RUN-014", {
      status: "complete",
      goal: "# Goal\n\nImplement TK-088: Render dispatch drill-in fragment\n",
    });

    const result = await collectDispatchDetail(paths(), "RUN-014", {
      checkPid: false,
      skipGit: true,
    });

    expect(result!.ticketId).toBe("TK-088");
  });

  test("extracts worktree branch from run.sh", async () => {
    await createRun("RUN-015", {
      status: "complete",
      runSh: `claude --name "RUN-015" --worktree`,
    });

    const result = await collectDispatchDetail(paths(), "RUN-015", {
      checkPid: false,
      skipGit: true,
    });

    expect(result!.worktreeBranch).toBe("worktree-run-015");
  });

  test("crashed status when process is dead", async () => {
    await createRun("RUN-016", {
      status: "running",
      pid: "999999999", // very unlikely to be alive
    });

    const result = await collectDispatchDetail(paths(), "RUN-016", {
      checkPid: true,
      skipGit: true,
    });

    expect(result!.status).toBe("crashed");
  });

  test("runDir is set correctly", async () => {
    await createRun("RUN-017", { status: "failed" });

    const result = await collectDispatchDetail(paths(), "RUN-017", {
      checkPid: false,
      skipGit: true,
    });

    expect(result!.runDir).toBe(join(home, "runs", "RUN-017"));
  });

  // ------ Integration: collect + render ------

  test("collect → render round-trip produces valid HTML", async () => {
    const goal = [
      "# Goal",
      "",
      "Implement TK-099: Test round-trip",
      "",
      "Build something with `code blocks` and:",
      "",
      "```typescript",
      "const x = 42;",
      "```",
    ].join("\n");

    await createRun("RUN-020", {
      status: "complete",
      goal,
      outputLog: "All done.\n",
      runSh: `--name "RUN-020"`,
    });

    const detail = await collectDispatchDetail(paths(), "RUN-020", {
      checkPid: false,
      skipGit: true,
    });

    expect(detail).not.toBeNull();
    const html = renderDispatchFragment(detail!);

    expect(html).toContain("RUN-020");
    expect(html).toContain("Shipped");
    expect(html).toContain("TK-099");
    expect(html).toContain("const x = 42");
    expect(html).toContain("All done.");
  });
});
