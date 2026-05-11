/**
 * Campaign detached runner — spawned by start_campaign MCP tool.
 *
 * Usage: bun run src/lib/campaign/run-detached.ts <campaign-id> [options-json]
 *
 * Wires the live executor + judge into the orchestrator main loop and runs
 * until terminal. Status and scorecard are written to disk as the campaign
 * progresses — no stdout/stderr needed after launch.
 */

import { runCampaign, type RunCampaignOpts, type CampaignLimits } from "./orchestrator";
import { runIteration } from "./executor";
import { runJudge } from "./judge";
import { liveJudgeCaller } from "./judge-run";
import { assembleIdentity } from "../identity";
import { execSync } from "node:child_process";
import {
  emitStartBreadcrumb,
  writeCrashArtifacts,
  writeCompletionArtifacts,
} from "./run-lifecycle";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const campaignId = process.argv[2];
if (!campaignId) {
  console.error("Usage: bun run run-detached.ts <campaign-id> [options-json]");
  process.exit(1);
}

// Early breadcrumb — before any potentially-throwing init
emitStartBreadcrumb(campaignId, "run-detached");

const optsJson = process.argv[3];
const rawOpts = optsJson ? JSON.parse(optsJson) : {};

const limits: Partial<CampaignLimits> = {};
if (rawOpts.max_iterations != null) limits.maxIterations = rawOpts.max_iterations;
if (rawOpts.max_cost_usd != null) limits.maxCostUsd = rawOpts.max_cost_usd;
if (rawOpts.soft_walltime_ms != null) limits.maxWalltimeMs = rawOpts.soft_walltime_ms;

// ---------------------------------------------------------------------------
// Resolve live dependencies
// ---------------------------------------------------------------------------

function findClaude(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local/bin/claude";
  }
}

const claudePath = findClaude();
const identity = await assembleIdentity();
const model = rawOpts.model ?? "claude-opus-4-6";

// Soft caps per iteration
const softTokens = rawOpts.soft_tokens ?? 50_000;
const softWalltime = rawOpts.soft_walltime ?? 25 * 60 * 1000; // 25 min default

// ---------------------------------------------------------------------------
// Wire executor + judge
// ---------------------------------------------------------------------------

const opts: RunCampaignOpts = {
  campaignId,
  limits,
  executor: async (iterOpts) => {
    return runIteration({
      ...iterOpts,
      caps: {
        softTokens,
        softWalltimeMs: softWalltime,
        hardMultiplier: 1.5,
      },
      claudePath,
      model,
      identity,
    });
  },
  judge: async (judgeOpts) => {
    return runJudge({
      ...judgeOpts,
      caller: liveJudgeCaller,
    });
  },
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  const result = await runCampaign(opts);
  await writeCompletionArtifacts(result);
} catch (err) {
  await writeCrashArtifacts(campaignId, err);
  process.exit(1);
}
