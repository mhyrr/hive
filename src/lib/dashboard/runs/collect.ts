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
import { listProjects } from "../../paths";
import { listTickets, type Ticket } from "../../ticket";

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

// ---------------------------------------------------------------------------
// Cross-link helper: runs indexed by ticket
// ---------------------------------------------------------------------------

/**
 * Minimal reference to a run, just enough to render a link + status badge
 * on a ticket card.
 */
export type RunRef = {
  id: string;
  status: RunRowStatus;
};

/**
 * Build a Map<ticketId, RunRef[]> from a CollectedRuns result.
 * One pass over active + terminal; only entries with a ticketId are indexed.
 * Results per ticket are sorted newest-first (by original array order which
 * is already time-sorted).
 */
export function runsByTicket(data: CollectedRuns): Map<string, RunRef[]> {
  const map = new Map<string, RunRef[]>();

  const index = (row: RunRow) => {
    if (!row.ticketId) return;
    const ref: RunRef = { id: row.id, status: row.status };
    const list = map.get(row.ticketId);
    if (list) {
      list.push(ref);
    } else {
      map.set(row.ticketId, [ref]);
    }
  };

  // Active first (most relevant), then terminal (newest-first already)
  for (const row of data.active) index(row);
  for (const row of data.terminal) index(row);

  return map;
}

// ---------------------------------------------------------------------------
// Arc types — discriminated union for the arc-first /runs view
// ---------------------------------------------------------------------------

export type ArcStatus = "shipped" | "in-flight" | "blocked" | "mixed";

export type GoalArcChild = {
  ticket: Ticket;
  runs: RunRef[];
};

export type GoalArc = {
  kind: "goal";
  epic: Ticket;
  children: GoalArcChild[];
  totalCost: number | null; // null — dispatch cost not tracked today
  runCount: number;
  status: ArcStatus;
};

export type CampaignIteration = {
  iterationN: number;
  exitReason: string;
  judgeDecision: string;
  cost: number;
  elapsedSec: number;
};

export type CampaignArc = {
  kind: "campaign";
  campaign: RunRow;
  iterations: CampaignIteration[];
  totalCost: number;
  iterationCount: number;
  status: ArcStatus;
  /** Full goal text (untruncated). */
  goal: string;
  /** Raw frozen-prefix content, null if not present. */
  frozenPrefix: string | null;
  /** Final artifact path/reference if known. */
  finalArtifact: string | null;
};

export type DirectArc = {
  kind: "direct";
  run: RunRow;
};

export type Arc = GoalArc | CampaignArc | DirectArc;

// ---------------------------------------------------------------------------
// collectArcs() — build Arc[] from live ~/.hive/ data
// ---------------------------------------------------------------------------

/**
 * Roll up child statuses into a single arc-level status.
 * - All children shipped (or have a shipped run) → "shipped"
 * - Any child in_progress or has a running run → "in-flight"
 * - Any child is blocked (has unmet depends) → "blocked"
 * - Mixed conditions → "mixed"
 */
function rollUpGoalStatus(children: GoalArcChild[], openTicketIds: Set<string>): ArcStatus {
  if (children.length === 0) return "shipped";

  let hasShipped = false;
  let hasInFlight = false;
  let hasBlocked = false;
  let hasOpen = false;

  for (const child of children) {
    const { ticket, runs } = child;
    const hasRunningRun = runs.some((r) => r.status === "running");
    const hasShippedRun = runs.some((r) => r.status === "shipped");
    const isBlocked = ticket.depends.length > 0 && ticket.depends.some((d) => openTicketIds.has(d));

    if (ticket.status === "closed" || hasShippedRun) {
      hasShipped = true;
    } else if (hasRunningRun || ticket.status === "in_progress") {
      hasInFlight = true;
    } else if (isBlocked) {
      hasBlocked = true;
    } else {
      hasOpen = true;
    }
  }

  // Pure states
  if (hasInFlight && !hasBlocked && !hasOpen && !hasShipped) return "in-flight";
  if (hasShipped && !hasInFlight && !hasBlocked && !hasOpen) return "shipped";
  if (hasBlocked && !hasInFlight && !hasShipped && !hasOpen) return "blocked";

  // In-flight dominates when mixed with shipped
  if (hasInFlight) return "in-flight";
  // Blocked dominates when mixed with open
  if (hasBlocked) return "blocked";
  // All open but not blocked or in-flight — treat as mixed
  if (hasOpen && hasShipped) return "mixed";

  return "mixed";
}

function campaignArcStatus(row: RunRow): ArcStatus {
  if (row.status === "shipped") return "shipped";
  if (row.status === "running") return "in-flight";
  if (row.status === "partial") return "mixed";
  return "blocked"; // failed/crashed → blocked (stalled)
}

/** Parse scorecard.jsonl for per-iteration arc data. */
function parseScorecardForArcs(content: string): CampaignIteration[] {
  const iterations: CampaignIteration[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      const startMs = row.started_at ? new Date(row.started_at).getTime() : 0;
      const endMs = row.ended_at ? new Date(row.ended_at).getTime() : 0;
      const elapsedSec = startMs && endMs ? Math.max(0, Math.round((endMs - startMs) / 1000)) : 0;

      iterations.push({
        iterationN: row.iteration_n ?? 0,
        exitReason: row.exit_reason ?? "unknown",
        judgeDecision: row.judge_decision ?? "unknown",
        cost: typeof row.cost_usd === "number" ? row.cost_usd : 0,
        elapsedSec,
      });
    } catch {
      // skip malformed
    }
  }
  return iterations;
}

export type CollectArcsOpts = {
  /** Check PID liveness via process.kill(pid, 0). Disable for tests. */
  checkPid?: boolean;
};

/**
 * Build an arc-first view of all execution in `~/.hive/`.
 *
 * Three arc kinds:
 * - Goal: epic ticket + children joined to runs via runsByTicket()
 * - Campaign: campaign run + parsed scorecard iterations
 * - Direct: orphan dispatch run (no parent_epic, not part of campaign)
 */
export async function collectArcs(
  paths: HivePaths,
  opts: CollectArcsOpts = {},
): Promise<Arc[]> {
  // Collect runs (reuses existing collector)
  const collectedRuns = await collectRuns(paths, { checkPid: opts.checkPid ?? true });
  const ticketRunMap = runsByTicket(collectedRuns);

  // Load all tickets across all projects
  const projectIds = await listProjects(paths.projectsDir);
  const allTickets: Ticket[] = [];
  for (const pid of projectIds) {
    const tickets = await listTickets(paths, pid).catch(() => [] as Ticket[]);
    allTickets.push(...tickets);
  }

  // Build lookup structures
  const ticketById = new Map<string, Ticket>(allTickets.map((t) => [t.id, t]));
  const openTicketIds = new Set<string>(
    allTickets.filter((t) => t.status !== "closed").map((t) => t.id),
  );

  // Identify epics and their children
  const epics = allTickets.filter((t) => t.type === "epic");
  const childrenByEpic = new Map<string, Ticket[]>();
  for (const t of allTickets) {
    if (t.parentEpic) {
      const list = childrenByEpic.get(t.parentEpic);
      if (list) {
        list.push(t);
      } else {
        childrenByEpic.set(t.parentEpic, [t]);
      }
    }
  }

  // Track which ticket IDs are "claimed" by a goal arc
  const claimedTicketIds = new Set<string>();

  // --- Goal arcs ---
  const goalArcs: GoalArc[] = [];
  for (const epic of epics) {
    const children = childrenByEpic.get(epic.id) ?? [];
    claimedTicketIds.add(epic.id);

    const arcChildren: GoalArcChild[] = children.map((child) => {
      claimedTicketIds.add(child.id);
      return {
        ticket: child,
        runs: ticketRunMap.get(child.id) ?? [],
      };
    });

    const runCount = arcChildren.reduce((sum, c) => sum + c.runs.length, 0);
    const status = rollUpGoalStatus(arcChildren, openTicketIds);

    goalArcs.push({
      kind: "goal",
      epic,
      children: arcChildren,
      totalCost: null, // dispatch cost not tracked today
      runCount,
      status,
    });
  }

  // --- Campaign arcs ---
  // Campaign runs are already in collectedRuns. Enrich with scorecard data.
  const campaignArcs: CampaignArc[] = [];
  const campaignRunRows = [
    ...collectedRuns.active.filter((r) => r.kind === "campaign"),
    ...collectedRuns.terminal.filter((r) => r.kind === "campaign"),
  ];

  // Track which ticketIds are claimed by campaigns
  const campaignTicketIds = new Set<string>();

  for (const row of campaignRunRows) {
    if (row.ticketId) campaignTicketIds.add(row.ticketId);

    const campDir = join(paths.campaignsDir, row.id);

    // Read scorecard.jsonl for iteration detail
    const scorecardPath = join(campDir, "scorecard.jsonl");
    const scorecardRaw = await safeReadFile(scorecardPath);
    const iterations = scorecardRaw ? parseScorecardForArcs(scorecardRaw) : [];

    const totalCost = iterations.reduce((sum, it) => sum + it.cost, 0);

    // Full goal text (untruncated)
    let goal = "";
    const configRaw = await safeReadFile(join(campDir, "config.json"));
    if (configRaw) {
      try {
        const cfg = JSON.parse(configRaw);
        goal = cfg.goal ?? "";
      } catch { /* fallthrough */ }
    }
    if (!goal) {
      goal = (await safeReadFile(join(campDir, "frozen-prefix.md")))?.trim() ?? "";
    }

    // Frozen prefix
    const frozenPrefix = await safeReadFile(join(campDir, "frozen-prefix.md"));

    // Final artifact: check for result.md or artifact ref in orchestrator log
    let finalArtifact: string | null = null;
    const resultMd = await safeReadFile(join(campDir, "result.md"));
    if (resultMd?.trim()) {
      finalArtifact = resultMd.trim();
    }

    campaignArcs.push({
      kind: "campaign",
      campaign: row,
      iterations,
      totalCost,
      iterationCount: iterations.length,
      status: campaignArcStatus(row),
      goal,
      frozenPrefix: frozenPrefix?.trim() || null,
      finalArtifact,
    });
  }

  // --- Direct arcs ---
  // Any dispatch run whose ticket has no parent_epic AND isn't part of a campaign
  const allDispatchRows = [
    ...collectedRuns.active.filter((r) => r.kind === "dispatch"),
    ...collectedRuns.terminal.filter((r) => r.kind === "dispatch"),
  ];

  const directArcs: DirectArc[] = [];
  for (const row of allDispatchRows) {
    // If it has a ticket ID, check if that ticket is claimed by a goal arc or campaign
    if (row.ticketId) {
      if (claimedTicketIds.has(row.ticketId)) continue;
      if (campaignTicketIds.has(row.ticketId)) continue;
    }
    directArcs.push({ kind: "direct", run: row });
  }

  // Combine: goal arcs first, then campaigns, then direct
  const arcs: Arc[] = [...goalArcs, ...campaignArcs, ...directArcs];
  return arcs;
}
