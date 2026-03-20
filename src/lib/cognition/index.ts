/**
 * Cognition barrel — re-exports the task runners that are still needed
 * by tier1.ts, supervise.ts, and the gateway.
 *
 * The packet/workbench/working-set/materialize infrastructure has been
 * replaced by src/lib/context.ts and src/lib/worker-brief.ts.
 * This file keeps backward-compatible exports so existing callers
 * don't break during the migration.
 */

import { CognitionWorkbench } from "./workbench";
import { defaultCognitionWorkbench } from "./default-workbench";
import {
  cognitionTasks,
  compressCompletedRunOutputTask,
  logRollupTask,
  memoryHotsetTask,
  phaseSummaryTask,
  preprocessHumanMessageTask,
  staleMemoryTask,
  triageRunDiffForStewardTask,
  type CompressCompletedRunOutputInput,
  type LogRollupData,
  type LogRollupInput,
  type MemoryHotsetData,
  type MemoryHotsetInput,
  type PhaseSummaryData,
  type PhaseSummaryInput,
  type PreprocessHumanMessageInput,
  type StaleMemoryData,
  type StaleMemoryInput,
  type Tier1CloudTextRunner,
  type Tier1DiffTriageDecision,
  type Tier1HumanMessageClassification,
  type Tier1HumanMessagePreprocessResult,
  type TriageRunDiffForStewardInput,
} from "./tasks";

export {
  CognitionWorkbench,
  type CognitionWorkbenchOptions,
} from "./workbench";

export {
  cognitionTasks,
  compressCompletedRunOutputTask,
  logRollupTask,
  memoryHotsetTask,
  phaseSummaryTask,
  preprocessHumanMessageTask,
  staleMemoryTask,
  triageRunDiffForStewardTask,
  type CompressCompletedRunOutputInput,
  type LogRollupData,
  type LogRollupInput,
  type MemoryHotsetData,
  type MemoryHotsetInput,
  type PhaseSummaryData,
  type PhaseSummaryInput,
  type PreprocessHumanMessageInput,
  type StaleMemoryData,
  type StaleMemoryInput,
  type Tier1CloudTextRunner,
  type Tier1DiffTriageDecision,
  type Tier1HumanMessageClassification,
  type Tier1HumanMessagePreprocessResult,
  type TriageRunDiffForStewardInput,
} from "./tasks";

export { defaultCognitionWorkbench } from "./default-workbench";

// Re-export idle cognition utilities still used by supervise.ts
export {
  compileIdleProjectCognition,
  getLogRollupPacketPath,
  getPhaseSummaryPacketPath,
  readLogRollupDigest,
  type IdleCognitionResult,
} from "./idle";

// Re-export worker-brief from its new location for backward compat
export {
  getWorkerBriefPacketPath,
  materializeWorkerBriefPacket,
  type WorkerBriefPacketDetails,
} from "../worker-brief";

// --- Backward-compatible shims ---

import type { ProjectPaths } from "../paths";
import type {
  ActiveRunsSummary,
  BoardSummary,
  HumanInboxSummary,
  OpenMessagesSummary,
  RecentResultsSummary,
} from "../state";

/**
 * @deprecated — replaced by buildBootstrapContext in lib/context.ts.
 * This shim exists so CLI commands that haven't been updated yet still compile.
 */
export type CompilationMetrics = {
  compiledFields: number;
  fallbackFields: number;
  totalFields: number;
  hitRate: number;
  packetCount: number;
  workingSetTokenEstimate: number;
  maxPropagationDelayMs: number | null;
  avgPropagationDelayMs: number | null;
  oldestPacketAge: string | null;
  newestPacketAge: string | null;
};

export type CompiledStateView = {
  boardDigest: string;
  openDecisionsDigest: string;
  openMessagesDigest: string;
  activeRunsDigest: string;
  recentResultsDigest: string;
  humanInboxDigest: string;
  logRollupDigest: string | null;
  phaseSummaryDigest: string | null;
  memoryHotsetDigest: string | null;
  staleMemoryDigest: string | null;
  metrics: CompilationMetrics;
};

function renderOpenDecisionsCompat(
  boardSummary: BoardSummary,
  humanInboxSummary: HumanInboxSummary,
): string {
  const waitingOnHuman = humanInboxSummary.items
    .filter((item) => item.needsHumanReply)
    .map((item) => item.summary)
    .slice(0, 6);

  if (
    boardSummary.blockers.length === 0 &&
    boardSummary.decisions.length === 0 &&
    waitingOnHuman.length === 0
  ) {
    return "No open decisions, blockers, or pending human replies.";
  }

  const lines = [
    `Open decisions: ${boardSummary.blockers.length} blocker(s), ${boardSummary.decisions.length} recent decision(s), ${waitingOnHuman.length} pending human repl${waitingOnHuman.length === 1 ? "y" : "ies"}.`,
  ];
  for (const b of boardSummary.blockers.slice(0, 4)) lines.push(`- blocker: ${b}`);
  for (const h of waitingOnHuman.slice(0, 4)) lines.push(`- human: ${h}`);
  return lines.join("\n");
}

function renderRecentResultsCompat(recentResultsSummary: RecentResultsSummary): string {
  if (recentResultsSummary.items.length === 0) return "(none)";
  return recentResultsSummary.items
    .slice(0, 5)
    .map((item) => `- ${item.agentId} | ${item.status} | ${item.summary || "no visible output"}`)
    .join("\n");
}

function renderHumanInboxCompat(humanInboxSummary: HumanInboxSummary): string {
  if (humanInboxSummary.items.length === 0) return "(none)";
  return humanInboxSummary.items
    .slice(0, 6)
    .map((item) => `- ${item.from} -> ${item.to} [${item.type}] ${item.summary}`)
    .join("\n");
}

/**
 * @deprecated — replaced by buildBootstrapContext in lib/context.ts.
 * This shim renders digests directly from the fallback summaries.
 */
export async function buildCompiledStateView(input: {
  projectPaths: ProjectPaths;
  workingSet?: unknown;
  fallback: {
    boardSummary: BoardSummary;
    openMessagesSummary: OpenMessagesSummary;
    activeRunsSummary: ActiveRunsSummary;
    recentResultsSummary: RecentResultsSummary;
    humanInboxSummary: HumanInboxSummary;
  };
}): Promise<CompiledStateView> {
  const fb = input.fallback;
  return {
    boardDigest: fb.boardSummary.digest,
    openDecisionsDigest: renderOpenDecisionsCompat(fb.boardSummary, fb.humanInboxSummary),
    openMessagesDigest: fb.openMessagesSummary.digest,
    activeRunsDigest: fb.activeRunsSummary.digest,
    recentResultsDigest: renderRecentResultsCompat(fb.recentResultsSummary),
    humanInboxDigest: renderHumanInboxCompat(fb.humanInboxSummary),
    logRollupDigest: null,
    phaseSummaryDigest: null,
    memoryHotsetDigest: null,
    staleMemoryDigest: null,
    metrics: {
      compiledFields: 0,
      fallbackFields: 6,
      totalFields: 6,
      hitRate: 0,
      packetCount: 0,
      workingSetTokenEstimate: 0,
      maxPropagationDelayMs: null,
      avgPropagationDelayMs: null,
      oldestPacketAge: null,
      newestPacketAge: null,
    },
  };
}

// --- Tier-1 task runner wrappers ---

export async function compressCompletedRunOutput(
  input: CompressCompletedRunOutputInput,
) {
  const packet = await defaultCognitionWorkbench.runTask(
    compressCompletedRunOutputTask,
    input,
  );

  return packet?.data ?? null;
}

export async function preprocessHumanMessage(
  input: PreprocessHumanMessageInput,
) {
  const packet = await defaultCognitionWorkbench.runTask(
    preprocessHumanMessageTask,
    input,
  );

  return packet?.data ?? null;
}

export async function triageRunDiffForSteward(
  input: TriageRunDiffForStewardInput,
): Promise<Tier1DiffTriageDecision> {
  const packet = await defaultCognitionWorkbench.runTask(
    triageRunDiffForStewardTask,
    input,
  );

  if (!packet) {
    throw new Error("Diff triage task unexpectedly returned no packet.");
  }

  return packet.data;
}

export async function triageRunDiffsForSteward(
  inputs: TriageRunDiffForStewardInput[],
): Promise<Tier1DiffTriageDecision[]> {
  const packets = await defaultCognitionWorkbench.runBatch(
    triageRunDiffForStewardTask,
    inputs,
  );

  return packets.map((packet) => {
    if (!packet) {
      throw new Error("Diff triage task unexpectedly returned no packet.");
    }

    return packet.data;
  });
}
