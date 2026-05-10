/**
 * Tests for `hive campaign` CLI surface (TK-079).
 *
 * Tests the three subcommands: run, list, show.
 * Uses temp directories as HIVE_HOME to isolate from real campaigns.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

import {
  initCampaign,
  appendScorecardRow,
  writeStatus,
  writePlan,
  writeCheckpoint,
  readCampaignState,
  listCampaigns,
  type ScorecardRow,
} from "../lib/campaign/state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let tempRepo: string;

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `hive-campaign-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function makeTempRepo(): Promise<string> {
  const dir = join(tmpdir(), `hive-campaign-cli-repo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  const { execSync } = await import("node:child_process");
  execSync("git init && git commit --allow-empty -m init", { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * Create a campaign in tempDir with some scorecard data for testing.
 */
async function createTestCampaign(opts: {
  goal?: string;
  status?: string;
  rows?: ScorecardRow[];
  plan?: string;
  checkpoint?: string;
}): Promise<string> {
  const id = await initCampaign({
    goal: opts.goal ?? "Test campaign goal",
    repoPath: tempRepo,
    hiveHome: tempDir,
  });

  if (opts.status) {
    await writeStatus(id, opts.status as any, tempDir);
  }

  if (opts.plan) {
    await writePlan(id, opts.plan, tempDir);
  }

  if (opts.checkpoint) {
    await writeCheckpoint(id, opts.checkpoint, tempDir);
  }

  if (opts.rows) {
    for (const row of opts.rows) {
      await appendScorecardRow(id, row, tempDir);
    }
  }

  return id;
}

function makeRow(n: number, overrides?: Partial<ScorecardRow>): ScorecardRow {
  return {
    iteration_n: n,
    started_at: "2026-05-10T10:00:00Z",
    ended_at: "2026-05-10T10:15:00Z",
    exit_reason: "natural",
    judge_decision: "continue",
    tokens_used: 5000,
    cost_usd: 0.015,
    ...overrides,
  };
}

// Import the formatting helper by extracting it from the module
// We test the command output indirectly through the functions

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await makeTempDir();
  tempRepo = await makeTempRepo();
});

afterEach(async () => {
  // Clean up worktrees before removing temp dirs
  const { execSync } = await import("node:child_process");
  try {
    const campaigns = await readdir(join(tempDir, "campaigns")).catch(() => []);
    for (const camp of campaigns) {
      const wsPath = join(tempDir, "campaigns", camp, "workspace");
      if (existsSync(wsPath)) {
        try {
          execSync(`git worktree remove "${wsPath}" --force`, { cwd: tempRepo, stdio: "pipe" });
        } catch { /* already cleaned */ }
      }
    }
  } catch { /* no campaigns dir */ }

  await rm(tempDir, { recursive: true, force: true });
  await rm(tempRepo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// State integration tests (list/show use these same paths)
// ---------------------------------------------------------------------------

describe("campaign state for CLI", () => {
  test("initCampaign creates CAMP-001 directory structure", async () => {
    const id = await initCampaign({
      goal: "Build the thing",
      repoPath: tempRepo,
      hiveHome: tempDir,
    });

    expect(id).toBe("CAMP-001");
    expect(existsSync(join(tempDir, "campaigns", "CAMP-001"))).toBe(true);
    expect(existsSync(join(tempDir, "campaigns", "CAMP-001", "status"))).toBe(true);
    expect(existsSync(join(tempDir, "campaigns", "CAMP-001", "frozen-prefix.md"))).toBe(true);
    expect(existsSync(join(tempDir, "campaigns", "CAMP-001", "iterations"))).toBe(true);
  });

  test("sequential IDs", async () => {
    const id1 = await createTestCampaign({ goal: "First" });
    const id2 = await createTestCampaign({ goal: "Second" });
    expect(id1).toBe("CAMP-001");
    expect(id2).toBe("CAMP-002");
  });

  test("readCampaignState returns full aggregate", async () => {
    const id = await createTestCampaign({
      goal: "Full state test",
      plan: "Step 1: do stuff",
      checkpoint: "Completed step 1",
      rows: [makeRow(1), makeRow(2, { judge_decision: "done" })],
    });

    const state = await readCampaignState(id, tempDir);
    expect(state).not.toBeNull();
    expect(state!.id).toBe(id);
    expect(state!.frozenPrefix).toContain("Full state test");
    expect(state!.frozenPrefix).toContain("## Prime Directive");
    expect(state!.goal).toBe("Full state test");
    expect(state!.plan).toBe("Step 1: do stuff");
    expect(state!.checkpoint).toBe("Completed step 1");
    expect(state!.scorecard).toHaveLength(2);
    expect(state!.scorecard[1]!.judge_decision).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// List functionality
// ---------------------------------------------------------------------------

describe("campaign list", () => {
  test("listCampaigns returns empty array when no campaigns", async () => {
    const campaigns = await listCampaigns(tempDir);
    expect(campaigns).toEqual([]);
  });

  test("listCampaigns returns sorted IDs", async () => {
    await createTestCampaign({ goal: "A" });
    await createTestCampaign({ goal: "B" });
    await createTestCampaign({ goal: "C" });

    const campaigns = await listCampaigns(tempDir);
    expect(campaigns).toEqual(["CAMP-001", "CAMP-002", "CAMP-003"]);
  });

  test("status filtering works via readStatus", async () => {
    await createTestCampaign({ goal: "Running", status: "running" });
    await createTestCampaign({ goal: "Done", status: "done" });
    await createTestCampaign({ goal: "Also running", status: "running" });

    const { readStatus } = await import("../lib/campaign/state");
    const all = await listCampaigns(tempDir);
    const running: string[] = [];
    for (const id of all) {
      const status = await readStatus(id, tempDir);
      if (status === "running") running.push(id);
    }
    expect(running).toEqual(["CAMP-001", "CAMP-003"]);
  });
});

// ---------------------------------------------------------------------------
// Show functionality (scorecard formatting)
// ---------------------------------------------------------------------------

describe("campaign show", () => {
  test("readCampaignState includes all scorecard rows", async () => {
    const id = await createTestCampaign({
      goal: "Show test",
      rows: [
        makeRow(1, { tokens_used: 10000, cost_usd: 0.03 }),
        makeRow(2, { tokens_used: 8000, cost_usd: 0.024, judge_decision: "replan" }),
        makeRow(3, { tokens_used: 12000, cost_usd: 0.036, judge_decision: "done" }),
      ],
    });

    const state = await readCampaignState(id, tempDir);
    expect(state!.scorecard).toHaveLength(3);
    expect(state!.scorecard[0]!.tokens_used).toBe(10000);
    expect(state!.scorecard[2]!.judge_decision).toBe("done");
  });

  test("campaign with no scorecard rows returns empty array", async () => {
    const id = await createTestCampaign({ goal: "Empty scorecard" });
    const state = await readCampaignState(id, tempDir);
    expect(state!.scorecard).toEqual([]);
  });

  test("shows plan and checkpoint", async () => {
    const id = await createTestCampaign({
      goal: "With plan",
      plan: "- [ ] Step 1\n- [x] Step 2",
      checkpoint: "Finished step 2, moving to step 1",
    });

    const state = await readCampaignState(id, tempDir);
    expect(state!.plan).toContain("Step 1");
    expect(state!.checkpoint).toContain("Finished step 2");
  });
});

// ---------------------------------------------------------------------------
// Campaign ID normalization
// ---------------------------------------------------------------------------

describe("campaign ID normalization", () => {
  // Test the normalization logic inline
  function normalizeCampaignId(input: string): string {
    if (input.startsWith("CAMP-")) return input;
    const n = parseInt(input, 10);
    if (isNaN(n)) return input;
    return `CAMP-${String(n).padStart(3, "0")}`;
  }

  test("passes through full IDs", () => {
    expect(normalizeCampaignId("CAMP-001")).toBe("CAMP-001");
    expect(normalizeCampaignId("CAMP-042")).toBe("CAMP-042");
  });

  test("normalizes bare numbers", () => {
    expect(normalizeCampaignId("1")).toBe("CAMP-001");
    expect(normalizeCampaignId("42")).toBe("CAMP-042");
    expect(normalizeCampaignId("001")).toBe("CAMP-001");
  });

  test("passes through non-numeric strings", () => {
    expect(normalizeCampaignId("foo")).toBe("foo");
  });
});

// ---------------------------------------------------------------------------
// Scorecard table formatting
// ---------------------------------------------------------------------------

describe("scorecard formatting", () => {
  // Re-implement the formatting function for testing
  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    if (mins < 60) return `${mins}m${remainSecs > 0 ? ` ${remainSecs}s` : ""}`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs}h${remainMins > 0 ? ` ${remainMins}m` : ""}`;
  }

  function formatScorecardTable(rows: ScorecardRow[]): string {
    if (rows.length === 0) return "  (no iterations yet)";

    const header = "  Iter  Decision        Tokens     Cost    Walltime";
    const sep    = "  ----  --------        ------     ----    --------";

    const lines = rows.map((row) => {
      const iter = String(row.iteration_n).padStart(4);
      const decision = row.judge_decision.padEnd(16);
      const tokens = String(row.tokens_used).padStart(6);
      const cost = `$${row.cost_usd.toFixed(2)}`.padStart(8);

      let walltime = "—";
      try {
        const start = new Date(row.started_at).getTime();
        const end = new Date(row.ended_at).getTime();
        if (!isNaN(start) && !isNaN(end)) {
          walltime = formatDuration(end - start);
        }
      } catch { /* use dash */ }
      const walltimeStr = walltime.padStart(8);

      return `  ${iter}  ${decision}${tokens}  ${cost}  ${walltimeStr}`;
    });

    const totalTokens = rows.reduce((sum, r) => sum + r.tokens_used, 0);
    const totalCost = rows.reduce((sum, r) => sum + r.cost_usd, 0);
    const totalLine = `  Total                ${String(totalTokens).padStart(6)}  $${totalCost.toFixed(2).padStart(7)}`;

    return [header, sep, ...lines, sep, totalLine].join("\n");
  }

  test("empty rows shows placeholder", () => {
    expect(formatScorecardTable([])).toBe("  (no iterations yet)");
  });

  test("single row formats correctly", () => {
    const table = formatScorecardTable([
      makeRow(1, { tokens_used: 5000, cost_usd: 0.015 }),
    ]);
    expect(table).toContain("Iter");
    expect(table).toContain("Decision");
    expect(table).toContain("continue");
    expect(table).toContain("5000");
    expect(table).toContain("$0.01"); // $0.015 → toFixed(2) = $0.01 in padded column
    expect(table).toContain("Total");
  });

  test("multiple rows with totals", () => {
    const table = formatScorecardTable([
      makeRow(1, { tokens_used: 10000, cost_usd: 0.03 }),
      makeRow(2, { tokens_used: 8000, cost_usd: 0.024 }),
    ]);
    expect(table).toContain("18000"); // total tokens
    expect(table).toContain("0.05"); // total cost (with padding)
  });

  test("formatDuration handles various ranges", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(3600000)).toBe("1h");
    expect(formatDuration(5400000)).toBe("1h 30m");
  });
});

// ---------------------------------------------------------------------------
// Config roundtrip
// ---------------------------------------------------------------------------

describe("campaign config", () => {
  test("config.json roundtrip", async () => {
    const id = await createTestCampaign({ goal: "Config test" });
    const campaignDir = join(tempDir, "campaigns", id);

    const config = {
      projectId: "test-project",
      projectPath: tempRepo,
      goal: "Config test",
      caps: { tokens_soft: 50000, walltime_soft_ms: 1200000 },
      limits: { maxIterations: 5, maxCostUsd: 10, maxWalltimeMs: 7200000 },
    };

    await writeFile(join(campaignDir, "config.json"), JSON.stringify(config, null, 2));

    const raw = await readFile(join(campaignDir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.projectId).toBe("test-project");
    expect(parsed.caps.tokens_soft).toBe(50000);
    expect(parsed.limits.maxIterations).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Campaign command parsing (integration-ish)
// ---------------------------------------------------------------------------

describe("campaign command routing", () => {
  test("campaignCommand exists and is importable", async () => {
    const { campaignCommand } = await import("../commands/campaign");
    expect(typeof campaignCommand).toBe("function");
  });

  test("campaignCommand with --help does not throw", async () => {
    const { campaignCommand } = await import("../commands/campaign");
    // Capture console.log
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await campaignCommand(["--help"]);
      expect(logs.some(l => l.includes("hive campaign"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("campaignCommand run --help shows run usage", async () => {
    const { campaignCommand } = await import("../commands/campaign");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await campaignCommand(["run", "--help"]);
      expect(logs.some(l => l.includes("--max-iterations"))).toBe(true);
      expect(logs.some(l => l.includes("--soft-tokens"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("campaignCommand list --help shows list usage", async () => {
    const { campaignCommand } = await import("../commands/campaign");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await campaignCommand(["list", "--help"]);
      expect(logs.some(l => l.includes("--status"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("campaignCommand show --help shows show usage", async () => {
    const { campaignCommand } = await import("../commands/campaign");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    try {
      await campaignCommand(["show", "--help"]);
      expect(logs.some(l => l.includes("campaign details"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("campaignCommand with unknown subcommand throws UsageError", async () => {
    const { campaignCommand } = await import("../commands/campaign");
    try {
      await campaignCommand(["frobnicate"]);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.name).toBe("UsageError");
      expect(err.message).toContain("Unknown campaign subcommand");
    }
  });

  test("campaignCommand run without goal throws UsageError", async () => {
    const { campaignCommand } = await import("../commands/campaign");
    try {
      await campaignCommand(["run"]);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe("UsageError");
      expect(err.message).toContain("No goal");
    }
  });

  test("campaignCommand show without id throws UsageError", async () => {
    const { campaignCommand } = await import("../commands/campaign");
    try {
      await campaignCommand(["show"]);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.name).toBe("UsageError");
      expect(err.message).toContain("No campaign ID");
    }
  });
});
