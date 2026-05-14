/**
 * Detailed dispatch run collector — reads the full goal text and log tail
 * for a single run, producing a DispatchDetail suitable for the drill-in
 * fragment renderer.
 *
 * Separated from collect.ts (which produces summary RunRows for the
 * timeline) because the detail view needs heavier I/O (full goal file,
 * last ~80 lines of output.log, git worktree state).
 */

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import type { HivePaths } from "../../paths";
import type { RunRowStatus } from "./collect";
import type { DispatchDetail, WorktreeState } from "../render-dispatch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null; // intentional: file missing or unreadable
  }
}

async function safeStat(path: string): Promise<{ mtime: Date } | null> {
  try {
    return await stat(path);
  } catch {
    return null; // intentional: path doesn't exist
  }
}

function isProcessAlive(pidStr: string): boolean {
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // intentional: ESRCH/EPERM — process not alive
  }
}

/** Extract the last N non-empty lines of a string. */
function tailLines(content: string, n: number): string {
  const lines = content.split("\n");
  // Take the last N lines, preserving empty lines within the range
  const tail = lines.slice(-n);
  // Trim trailing empty lines
  while (tail.length > 0 && tail[tail.length - 1]!.trim() === "") {
    tail.pop();
  }
  return tail.join("\n");
}

/** Map on-disk status to RunRowStatus (mirrors collect.ts). */
function normalizeStatus(raw: string, alive: boolean): RunRowStatus {
  const s = raw.trim().toLowerCase();
  if (s === "running" && !alive) return "crashed";
  if (s === "running") return "running";
  if (s === "complete" || s === "shipped") return "shipped";
  if (s === "partial") return "partial";
  if (s === "failed" || s === "timed_out" || s === "killed") return "failed";
  if (s === "crashed") return "crashed";
  return "failed";
}

function extractTicketId(text: string): string | null {
  const match = text.match(/TK-\d{1,4}/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Worktree state detection
// ---------------------------------------------------------------------------

export type DetectWorktreeOpts = {
  /** Override for testing — skip actual git calls. */
  skipGit?: boolean;
  /** The project path to run git commands in. */
  projectPath?: string;
};

/**
 * Detect the state of a worktree branch.
 *
 * - "alive": branch exists and is checked out in a worktree
 * - "merged": branch has been merged into main/master (or deleted after merge)
 * - "pruned": branch doesn't exist (removed without merge, or never created)
 */
export function detectWorktreeState(
  branch: string,
  opts: DetectWorktreeOpts = {},
): WorktreeState {
  if (opts.skipGit) return "pruned";

  const cwd = opts.projectPath;
  const execOpts = cwd ? { cwd, stdio: "pipe" as const } : { stdio: "pipe" as const };

  try {
    // Check if branch exists locally
    const branchCheck = execFileSync(
      "git",
      ["branch", "--list", branch],
      execOpts,
    ).toString().trim();

    if (branchCheck) {
      // Branch exists — check if it's in a worktree
      try {
        const worktreeList = execFileSync(
          "git",
          ["worktree", "list", "--porcelain"],
          execOpts,
        ).toString();

        if (worktreeList.includes(`branch refs/heads/${branch}`)) {
          return "alive";
        }
      } catch {
        // intentional: git worktree list failed — branch exists but can't confirm worktree
      }
      return "alive"; // Branch exists, close enough
    }

    // Branch doesn't exist — check if it was merged
    try {
      const merged = execFileSync(
        "git",
        ["branch", "--merged", "HEAD", "--list", branch],
        execOpts,
      ).toString().trim();

      if (merged) return "merged";
    } catch {
      // intentional: couldn't check merged state
    }

    return "pruned";
  } catch {
    // intentional: git not available or not a repo
    return "pruned";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CollectDispatchDetailOpts = {
  /** Check PID liveness. Disable for tests with fake PIDs. */
  checkPid?: boolean;
  /** Max lines for log tail. Default 80. */
  logTailLines?: number;
  /** Skip git calls for worktree detection. */
  skipGit?: boolean;
  /** Project path for git worktree detection. */
  projectPath?: string;
};

/**
 * Collect detailed data for a single dispatch run.
 *
 * Returns null if the run directory doesn't have a status file
 * (partial/corrupt state).
 */
export async function collectDispatchDetail(
  paths: HivePaths,
  runId: string,
  opts: CollectDispatchDetailOpts = {},
): Promise<DispatchDetail | null> {
  const runDir = join(paths.runsDir, runId);
  const checkPid = opts.checkPid ?? true;
  const maxLines = opts.logTailLines ?? 80;

  // Status
  const statusRaw = await safeReadFile(join(runDir, "status"));
  if (statusRaw === null) return null;

  const pidStr = (await safeReadFile(join(runDir, "pid")))?.trim() ?? "";
  const alive = checkPid ? isProcessAlive(pidStr) : false;
  const status = normalizeStatus(statusRaw, alive);

  // Timing
  const goalStat = await safeStat(join(runDir, "goal.md"));
  const statusStat = await safeStat(join(runDir, "status"));

  const startedAt = goalStat?.mtime.toISOString() ?? new Date(0).toISOString();
  const endedAt = status !== "running" && statusStat
    ? statusStat.mtime.toISOString()
    : undefined;

  const elapsedMs = status === "running"
    ? Date.now() - (goalStat?.mtime.getTime() ?? Date.now())
    : (statusStat && goalStat
      ? statusStat.mtime.getTime() - goalStat.mtime.getTime()
      : 0);
  const elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));

  // Full goal text
  const goalRaw = (await safeReadFile(join(runDir, "goal.md"))) ?? "";
  const goalFull = goalRaw.replace(/^#\s*Goal\s*\n+/i, "").trim();

  const ticketId = extractTicketId(goalRaw) ?? undefined;

  // Worktree branch
  const runSh = (await safeReadFile(join(runDir, "run.sh"))) ?? "";
  const branchMatch = runSh.match(/--name\s+"([^"]+)"/);
  const worktreeBranch = branchMatch?.[1]
    ? `worktree-${branchMatch[1].toLowerCase().replace(/\s+/g, "-")}`
    : undefined;

  // Worktree state
  let worktreeState: WorktreeState | undefined;
  if (worktreeBranch) {
    worktreeState = detectWorktreeState(worktreeBranch, {
      skipGit: opts.skipGit ?? false,
      projectPath: opts.projectPath,
    });
  }

  // Log tail
  const logContent = await safeReadFile(join(runDir, "output.log"));
  const logAvailable = logContent !== null && logContent.length > 0;
  const logTail = logAvailable ? tailLines(logContent!, maxLines) : "";

  return {
    id: runId,
    status,
    startedAt,
    endedAt,
    elapsedSec,
    ticketId,
    goalFull,
    worktreeBranch,
    worktreeState,
    logTail,
    logAvailable,
    runDir,
  };
}
