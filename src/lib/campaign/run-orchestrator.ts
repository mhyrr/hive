/**
 * Campaign orchestrator entry point — spawned detached by `hive campaign run`.
 *
 * Reads config.json from the campaign directory, wires up live executor
 * and judge callers, and runs the campaign loop. Writes results to the
 * campaign directory on disk.
 *
 * Usage: bun run src/lib/campaign/run-orchestrator.ts <CAMP-NNN>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

import { resolveHiveHome } from "../paths";
import { assembleIdentity } from "../identity";
import { runCampaign, type CampaignLimits, type ExecutorFn, type JudgeFn } from "./orchestrator";
import { runIteration } from "./executor";
import { runJudge } from "./judge";
import { liveJudgeCaller } from "./judge-run";
import type { CapsConfig } from "./caps";
import {
  emitStartBreadcrumb,
  writeCrashArtifacts,
  writeCompletionArtifacts,
} from "./run-lifecycle";

// ---------------------------------------------------------------------------
// Find claude binary
// ---------------------------------------------------------------------------

function findClaude(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    // intentional: `which claude` not on PATH — try known fallback
    const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not find claude CLI. Is it installed?");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const campaignId = process.argv[2];
  if (!campaignId) {
    console.error("Usage: run-orchestrator.ts <CAMP-NNN>");
    process.exit(1);
  }

  // Early breadcrumb — before any potentially-throwing init
  emitStartBreadcrumb(campaignId, "run-orchestrator");

  const hiveHome = resolveHiveHome();
  const campaignDir = join(hiveHome, "campaigns", campaignId);

  // Read config written by the CLI
  const configRaw = await readFile(join(campaignDir, "config.json"), "utf-8");
  const config = JSON.parse(configRaw) as {
    projectId: string;
    projectPath: string;
    goal: string;
    caps: CapsConfig;
    limits: CampaignLimits;
  };

  // Resolve dependencies
  const claudePath = findClaude();
  const identity = await assembleIdentity();
  const model = process.env.HIVE_DISPATCH_MODEL || "claude-opus-4-6";

  // Wire live executor — close over config that the orchestrator doesn't pass
  const executor: ExecutorFn = async (opts) => {
    return runIteration({
      ...opts,
      caps: config.caps,
      claudePath,
      model,
      identity,
      hiveHome,
    });
  };

  // Wire live judge — close over the live caller
  const judge: JudgeFn = async (opts) => {
    return runJudge({
      ...opts,
      caller: liveJudgeCaller,
    });
  };

  try {
    const result = await runCampaign({
      campaignId,
      limits: config.limits,
      executor,
      judge,
      hiveHome,
    });

    await writeCompletionArtifacts(result, hiveHome);

    // macOS notification
    try {
      execSync(
        `osascript -e 'display notification "${result.campaignId} ${result.terminationReason} (${result.iterationsCompleted} iterations, $${result.totalCostUsd.toFixed(2)})" with title "HIVE Campaign" sound name "Glass"'`,
        { stdio: "pipe" },
      );
    } catch { /* intentional: macOS notification is best-effort */ }

  } catch (err) {
    await writeCrashArtifacts(campaignId, err, hiveHome);

    try {
      execSync(
        `osascript -e 'display notification "${campaignId} crashed: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}" with title "HIVE Campaign" sound name "Basso"'`,
        { stdio: "pipe" },
      );
    } catch { /* intentional: macOS notification is best-effort */ }

    process.exit(1);
  }
}

main();
