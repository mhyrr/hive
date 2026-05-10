/**
 * Tests for campaign MCP tool surface (TK-080).
 *
 * Tests show_campaign and list_campaigns against real campaign state on disk.
 * start_campaign is tested for validation only (spawning detached is an
 * integration concern tested via the smoke test).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  initCampaign,
  writeStatus,
  writePlan,
  writeCheckpoint,
  appendScorecardRow,
  listCampaigns,
  readCampaignState,
  readScorecard,
  type ScorecardRow,
} from "../lib/campaign/state";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let hiveHome: string;
let repoPath: string;

function makeRow(n: number, overrides?: Partial<ScorecardRow>): ScorecardRow {
  return {
    iteration_n: n,
    started_at: `2026-05-09T0${n}:00:00Z`,
    ended_at: `2026-05-09T0${n}:25:00Z`,
    exit_reason: "natural",
    judge_decision: "continue",
    tokens_used: 50000,
    cost_usd: 0.15,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hive-campaign-mcp-"));
  hiveHome = join(tmpDir, ".hive");
  repoPath = join(tmpDir, "repo");

  await mkdir(repoPath, { recursive: true });
  execSync("git init && git commit --allow-empty -m 'init'", {
    cwd: repoPath,
    stdio: "pipe",
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// show_campaign behavior (exercising the state reading + formatting)
// ---------------------------------------------------------------------------

describe("show_campaign data shape", () => {
  test("returns structured data for an existing campaign", async () => {
    const id = await initCampaign({ goal: "Build the widget", repoPath, hiveHome });
    await writePlan(id, "Step 1: scaffold\nStep 2: implement", hiveHome);
    await writeCheckpoint(id, "Completed scaffold", hiveHome);
    await appendScorecardRow(id, makeRow(1), hiveHome);
    await appendScorecardRow(id, makeRow(2, { judge_decision: "done", cost_usd: 0.25 }), hiveHome);

    // Simulate what the MCP tool does internally
    const state = await readCampaignState(id, hiveHome);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("running");
    expect(state!.frozenPrefix).toContain("Build the widget");
    expect(state!.goal).toBe("Build the widget");
    expect(state!.plan).toBe("Step 1: scaffold\nStep 2: implement");
    expect(state!.checkpoint).toBe("Completed scaffold");

    const scorecard = await readScorecard(id, hiveHome);
    expect(scorecard).toHaveLength(2);

    const totalCost = scorecard.reduce((sum, row) => sum + row.cost_usd, 0);
    expect(totalCost).toBeCloseTo(0.40, 2);

    const totalTokens = scorecard.reduce((sum, row) => sum + row.tokens_used, 0);
    expect(totalTokens).toBe(100000);
  });

  test("returns null for non-existent campaign", async () => {
    const state = await readCampaignState("CAMP-999", hiveHome);
    expect(state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list_campaigns behavior
// ---------------------------------------------------------------------------

describe("list_campaigns data shape", () => {
  test("lists all campaigns", async () => {
    await initCampaign({ goal: "First campaign", repoPath, hiveHome });
    await initCampaign({ goal: "Second campaign", repoPath, hiveHome });

    const ids = await listCampaigns(hiveHome);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("CAMP-001");
    expect(ids).toContain("CAMP-002");
  });

  test("returns empty array when no campaigns exist", async () => {
    const ids = await listCampaigns(hiveHome);
    expect(ids).toHaveLength(0);
  });

  test("status filter works via state reading", async () => {
    const id1 = await initCampaign({ goal: "Running campaign", repoPath, hiveHome });
    const id2 = await initCampaign({ goal: "Done campaign", repoPath, hiveHome });
    await writeStatus(id2, "done", hiveHome);

    const ids = await listCampaigns(hiveHome);
    expect(ids).toHaveLength(2);

    // Simulate MCP filter logic
    const results: Array<{ id: string; status: string }> = [];
    for (const id of ids) {
      const state = await readCampaignState(id, hiveHome);
      if (state && state.status === "done") {
        results.push({ id, status: state.status });
      }
    }
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("CAMP-002");
  });
});

// ---------------------------------------------------------------------------
// start_campaign validation (no actual spawn)
// ---------------------------------------------------------------------------

describe("start_campaign prerequisites", () => {
  test("initCampaign creates the campaign directory", async () => {
    const id = await initCampaign({ goal: "Test goal", repoPath, hiveHome });
    expect(id).toMatch(/^CAMP-\d{3}$/);

    const state = await readCampaignState(id, hiveHome);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("running");
    expect(state!.frozenPrefix).toContain("Test goal");
    expect(state!.frozenPrefix).toContain("## Prime Directive");
    expect(state!.goal).toBe("Test goal");
  });

  test("sequential IDs are assigned", async () => {
    const id1 = await initCampaign({ goal: "First", repoPath, hiveHome });
    const id2 = await initCampaign({ goal: "Second", repoPath, hiveHome });
    const id3 = await initCampaign({ goal: "Third", repoPath, hiveHome });

    expect(id1).toBe("CAMP-001");
    expect(id2).toBe("CAMP-002");
    expect(id3).toBe("CAMP-003");
  });
});
