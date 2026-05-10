/**
 * Campaign state directory and data model.
 *
 * Pure I/O helpers for managing campaign state on disk. No process spawning
 * beyond `git worktree` commands. The orchestrator (C3) and judge (C4) consume
 * these helpers; they don't live here.
 *
 * On-disk layout (per spec §state layout):
 *
 *   ~/.hive/campaigns/CAMP-001/
 *     frozen-prefix.md    # byte-stable: prime directive + scope fence + scorecard schema
 *     plan.md             # mutable: current decomposition
 *     checkpoint.md       # latest iteration handoff (replaced each iteration)
 *     scorecard.jsonl     # append-only, one row per iteration
 *     status              # running | paused | done | aborted | budget-exhausted
 *     iterations/
 *       1/                # per-iteration artifacts
 *       2/ ...
 *     workspace/          # shared git worktree (campaign branch)
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { resolveHiveHome } from "../paths";
import { toIsoTimestamp } from "../time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Campaign status values. */
export type CampaignStatus =
  | "running"
  | "paused"
  | "done"
  | "aborted"
  | "budget-exhausted";

/**
 * Scorecard row — one per iteration, appended to scorecard.jsonl.
 *
 * Schema fields:
 * - iteration_n:    Sequential iteration number (1-based)
 * - started_at:     ISO timestamp when the iteration started
 * - ended_at:       ISO timestamp when the iteration ended
 * - exit_reason:    Why the iteration terminated (natural | timeout | hard-cap | error)
 * - judge_decision: The judge's recommendation (continue | replan | expand-scope | pause-for-human | abort | done)
 * - tokens_used:    Total tokens consumed in this iteration
 * - cost_usd:       Estimated cost in USD for this iteration
 */
export type ScorecardRow = {
  iteration_n: number;
  started_at: string;
  ended_at: string;
  exit_reason: "natural" | "timeout" | "hard-cap" | "error";
  judge_decision:
    | "continue"
    | "replan"
    | "expand-scope"
    | "pause-for-human"
    | "abort"
    | "done";
  tokens_used: number;
  cost_usd: number;
};

/**
 * CampaignState — the aggregate type representing a campaign's full state.
 * Used by C3 (orchestrator), C4 (judge), and C5 (executor) consumers.
 */
export type CampaignState = {
  id: string;
  dir: string;
  workspacePath: string;
  status: CampaignStatus;
  frozenPrefix: string | null;
  plan: string | null;
  checkpoint: string | null;
  scorecard: ScorecardRow[];
  iterationCount: number;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function campaignsRoot(home?: string): string {
  return join(home || resolveHiveHome(), "campaigns");
}

function campaignDir(id: string, home?: string): string {
  return join(campaignsRoot(home), id);
}

// ---------------------------------------------------------------------------
// ID generation — sequential CAMP-NNN
// ---------------------------------------------------------------------------

async function nextCampaignId(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root).catch(() => []);
  const ids = entries
    .filter((e) => e.startsWith("CAMP-"))
    .map((e) => parseInt(e.replace("CAMP-", ""), 10))
    .filter((n) => !isNaN(n));
  const next = ids.length > 0 ? Math.max(...ids) + 1 : 1;
  return `CAMP-${String(next).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export type InitCampaignOpts = {
  /** The high-level goal (prime directive). */
  goal: string;
  /** Absolute path to the project's git repo (worktree created from here). */
  repoPath: string;
  /** Override HIVE_HOME for testing. */
  hiveHome?: string;
};

/**
 * Initialize a new campaign: create directory tree, git worktree, and status file.
 * Returns the campaign ID (e.g. "CAMP-001").
 */
export async function initCampaign(opts: InitCampaignOpts): Promise<string> {
  const { goal, repoPath, hiveHome } = opts;
  const root = campaignsRoot(hiveHome);
  const id = await nextCampaignId(root);
  const dir = join(root, id);

  // Create directory structure
  await mkdir(join(dir, "iterations"), { recursive: true });

  // Create git worktree for the campaign branch
  const workspacePath = join(dir, "workspace");
  const branchName = `campaign/${id}`;

  execSync(`git worktree add -b "${branchName}" "${workspacePath}" HEAD`, {
    cwd: repoPath,
    stdio: "pipe",
  });

  // Write initial status
  await writeFile(join(dir, "status"), "running", "utf-8");

  // Write the frozen prefix (prime directive) — this is the initial write
  await writeFile(join(dir, "frozen-prefix.md"), goal, "utf-8");

  return id;
}

// ---------------------------------------------------------------------------
// Frozen Prefix (write-once)
// ---------------------------------------------------------------------------

/**
 * Write the frozen prefix. Throws if already exists — immutability enforced.
 * Use initCampaign for the initial write; this is for explicit (re)freeze only.
 */
export async function freezePrefix(
  id: string,
  body: string,
  hiveHome?: string,
): Promise<void> {
  const path = join(campaignDir(id, hiveHome), "frozen-prefix.md");
  if (existsSync(path)) {
    throw new Error(
      `Frozen prefix already exists for ${id}. Mutation requires explicit --reset (not in V1).`,
    );
  }
  await writeFile(path, body, "utf-8");
}

/**
 * Read the frozen prefix. Returns null if campaign doesn't exist.
 */
export async function readFrozenPrefix(
  id: string,
  hiveHome?: string,
): Promise<string | null> {
  const path = join(campaignDir(id, hiveHome), "frozen-prefix.md");
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Checkpoint (replaced each iteration)
// ---------------------------------------------------------------------------

/**
 * Write (replace) the checkpoint for the current iteration.
 */
export async function writeCheckpoint(
  id: string,
  body: string,
  hiveHome?: string,
): Promise<void> {
  const path = join(campaignDir(id, hiveHome), "checkpoint.md");
  await writeFile(path, body, "utf-8");
}

/**
 * Read the latest checkpoint. Returns null if none written yet.
 */
export async function readCheckpoint(
  id: string,
  hiveHome?: string,
): Promise<string | null> {
  const path = join(campaignDir(id, hiveHome), "checkpoint.md");
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan (mutable)
// ---------------------------------------------------------------------------

/**
 * Write (replace) the current plan.
 */
export async function writePlan(
  id: string,
  body: string,
  hiveHome?: string,
): Promise<void> {
  const path = join(campaignDir(id, hiveHome), "plan.md");
  await writeFile(path, body, "utf-8");
}

/**
 * Read the latest plan. Returns null if none written yet.
 */
export async function latestPlan(
  id: string,
  hiveHome?: string,
): Promise<string | null> {
  const path = join(campaignDir(id, hiveHome), "plan.md");
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scorecard (append-only JSONL)
// ---------------------------------------------------------------------------

/**
 * Append a scorecard row. Each row is a JSON line in scorecard.jsonl.
 */
export async function appendScorecardRow(
  id: string,
  row: ScorecardRow,
  hiveHome?: string,
): Promise<void> {
  const path = join(campaignDir(id, hiveHome), "scorecard.jsonl");
  await appendFile(path, JSON.stringify(row) + "\n", "utf-8");
}

/**
 * Read all scorecard rows in order.
 */
export async function readScorecard(
  id: string,
  hiveHome?: string,
): Promise<ScorecardRow[]> {
  const path = join(campaignDir(id, hiveHome), "scorecard.jsonl");
  try {
    const raw = await readFile(path, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ScorecardRow);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Read campaign status.
 */
export async function readStatus(
  id: string,
  hiveHome?: string,
): Promise<CampaignStatus | null> {
  const path = join(campaignDir(id, hiveHome), "status");
  try {
    const raw = await readFile(path, "utf-8");
    return raw.trim() as CampaignStatus;
  } catch {
    return null;
  }
}

/**
 * Write campaign status.
 */
export async function writeStatus(
  id: string,
  status: CampaignStatus,
  hiveHome?: string,
): Promise<void> {
  const path = join(campaignDir(id, hiveHome), "status");
  await writeFile(path, status, "utf-8");
}

// ---------------------------------------------------------------------------
// Stale-status detection
// ---------------------------------------------------------------------------

/**
 * Check whether a campaign's PID is still alive.
 * Returns true if the process exists, false if it's gone.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect and fix stale "running" status.
 *
 * If a campaign says "running" but its PID is dead and no result.txt exists,
 * the orchestrator crashed without a clean exit. Mark it "aborted" so the
 * dashboard and CLI show the truth.
 *
 * Returns the corrected status, or the original if no correction needed.
 */
export async function detectAndFixStaleStatus(
  id: string,
  hiveHome?: string,
): Promise<CampaignStatus | null> {
  const status = await readStatus(id, hiveHome);
  if (status !== "running") return status;

  const dir = campaignDir(id, hiveHome);

  // Read PID
  let pid: number | null = null;
  try {
    const raw = await readFile(join(dir, "pid"), "utf-8");
    pid = parseInt(raw.trim(), 10);
    if (isNaN(pid)) pid = null;
  } catch {
    // No PID file — can't check liveness. Leave status as-is.
    return status;
  }

  if (pid === null) return status;

  // If process is alive, status is accurate
  if (isProcessAlive(pid)) return status;

  // Process is dead — check if result.txt exists (clean exit writes this)
  if (existsSync(join(dir, "result.txt"))) {
    // Orchestrator finished but status wasn't updated (shouldn't happen, but be safe)
    await writeStatus(id, "done", hiveHome);
    return "done";
  }

  // Dead process, no result.txt → aborted
  await writeStatus(id, "aborted", hiveHome);
  return "aborted";
}

// ---------------------------------------------------------------------------
// Iterations
// ---------------------------------------------------------------------------

/**
 * Create the next iteration directory. Returns the iteration number (1-based).
 */
export async function createIteration(
  id: string,
  hiveHome?: string,
): Promise<number> {
  const iterDir = join(campaignDir(id, hiveHome), "iterations");
  await mkdir(iterDir, { recursive: true });
  const entries = await readdir(iterDir).catch(() => []);
  const nums = entries
    .map((e) => parseInt(e, 10))
    .filter((n) => !isNaN(n));
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  await mkdir(join(iterDir, String(next)), { recursive: true });
  return next;
}

/**
 * Get the path to an iteration directory.
 */
export function iterationDir(
  id: string,
  iterationN: number,
  hiveHome?: string,
): string {
  return join(campaignDir(id, hiveHome), "iterations", String(iterationN));
}

// ---------------------------------------------------------------------------
// Aggregate state reader
// ---------------------------------------------------------------------------

/**
 * Read the full campaign state into a single object.
 */
export async function readCampaignState(
  id: string,
  hiveHome?: string,
): Promise<CampaignState | null> {
  const dir = campaignDir(id, hiveHome);
  if (!existsSync(dir)) return null;

  // Auto-correct stale "running" status before returning state
  const status = await detectAndFixStaleStatus(id, hiveHome);
  if (!status) return null;

  const frozenPrefix = await readFrozenPrefix(id, hiveHome);
  const plan = await latestPlan(id, hiveHome);
  const checkpoint = await readCheckpoint(id, hiveHome);
  const scorecard = await readScorecard(id, hiveHome);

  const iterDir = join(dir, "iterations");
  const entries = await readdir(iterDir).catch(() => []);
  const iterationCount = entries.filter((e) => !isNaN(parseInt(e, 10))).length;

  return {
    id,
    dir,
    workspacePath: join(dir, "workspace"),
    status,
    frozenPrefix,
    plan,
    checkpoint,
    scorecard,
    iterationCount,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove a campaign's git worktree and optionally its branch.
 * Does not delete the campaign directory (preserves history).
 */
export async function teardownWorktree(
  id: string,
  repoPath: string,
  hiveHome?: string,
): Promise<void> {
  const workspacePath = join(campaignDir(id, hiveHome), "workspace");
  if (!existsSync(workspacePath)) return;

  try {
    execSync(`git worktree remove "${workspacePath}" --force`, {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch {
    // Already removed or not a valid worktree — safe to ignore
  }

  // Clean up the branch
  const branchName = `campaign/${id}`;
  try {
    execSync(`git branch -D "${branchName}"`, {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch {
    // Branch doesn't exist or already deleted
  }
}

// ---------------------------------------------------------------------------
// List campaigns
// ---------------------------------------------------------------------------

/**
 * List all campaign IDs in order.
 */
export async function listCampaigns(hiveHome?: string): Promise<string[]> {
  const root = campaignsRoot(hiveHome);
  const entries = await readdir(root).catch(() => []);
  return entries
    .filter((e) => e.startsWith("CAMP-"))
    .sort();
}
