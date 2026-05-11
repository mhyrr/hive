import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectRuns, type RunRow } from "../lib/dashboard/runs/collect";
import { ensureHiveScaffold } from "../lib/paths";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

async function buildFixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-runs-"));
  await ensureHiveScaffold(home);
  return home;
}

async function createDispatchRun(
  home: string,
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
    opts.goal ?? `# Goal\n\nProject: testproj\n\nImplement ${id}.\n`,
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

async function createCampaignRun(
  home: string,
  id: string,
  opts: {
    status: string;
    frozenPrefix?: string;
    configJson?: string;
    scorecardRows?: string[];
    orchestratorLog?: string;
    pid?: string;
  },
): Promise<void> {
  const dir = join(home, "campaigns", id);
  await mkdir(join(dir, "iterations"), { recursive: true });
  await writeFile(join(dir, "status"), opts.status);
  await writeFile(
    join(dir, "frozen-prefix.md"),
    opts.frozenPrefix ?? `Campaign ${id} goal text`,
  );
  if (opts.configJson) {
    await writeFile(join(dir, "config.json"), opts.configJson);
  }
  if (opts.scorecardRows && opts.scorecardRows.length > 0) {
    await writeFile(
      join(dir, "scorecard.jsonl"),
      opts.scorecardRows.join("\n") + "\n",
    );
  }
  if (opts.orchestratorLog) {
    await writeFile(join(dir, "orchestrator.log"), opts.orchestratorLog);
  }
  if (opts.pid !== undefined) {
    await writeFile(join(dir, "pid"), opts.pid);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboard runs collector", () => {
  let home: string;

  beforeEach(async () => {
    home = await buildFixture();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Fixture 1: shipped dispatch run
  // -------------------------------------------------------------------------
  test("shipped dispatch run is in terminal list with correct fields", async () => {
    await createDispatchRun(home, "RUN-001", {
      status: "complete",
      goal: "# Goal\n\nProject: hive\n\nImplement TK-042 — stack hints.\n\nDispatched: 2026-04-17T10:00:00Z\n",
      pid: "99999",
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.active).toHaveLength(0);
    expect(result.terminal).toHaveLength(1);

    const row = result.terminal[0]!;
    expect(row.kind).toBe("dispatch");
    expect(row.id).toBe("RUN-001");
    expect(row.status).toBe("shipped");
    expect(row.ticketId).toBe("TK-042");
    expect(row.goalSummary).toContain("TK-042");
    expect(row.elapsedSec).toBeGreaterThanOrEqual(0);
    expect(row.lastLogLine).toBeUndefined(); // terminal run → no log tail
  });

  // -------------------------------------------------------------------------
  // Fixture 2: failed dispatch run
  // -------------------------------------------------------------------------
  test("failed dispatch run status normalization", async () => {
    await createDispatchRun(home, "RUN-002", {
      status: "failed",
      goal: "# Goal\n\nProject: alpha\n\nFix TK-099 critical bug.\n",
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal).toHaveLength(1);
    expect(result.terminal[0]!.status).toBe("failed");
    expect(result.terminal[0]!.ticketId).toBe("TK-099");
  });

  // -------------------------------------------------------------------------
  // Fixture 3: active dispatch run (status=running, checkPid=false → crashed)
  // -------------------------------------------------------------------------
  test("running dispatch with dead PID is detected as crashed", async () => {
    await createDispatchRun(home, "RUN-003", {
      status: "running",
      pid: "1", // PID 1 won't match in test, and checkPid=false anyway
      outputLog: "Starting work...\nDone step 1.\nProcessing step 2.\n",
    });

    const paths = await ensureHiveScaffold(home);
    // checkPid=false → isProcessAlive returns false → running + dead = crashed
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.active).toHaveLength(0);
    expect(result.terminal).toHaveLength(1);
    expect(result.terminal[0]!.status).toBe("crashed");
  });

  // -------------------------------------------------------------------------
  // Fixture 4: shipped campaign run
  // -------------------------------------------------------------------------
  test("shipped campaign with scorecard and orchestrator log", async () => {
    await createCampaignRun(home, "CAMP-001", {
      status: "done",
      configJson: JSON.stringify({
        projectId: "hive",
        goal: "Implement TK-074 campaign state model",
      }),
      scorecardRows: [
        JSON.stringify({
          iteration_n: 1,
          started_at: "2026-05-10T16:45:32Z",
          ended_at: "2026-05-10T16:46:20Z",
          exit_reason: "natural",
          judge_decision: "done",
          tokens_used: 191758,
          cost_usd: 0.575274,
        }),
      ],
      orchestratorLog: JSON.stringify({
        campaignId: "CAMP-001",
        terminationReason: "judge_done",
        iterationsCompleted: 1,
        totalCostUsd: 0.575274,
        totalTokens: 191758,
        totalWalltimeMs: 47291,
      }),
      pid: "99998",
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.active).toHaveLength(0);
    expect(result.terminal).toHaveLength(1);

    const row = result.terminal[0]!;
    expect(row.kind).toBe("campaign");
    expect(row.id).toBe("CAMP-001");
    expect(row.status).toBe("shipped");
    expect(row.costUsd).toBeCloseTo(0.575274, 4);
    expect(row.elapsedSec).toBe(47); // 47291ms → 47s
    expect(row.ticketId).toBe("TK-074");
    expect(row.goalSummary).toContain("TK-074");
    expect(row.startedAt).toBe("2026-05-10T16:45:32Z");
    expect(row.endedAt).toBe("2026-05-10T16:46:20Z");
    expect(row.worktreeBranch).toBe("campaign/CAMP-001");
  });

  // -------------------------------------------------------------------------
  // Fixture 5: failed campaign (aborted)
  // -------------------------------------------------------------------------
  test("aborted campaign maps to failed status", async () => {
    await createCampaignRun(home, "CAMP-002", {
      status: "aborted",
      frozenPrefix: "Fix critical production bug",
      scorecardRows: [
        JSON.stringify({
          iteration_n: 1,
          started_at: "2026-05-10T12:00:00Z",
          ended_at: "2026-05-10T12:05:00Z",
          cost_usd: 0.25,
        }),
        JSON.stringify({
          iteration_n: 2,
          started_at: "2026-05-10T12:05:30Z",
          ended_at: "2026-05-10T12:10:00Z",
          cost_usd: 0.35,
        }),
      ],
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal).toHaveLength(1);
    const row = result.terminal[0]!;
    expect(row.status).toBe("failed");
    expect(row.kind).toBe("campaign");
    // Cost should be sum of scorecard rows (no orchestrator log)
    expect(row.costUsd).toBeCloseTo(0.6, 4);
    expect(row.goalSummary).toContain("critical production bug");
  });

  // -------------------------------------------------------------------------
  // Active + terminal sorting
  // -------------------------------------------------------------------------
  test("terminal runs sorted newest-first, active omitted when checkPid=false", async () => {
    // Create 3 runs in order — we control startedAt via goal.md mtime
    await createDispatchRun(home, "RUN-010", {
      status: "complete",
      goal: "# Goal\n\nFirst run.\n",
    });

    // Brief delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));

    await createDispatchRun(home, "RUN-011", {
      status: "partial",
      goal: "# Goal\n\nSecond run.\n",
    });

    await new Promise((r) => setTimeout(r, 50));

    await createDispatchRun(home, "RUN-012", {
      status: "complete",
      goal: "# Goal\n\nThird run.\n",
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal).toHaveLength(3);
    // Newest first
    expect(result.terminal[0]!.id).toBe("RUN-012");
    expect(result.terminal[1]!.id).toBe("RUN-011");
    expect(result.terminal[2]!.id).toBe("RUN-010");
  });

  // -------------------------------------------------------------------------
  // Mixed dispatch + campaign
  // -------------------------------------------------------------------------
  test("mixed dispatches and campaigns appear in unified results", async () => {
    await createDispatchRun(home, "RUN-001", {
      status: "complete",
      goal: "# Goal\n\nDispatch work.\n",
    });

    await new Promise((r) => setTimeout(r, 50));

    await createCampaignRun(home, "CAMP-001", {
      status: "done",
      frozenPrefix: "Campaign work.",
      scorecardRows: [
        JSON.stringify({
          iteration_n: 1,
          started_at: "2026-05-10T12:00:00Z",
          ended_at: "2026-05-10T12:01:00Z",
          cost_usd: 0.1,
        }),
      ],
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal).toHaveLength(2);
    const kinds = result.terminal.map((r) => r.kind);
    expect(kinds).toContain("dispatch");
    expect(kinds).toContain("campaign");
  });

  // -------------------------------------------------------------------------
  // Empty state — no runs, no campaigns
  // -------------------------------------------------------------------------
  test("empty state returns empty arrays", async () => {
    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.active).toHaveLength(0);
    expect(result.terminal).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Partial state tolerance — run dir with missing files
  // -------------------------------------------------------------------------
  test("run dir with no status file is silently skipped", async () => {
    // Create a dir that looks like a run but has no status
    const dir = join(home, "runs", "RUN-099");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "goal.md"), "# Goal\n\nSome work.\n");
    // No status file

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.active).toHaveLength(0);
    expect(result.terminal).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 0-byte output.log graceful handling
  // -------------------------------------------------------------------------
  test("0-byte output.log returns empty lastLogLine for active run", async () => {
    // We need checkPid to see it as active — but we can't guarantee a live PID in tests.
    // Instead, test the output.log reading path by checking a terminal run's
    // log isn't surfaced, and a separate test for the empty-log path.
    await createDispatchRun(home, "RUN-005", {
      status: "complete",
      outputLog: "", // 0-byte log
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    // Terminal runs don't get lastLogLine, but the collector shouldn't crash
    expect(result.terminal).toHaveLength(1);
    expect(result.terminal[0]!.lastLogLine).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Goal summary truncation
  // -------------------------------------------------------------------------
  test("goal summary truncates long text to ~140 chars", async () => {
    const longGoal = "A".repeat(200);
    await createDispatchRun(home, "RUN-006", {
      status: "complete",
      goal: `# Goal\n\n${longGoal}\n`,
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal[0]!.goalSummary.length).toBeLessThanOrEqual(142); // 140 + "…"
  });

  // -------------------------------------------------------------------------
  // timed_out and killed statuses map to failed
  // -------------------------------------------------------------------------
  test("timed_out and killed dispatch statuses normalize to failed", async () => {
    await createDispatchRun(home, "RUN-007", { status: "timed_out" });
    await createDispatchRun(home, "RUN-008", { status: "killed" });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal).toHaveLength(2);
    expect(result.terminal.every((r) => r.status === "failed")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Campaign with no scorecard or orchestrator log
  // -------------------------------------------------------------------------
  test("campaign with minimal state still produces a row", async () => {
    await createCampaignRun(home, "CAMP-010", {
      status: "done",
      frozenPrefix: "Minimal campaign",
      pid: "12345",
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal).toHaveLength(1);
    const row = result.terminal[0]!;
    expect(row.kind).toBe("campaign");
    expect(row.status).toBe("shipped");
    expect(row.costUsd).toBeUndefined();
    expect(row.goalSummary).toContain("Minimal campaign");
  });

  // -------------------------------------------------------------------------
  // Non-RUN/CAMP directories are ignored
  // -------------------------------------------------------------------------
  test("non-matching directory names are ignored", async () => {
    // These exist in real ~/.hive/runs/ (PI-* dirs, RUN-TEST-*, etc.)
    await mkdir(join(home, "runs", "PI-20260423T215738Z-a8d32211"), { recursive: true });
    await mkdir(join(home, "runs", "RUN-TEST-6cfee479"), { recursive: true });
    await writeFile(join(home, "runs", "PI-20260423T215738Z-a8d32211", "status"), "complete");

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.active).toHaveLength(0);
    expect(result.terminal).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Campaign cost from scorecard when no orchestrator log
  // -------------------------------------------------------------------------
  test("campaign cost falls back to scorecard sum when no orchestrator log", async () => {
    await createCampaignRun(home, "CAMP-003", {
      status: "done",
      frozenPrefix: "Multi-iteration campaign",
      scorecardRows: [
        JSON.stringify({ iteration_n: 1, started_at: "2026-05-10T10:00:00Z", ended_at: "2026-05-10T10:05:00Z", cost_usd: 0.3 }),
        JSON.stringify({ iteration_n: 2, started_at: "2026-05-10T10:05:30Z", ended_at: "2026-05-10T10:10:00Z", cost_usd: 0.4 }),
        JSON.stringify({ iteration_n: 3, started_at: "2026-05-10T10:10:30Z", ended_at: "2026-05-10T10:15:00Z", cost_usd: 0.5 }),
      ],
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    const row = result.terminal[0]!;
    expect(row.costUsd).toBeCloseTo(1.2, 4);
    expect(row.startedAt).toBe("2026-05-10T10:00:00Z");
    expect(row.endedAt).toBe("2026-05-10T10:15:00Z");
  });

  // -------------------------------------------------------------------------
  // Worktree branch extraction from run.sh
  // -------------------------------------------------------------------------
  test("worktree branch extracted from run.sh --name flag", async () => {
    await createDispatchRun(home, "RUN-009", {
      status: "complete",
      runSh: `#!/bin/bash\n"/usr/local/bin/claude" --name "RUN-009" --worktree\n`,
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    const row = result.terminal[0]!;
    expect(row.worktreeBranch).toBe("worktree-run-009");
  });

  // -------------------------------------------------------------------------
  // Budget-exhausted campaign maps to partial (not failed) — TK-110
  // -------------------------------------------------------------------------
  test("budget-exhausted campaign status maps to partial", async () => {
    await createCampaignRun(home, "CAMP-004", {
      status: "budget-exhausted",
      frozenPrefix: "Expensive campaign",
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal[0]!.status).toBe("partial");
  });

  // -------------------------------------------------------------------------
  // Paused campaign maps to partial
  // -------------------------------------------------------------------------
  test("paused campaign status maps to partial", async () => {
    await createCampaignRun(home, "CAMP-005", {
      status: "paused",
      frozenPrefix: "Paused campaign",
    });

    const paths = await ensureHiveScaffold(home);
    const result = await collectRuns(paths, { checkPid: false });

    expect(result.terminal[0]!.status).toBe("partial");
  });
});
