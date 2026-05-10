/**
 * hive campaign — CLI surface for campaign-dispatch (TK-079).
 *
 * Three subcommands:
 *   run <goal>   — init state, spawn orchestrator detached, print campaign-id
 *   list         — read ~/.hive/campaigns/, print table
 *   show <id>    — print frozen prefix, plan, scorecard table
 */

import { existsSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { UsageError } from "../lib/errors";
import { getHivePaths, ensureDirectory } from "../lib/paths";
import { resolveProjectFromCwd } from "../lib/project";
import { parseFrontmatter } from "../lib/frontmatter";
import {
  initCampaign,
  readCampaignState,
  listCampaigns,
  readScorecard,
  readFrozenPrefix,
  resolveStatus,
  readGoal,
  type CampaignStatus,
  type ScorecardRow,
} from "../lib/campaign/state";
import { DEFAULT_LIMITS, type CampaignLimits } from "../lib/campaign/orchestrator";
import { DEFAULT_CAPS, type CapsConfig } from "../lib/campaign/caps";

// ---------------------------------------------------------------------------
// Usage strings
// ---------------------------------------------------------------------------

const USAGE = `Usage: hive campaign <subcommand>

Subcommands:
  run <goal>     Start a new campaign (runs detached)
  list           List all campaigns
  show <id>      Show campaign details and scorecard

Run \`hive campaign <subcommand> --help\` for details.`;

const RUN_USAGE = `Usage: hive campaign run "<goal>" [options]

Start a new campaign. The orchestrator runs detached (like dispatch).

Options:
  --project <name>        Project name (default: detect from cwd)
  --soft-tokens <N>       Soft token cap per iteration (default: ${DEFAULT_CAPS.tokens_soft})
  --soft-walltime <M>     Soft walltime cap per iteration in minutes (default: ${DEFAULT_CAPS.walltime_soft_ms / 60000})
  --max-iterations <K>    Max iterations before termination (default: ${DEFAULT_LIMITS.maxIterations})
  --max-cost-usd <D>      Max total cost in USD (default: ${DEFAULT_LIMITS.maxCostUsd})
  --max-walltime <H>      Max total wall-clock in hours (default: ${DEFAULT_LIMITS.maxWalltimeMs / 3600000})`;

const LIST_USAGE = `Usage: hive campaign list [--status running|done|aborted|paused|budget-exhausted]

List all campaigns under ~/.hive/campaigns/.
Optionally filter by status.`;

const SHOW_USAGE = `Usage: hive campaign show <id>

Show campaign details: frozen prefix, current plan, latest checkpoint,
and scorecard as a formatted table.

The <id> can be a full ID (CAMP-001) or just the number (1).`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeCampaignId(input: string): string {
  // Accept "1" or "001" or "CAMP-001"
  if (input.startsWith("CAMP-")) return input;
  const n = parseInt(input, 10);
  if (isNaN(n)) return input; // pass through, will fail on lookup
  return `CAMP-${String(n).padStart(3, "0")}`;
}

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

  // Column headers
  const header = "  Iter  Decision        Tokens     Cost    Walltime";
  const sep    = "  ----  --------        ------     ----    --------";

  const lines = rows.map((row) => {
    const iter = String(row.iteration_n).padStart(4);
    const decision = row.judge_decision.padEnd(16);
    const tokens = String(row.tokens_used).padStart(6);
    const cost = `$${row.cost_usd.toFixed(2)}`.padStart(8);

    // Calculate walltime from timestamps
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

  // Totals
  const totalTokens = rows.reduce((sum, r) => sum + r.tokens_used, 0);
  const totalCost = rows.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalLine = `  Total                ${String(totalTokens).padStart(6)}  $${totalCost.toFixed(2).padStart(7)}`;

  return [header, sep, ...lines, sep, totalLine].join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: run
// ---------------------------------------------------------------------------

async function runSubcommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(RUN_USAGE);
    return;
  }

  // Parse flags
  let goal = "";
  let projectId = "";
  let softTokens = DEFAULT_CAPS.tokens_soft;
  let softWalltimeMin = DEFAULT_CAPS.walltime_soft_ms / 60000;
  let maxIterations = DEFAULT_LIMITS.maxIterations;
  let maxCostUsd = DEFAULT_LIMITS.maxCostUsd;
  let maxWalltimeHrs = DEFAULT_LIMITS.maxWalltimeMs / 3600000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--project" && args[i + 1]) {
      projectId = args[++i]!;
    } else if (arg === "--soft-tokens" && args[i + 1]) {
      softTokens = parseInt(args[++i]!, 10);
      if (isNaN(softTokens) || softTokens < 1) softTokens = DEFAULT_CAPS.tokens_soft;
    } else if (arg === "--soft-walltime" && args[i + 1]) {
      softWalltimeMin = parseInt(args[++i]!, 10);
      if (isNaN(softWalltimeMin) || softWalltimeMin < 1)
        softWalltimeMin = DEFAULT_CAPS.walltime_soft_ms / 60000;
    } else if (arg === "--max-iterations" && args[i + 1]) {
      maxIterations = parseInt(args[++i]!, 10);
      if (isNaN(maxIterations) || maxIterations < 1) maxIterations = DEFAULT_LIMITS.maxIterations;
    } else if (arg === "--max-cost-usd" && args[i + 1]) {
      maxCostUsd = parseFloat(args[++i]!);
      if (isNaN(maxCostUsd) || maxCostUsd <= 0) maxCostUsd = DEFAULT_LIMITS.maxCostUsd;
    } else if (arg === "--max-walltime" && args[i + 1]) {
      maxWalltimeHrs = parseFloat(args[++i]!);
      if (isNaN(maxWalltimeHrs) || maxWalltimeHrs <= 0)
        maxWalltimeHrs = DEFAULT_LIMITS.maxWalltimeMs / 3600000;
    } else if (!arg.startsWith("--")) {
      goal = arg;
    }
  }

  if (!goal) {
    throw new UsageError("No goal specified.\n\n" + RUN_USAGE);
  }

  if (!projectId) {
    projectId = resolveProjectFromCwd() ?? "";
  }
  if (!projectId) {
    throw new UsageError("No project found. Use --project or run from a project directory.");
  }

  // Resolve project path for the git worktree
  const paths = getHivePaths();
  const projectConfigPath = join(paths.projectsDir, projectId, "config.md");
  let projectPath = process.cwd();
  try {
    const raw = await Bun.file(projectConfigPath).text();
    const parsed = parseFrontmatter(raw);
    projectPath = (parsed.attributes?.path as string) ?? process.cwd();
  } catch { /* use cwd */ }

  // Initialize campaign state (creates dir, worktree, status file)
  const campaignId = await initCampaign({
    goal,
    repoPath: projectPath,
  });

  // Write campaign config for the orchestrator to read
  const campaignDir = join(paths.campaignsDir, campaignId);
  const config = {
    projectId,
    projectPath,
    goal,
    caps: {
      tokens_soft: softTokens,
      walltime_soft_ms: softWalltimeMin * 60000,
    } satisfies CapsConfig,
    limits: {
      maxIterations,
      maxCostUsd,
      maxWalltimeMs: maxWalltimeHrs * 3600000,
    } satisfies CampaignLimits,
  };
  await Bun.write(join(campaignDir, "config.json"), JSON.stringify(config, null, 2));

  // Spawn the orchestrator as a detached background process.
  // Redirect stdout/stderr to orchestrator.log so crashes are inspectable.
  const orchestratorScript = join(import.meta.dir, "..", "lib", "campaign", "run-orchestrator.ts");
  const logPath = join(campaignDir, "orchestrator.log");
  const logFd = openSync(logPath, "a");

  const child = spawn("bun", ["run", orchestratorScript, campaignId], {
    cwd: projectPath,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: undefined, // force subscription OAuth
      HIVE_CAMPAIGN_ID: campaignId,
    },
  });

  child.unref();
  closeSync(logFd);
  await Bun.write(join(campaignDir, "pid"), String(child.pid));

  console.log(`Campaign ${campaignId} started (${projectId})`);
  console.log(`  Goal: ${goal.split("\n")[0]!.slice(0, 80)}`);
  console.log(`  Dir:  ${campaignDir}`);
  console.log(`  PID:  ${child.pid}`);
  console.log(`  Limits: ${maxIterations} iterations, $${maxCostUsd} max, ${maxWalltimeHrs}h wall`);
  console.log(`  Caps: ${softTokens} tokens/iter, ${softWalltimeMin}m/iter`);
  console.log(`\nTail: hive campaign show ${campaignId}`);
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

async function listSubcommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(LIST_USAGE);
    return;
  }

  // Parse --status filter
  let statusFilter: CampaignStatus | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status" && args[i + 1]) {
      statusFilter = args[++i] as CampaignStatus;
    }
  }

  const campaigns = await listCampaigns();
  if (campaigns.length === 0) {
    console.log("No campaigns found.");
    return;
  }

  // Gather data for each campaign
  const rows: Array<{
    id: string;
    status: string;
    iterations: number;
    cost: string;
    goal: string;
  }> = [];

  for (const id of campaigns) {
    const resolved = await resolveStatus(id);
    if (!resolved) continue;
    if (statusFilter && resolved.status !== statusFilter) continue;

    const scorecard = await readScorecard(id);
    const goal = await readGoal(id);
    const frozenPrefix = goal ? null : await readFrozenPrefix(id);
    const totalCost = scorecard.reduce((sum, r) => sum + r.cost_usd, 0);
    const goalLine = (goal ?? frozenPrefix ?? "").split("\n")[0]?.slice(0, 50) ?? "—";

    const displayStatus = resolved.wasOrphaned
      ? "aborted (orchestrator died)"
      : resolved.status;

    rows.push({
      id,
      status: displayStatus,
      iterations: scorecard.length,
      cost: `$${totalCost.toFixed(2)}`,
      goal: goalLine,
    });
  }

  if (rows.length === 0) {
    console.log(statusFilter ? `No campaigns with status: ${statusFilter}` : "No campaigns found.");
    return;
  }

  // Print table — wider status column for orphaned campaigns
  const header = "ID         Status                        Iters   Cost    Goal";
  const sep    = "--------   --------------------------   -----   ------  ----";
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    const id = row.id.padEnd(10);
    const status = row.status.padEnd(28);
    const iters = String(row.iterations).padStart(5);
    const cost = row.cost.padStart(8);
    console.log(`${id} ${status} ${iters}   ${cost}  ${row.goal}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: show
// ---------------------------------------------------------------------------

async function showSubcommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(SHOW_USAGE);
    return;
  }

  const rawId = args[0];
  if (!rawId) {
    throw new UsageError("No campaign ID specified.\n\n" + SHOW_USAGE);
  }

  const id = normalizeCampaignId(rawId);
  const state = await readCampaignState(id);
  if (!state) {
    throw new UsageError(`Campaign not found: ${id}`);
  }

  // Header
  const displayStatus = state.wasOrphaned
    ? "aborted (orchestrator died)"
    : state.status;
  console.log(`# ${id} [${displayStatus}]`);
  console.log();

  // Goal (raw user-supplied text)
  const goalText = state.goal ?? state.frozenPrefix;
  if (goalText) {
    console.log("## Goal");
    console.log();
    // Show first few lines of the goal
    const lines = goalText.split("\n");
    const preview = lines.slice(0, 5).join("\n");
    console.log(preview);
    if (lines.length > 5) console.log(`  ... (${lines.length - 5} more lines)`);
    console.log();
  }

  // Current plan
  if (state.plan) {
    console.log("## Plan");
    console.log();
    console.log(state.plan);
    console.log();
  }

  // Latest checkpoint
  if (state.checkpoint) {
    console.log("## Latest Checkpoint");
    console.log();
    console.log(state.checkpoint);
    console.log();
  }

  // Scorecard
  console.log("## Scorecard");
  console.log();
  console.log(formatScorecardTable(state.scorecard));
  console.log();

  // Campaign directory
  console.log(`Dir: ${state.dir}`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function campaignCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    return;
  }

  switch (subcommand) {
    case "run":
      await runSubcommand(args.slice(1));
      break;
    case "list":
      await listSubcommand(args.slice(1));
      break;
    case "show":
      await showSubcommand(args.slice(1));
      break;
    default:
      throw new UsageError(`Unknown campaign subcommand: ${subcommand}\n\n${USAGE}`);
  }
}
