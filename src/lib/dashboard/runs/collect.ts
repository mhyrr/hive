/**
 * Runs data collector — reads `~/.hive/runs/RUN-*` and `~/.hive/campaigns/CAMP-*`
 * and normalizes into a unified RunRow shape the dashboard renderers can consume.
 *
 * Pure data layer: no rendering, no side effects beyond reading the filesystem.
 * Given deterministic fixture dirs, returns deterministic output.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HivePaths } from "../../paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunRowStatus =
  | "running"
  | "shipped"
  | "partial"
  | "failed"
  | "crashed";

export type RunRow = {
  kind: "dispatch" | "campaign";
  id: string; // RUN-NNN or CAMP-NNN
  status: RunRowStatus;
  startedAt: string; // ISO
  endedAt?: string;
  elapsedSec: number;
  costUsd?: number;
  ticketId?: string; // TK-NNN if dispatched against a ticket
  goalSummary: string; // first ~140 chars
  worktreeBranch?: string;
  lastLogLine?: string; // for active runs only
};

export type CollectedRuns = {
  active: RunRow[];
  terminal: RunRow[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function safeStat(path: string): Promise<{ mtime: Date } | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function isProcessAlive(pidStr: string): boolean {
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function extractTicketId(text: string): string | null {
  const match = text.match(/TK-\d{1,4}/);
  return match ? match[0] : null;
}

/** Truncate text to ~maxLen chars at a word boundary. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Read the last non-empty line of a file. Returns "" for 0-byte files. */
async function lastLine(path: string): Promise<string> {
  const content = await safeReadFile(path);
  if (!content) return "";
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1]?.trimEnd() ?? "";
}

// ---------------------------------------------------------------------------
// Status normalization
// ---------------------------------------------------------------------------

/** Map on-disk status strings to RunRowStatus. */
function normalizeDispatchStatus(raw: string, alive: boolean): RunRowStatus {
  const s = raw.trim().toLowerCase();

  // If the file says "running" but the process is dead, it crashed
  if (s === "running" && !alive) return "crashed";
  if (s === "running") return "running";

  // Map known terminal values
  if (s === "complete" || s === "shipped") return "shipped";
  if (s === "partial") return "partial";
  if (s === "failed" || s === "timed_out" || s === "killed") return "failed";
  if (s === "crashed") return "crashed";

  // Unknown → treat as failed
  return "failed";
}

/** Map campaign status to RunRowStatus. */
function normalizeCampaignStatus(raw: string, alive: boolean): RunRowStatus {
  const s = raw.trim().toLowerCase();

  if (s === "running" && !alive) return "crashed";
  if (s === "running") return "running";
  if (s === "done") return "shipped";
  if (s === "aborted" || s === "budget-exhausted") return "failed";
  if (s === "paused") return "partial";

  return "failed";
}

// ---------------------------------------------------------------------------
// Dispatch run collector
// ---------------------------------------------------------------------------

async function collectDispatchRun(
  runDir: string,
  id: string,
  checkPid: boolean,
): Promise<RunRow | null> {
  const statusRaw = await safeReadFile(join(runDir, "status"));
  if (statusRaw === null) return null; // No status file → skip (partial state)

  // PID liveness
  const pidStr = (await safeReadFile(join(runDir, "pid")))?.trim() ?? "";
  const alive = checkPid ? isProcessAlive(pidStr) : false;
  const status = normalizeDispatchStatus(statusRaw, alive);

  // Timing: use goal.md mtime as startedAt, status mtime as endedAt
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

  // Goal parsing
  const goalRaw = (await safeReadFile(join(runDir, "goal.md"))) ?? "";
  const goalBody = goalRaw.replace(/^#\s*Goal\s*\n+/i, "").trim();
  // First meaningful line that isn't metadata
  const firstLine = goalBody
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("---") && !l.match(/^(Project|Dispatched):/i));
  const goalSummary = truncate(firstLine?.trim() ?? id, 140);

  const ticketId = extractTicketId(goalRaw) ?? undefined;

  // Worktree branch: parse from run.sh --worktree flag presence
  // The branch is typically worktree-<runid> or from --name flag
  const runSh = (await safeReadFile(join(runDir, "run.sh"))) ?? "";
  const branchMatch = runSh.match(/--name\s+"([^"]+)"/);
  const worktreeBranch = branchMatch?.[1]
    ? `worktree-${branchMatch[1].toLowerCase().replace(/\s+/g, "-")}`
    : undefined;

  // Last log line for active runs
  const lastLogLine = status === "running"
    ? await lastLine(join(runDir, "output.log"))
    : undefined;

  return {
    kind: "dispatch",
    id,
    status,
    startedAt,
    endedAt,
    elapsedSec,
    ticketId,
    goalSummary,
    worktreeBranch,
    lastLogLine,
  };
}

// ---------------------------------------------------------------------------
// Campaign run collector
// ---------------------------------------------------------------------------

/** Parse scorecard.jsonl into rows. Tolerates malformed lines. */
function parseScorecardJsonl(content: string): Array<{
  iteration_n: number;
  started_at: string;
  ended_at: string;
  cost_usd: number;
}> {
  const rows: Array<{
    iteration_n: number;
    started_at: string;
    ended_at: string;
    cost_usd: number;
  }> = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      rows.push({
        iteration_n: row.iteration_n ?? 0,
        started_at: row.started_at ?? "",
        ended_at: row.ended_at ?? "",
        cost_usd: typeof row.cost_usd === "number" ? row.cost_usd : 0,
      });
    } catch {
      // Skip malformed lines
    }
  }
  return rows;
}

/** Parse orchestrator.log summary line for total cost/walltime. */
function parseOrchestratorLog(content: string): {
  totalCostUsd?: number;
  totalWalltimeMs?: number;
} {
  // The orchestrator writes a single JSON summary line
  for (const line of content.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      return {
        totalCostUsd: typeof obj.totalCostUsd === "number" ? obj.totalCostUsd : undefined,
        totalWalltimeMs: typeof obj.totalWalltimeMs === "number" ? obj.totalWalltimeMs : undefined,
      };
    } catch {
      continue;
    }
  }
  return {};
}

async function collectCampaignRun(
  campDir: string,
  id: string,
  checkPid: boolean,
): Promise<RunRow | null> {
  const statusRaw = await safeReadFile(join(campDir, "status"));
  if (statusRaw === null) return null;

  // PID liveness
  const pidStr = (await safeReadFile(join(campDir, "pid")))?.trim() ?? "";
  const alive = checkPid ? isProcessAlive(pidStr) : false;
  const status = normalizeCampaignStatus(statusRaw, alive);

  // Goal: from config.json if available, else frozen-prefix.md
  const configRaw = await safeReadFile(join(campDir, "config.json"));
  let goalText = "";
  if (configRaw) {
    try {
      const cfg = JSON.parse(configRaw);
      goalText = cfg.goal ?? "";
    } catch {
      // fallthrough
    }
  }
  if (!goalText) {
    goalText = (await safeReadFile(join(campDir, "frozen-prefix.md")))?.trim() ?? "";
  }
  const goalSummary = truncate(goalText || id, 140);

  const ticketId = extractTicketId(goalText) ?? undefined;

  // Scorecard for cost + timing
  const scorecardRaw = (await safeReadFile(join(campDir, "scorecard.jsonl"))) ?? "";
  const scorecardRows = parseScorecardJsonl(scorecardRaw);

  // Orchestrator log for final summary
  const orchLogRaw = (await safeReadFile(join(campDir, "orchestrator.log"))) ?? "";
  const orchSummary = parseOrchestratorLog(orchLogRaw);

  // Cost: prefer orchestrator summary, fallback to scorecard sum
  let costUsd: number | undefined;
  if (orchSummary.totalCostUsd !== undefined) {
    costUsd = orchSummary.totalCostUsd;
  } else if (scorecardRows.length > 0) {
    costUsd = scorecardRows.reduce((sum, r) => sum + r.cost_usd, 0);
  }

  // Timing
  const firstRow = scorecardRows[0];
  const lastRow = scorecardRows[scorecardRows.length - 1];

  let startedAt: string;
  let endedAt: string | undefined;
  let elapsedSec: number;

  if (firstRow?.started_at) {
    startedAt = firstRow.started_at;
  } else {
    const pidStat = await safeStat(join(campDir, "pid"));
    startedAt = pidStat?.mtime.toISOString() ?? new Date(0).toISOString();
  }

  if (status !== "running") {
    if (lastRow?.ended_at) {
      endedAt = lastRow.ended_at;
    } else {
      const statusStat = await safeStat(join(campDir, "status"));
      endedAt = statusStat?.mtime.toISOString();
    }
  }

  if (orchSummary.totalWalltimeMs !== undefined) {
    elapsedSec = Math.round(orchSummary.totalWalltimeMs / 1000);
  } else if (endedAt && startedAt) {
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    elapsedSec = Math.max(0, Math.round(ms / 1000));
  } else if (status === "running") {
    const ms = Date.now() - new Date(startedAt).getTime();
    elapsedSec = Math.max(0, Math.round(ms / 1000));
  } else {
    elapsedSec = 0;
  }

  // Worktree branch: campaigns use campaign/<id> convention
  const worktreeBranch = `campaign/${id}`;

  // Last log line for active campaigns: check orchestrator.log
  const lastLogLine = status === "running"
    ? await lastLine(join(campDir, "orchestrator.log"))
    : undefined;

  return {
    kind: "campaign",
    id,
    status,
    startedAt,
    endedAt,
    elapsedSec,
    costUsd,
    ticketId,
    goalSummary,
    worktreeBranch,
    lastLogLine,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CollectRunsOpts = {
  /** Check PID liveness via process.kill(pid, 0). Disable for tests. */
  checkPid?: boolean;
};

/**
 * Collect runs from both `~/.hive/runs/` and `~/.hive/campaigns/`,
 * normalizing them into a unified timeline shape.
 *
 * Returns `{ active, terminal }` where active runs are sorted oldest-first
 * (started longest ago at top) and terminal runs are sorted newest-first.
 */
export async function collectRuns(
  paths: HivePaths,
  opts: CollectRunsOpts = {},
): Promise<CollectedRuns> {
  const checkPid = opts.checkPid ?? true;

  // --- Dispatches ---
  const runEntries = await readdir(paths.runsDir).catch(() => [] as string[]);
  const runIds = runEntries.filter((e) => /^RUN-\d+$/.test(e));

  const dispatchPromises = runIds.map((id) =>
    collectDispatchRun(join(paths.runsDir, id), id, checkPid),
  );

  // --- Campaigns ---
  const campEntries = await readdir(paths.campaignsDir).catch(() => [] as string[]);
  const campIds = campEntries.filter((e) => /^CAMP-\d+$/.test(e));

  const campaignPromises = campIds.map((id) =>
    collectCampaignRun(join(paths.campaignsDir, id), id, checkPid),
  );

  const [dispatches, campaigns] = await Promise.all([
    Promise.all(dispatchPromises),
    Promise.all(campaignPromises),
  ]);

  const allRows: RunRow[] = [
    ...dispatches.filter((r): r is RunRow => r !== null),
    ...campaigns.filter((r): r is RunRow => r !== null),
  ];

  const active: RunRow[] = [];
  const terminal: RunRow[] = [];

  for (const row of allRows) {
    if (row.status === "running") {
      active.push(row);
    } else {
      terminal.push(row);
    }
  }

  // Active: oldest-first (longest-running at top)
  active.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  // Terminal: newest-first
  terminal.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  return { active, terminal };
}
