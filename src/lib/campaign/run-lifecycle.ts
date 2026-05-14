/**
 * Campaign runner lifecycle helpers — shared by both run-orchestrator.ts (CLI)
 * and run-detached.ts (MCP tool).
 *
 * These helpers ensure consistent artifact production regardless of which
 * spawn path launched the campaign. Extracted after TK-104 investigation
 * revealed run-detached.ts was missing error.txt / result.txt writes.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { resolveHiveHome } from "../paths";
import type { CampaignResult } from "./orchestrator";

// ---------------------------------------------------------------------------
// Breadcrumb — first thing written, before any potentially-throwing init
// ---------------------------------------------------------------------------

/**
 * Write a start breadcrumb to stdout (which is redirected to orchestrator.log).
 * Call this as early as possible — before assembleIdentity, config reads, etc.
 */
export function emitStartBreadcrumb(campaignId: string, runner: string): void {
  console.log(
    `--- Campaign ${campaignId} starting at ${new Date().toISOString()} (runner: ${runner}) ---`,
  );
}

// ---------------------------------------------------------------------------
// Crash artifacts — written on unhandled exceptions
// ---------------------------------------------------------------------------

/**
 * Write crash artifacts to the campaign directory:
 * - status file set to "aborted"
 * - error.txt with the error message
 * - A log line to stderr (redirected to orchestrator.log)
 *
 * All writes are best-effort — the campaign dir may not exist if init itself failed.
 */
export async function writeCrashArtifacts(
  campaignId: string,
  err: unknown,
  hiveHome?: string,
): Promise<void> {
  const home = hiveHome ?? resolveHiveHome();
  const campaignDir = join(home, "campaigns", campaignId);
  const msg = err instanceof Error ? err.message : String(err);

  // Log to stderr → orchestrator.log
  console.error(`Campaign ${campaignId} crashed: ${msg}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }

  // Write status
  try {
    await writeFile(join(campaignDir, "status"), "aborted", "utf-8");
  } catch {
    /* intentional: campaign dir may not exist yet */
  }

  // Write error.txt
  try {
    const errorContent = err instanceof Error && err.stack
      ? `${msg}\n\n${err.stack}`
      : msg;
    await writeFile(join(campaignDir, "error.txt"), errorContent, "utf-8");
  } catch {
    /* intentional: best-effort error artifact write */
  }
}

// ---------------------------------------------------------------------------
// Completion artifacts — written after successful campaign run
// ---------------------------------------------------------------------------

/**
 * Write completion artifacts to the campaign directory:
 * - result.txt with a human-readable summary
 * - A log line to stdout (redirected to orchestrator.log)
 */
export async function writeCompletionArtifacts(
  result: CampaignResult,
  hiveHome?: string,
): Promise<void> {
  const home = hiveHome ?? resolveHiveHome();
  const campaignDir = join(home, "campaigns", result.campaignId);

  const summary = [
    `Campaign ${result.campaignId} finished.`,
    `  Reason: ${result.terminationReason}`,
    `  Iterations: ${result.iterationsCompleted}`,
    `  Cost: $${result.totalCostUsd.toFixed(2)}`,
    `  Tokens: ${result.totalTokens}`,
    `  Walltime: ${Math.round(result.totalWalltimeMs / 1000)}s`,
  ].join("\n");

  console.log(summary);

  try {
    await writeFile(join(campaignDir, "result.txt"), summary, "utf-8");
  } catch {
    /* intentional: best-effort result artifact write */
  }
}
