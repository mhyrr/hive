import { join } from "node:path";

import { readJson, writeJson } from "../json";
import {
  extractMemory,
  readProjectMemorySnapshot,
  type MemoryHeatState,
  type MemoryRecentDecisionsState,
  type MemorySummaryState,
} from "../memory";
import type { HivePaths, ProjectPaths } from "../paths";
import type { ProjectRuntimeState } from "../state";

import { defaultCognitionWorkbench } from "./default-workbench";
import {
  logRollupTask,
  type LogRollupData,
  memoryHotsetTask,
  type MemoryHotsetData,
  phaseSummaryTask,
  type PhaseSummaryData,
  staleMemoryTask,
  type StaleMemoryData,
} from "./tasks";
import type {
  CompilerCacheIndex,
  MaterializedPacket,
  MaterializedPacketRef,
} from "./packets";
import {
  mergeMaterializedPacketRefs,
  packetExpiresAt,
  toMaterializedPacketRef,
  upsertPacket,
} from "./packets";

export type IdleCognitionResult = {
  compilerCacheIndex: CompilerCacheIndex;
  packets: MaterializedPacketRef[];
  updatedCount: number;
};

function renderLogRollupSummary(data: LogRollupData): string {
  const logEntries = data.logEntries.length;
  const actors = [...new Set(data.logEntries.map((entry) => entry.actor))].slice(0, 3);
  const feedHeadlines = data.feedHeadlines.length;

  return `Recent log rollup: ${logEntries} log entr${logEntries === 1 ? "y" : "ies"}, ${feedHeadlines} feed headline(s)${actors.length > 0 ? `, actors: ${actors.join(", ")}` : ""}.`;
}

function renderPhaseSummarySummary(data: PhaseSummaryData): string {
  return `Phase summary: ${data.completedTasks.length} completed task(s), ${data.recentSuccessfulResults.length} recent successful run(s).`;
}

function renderMemoryHotsetSummary(data: MemoryHotsetData): string {
  return `Memory hotset: status ${data.projectStatus}, ${data.facts.length} fact(s), ${data.recentDecisions.length} decision(s), ${data.openQuestions.length} question(s).`;
}

function renderStaleMemorySummary(data: StaleMemoryData): string {
  return data.status === "review"
    ? `Stale memory review: ${data.reasons.length} issue(s) flagged.`
    : "Stale memory review: memory remains fresh.";
}

async function readMemoryArtifacts(paths: HivePaths): Promise<{
  summary: MemorySummaryState | null;
  heat: MemoryHeatState | null;
  recentDecisions: MemoryRecentDecisionsState | null;
}> {
  return {
    summary: await readJson<MemorySummaryState>(paths.memorySummaryFile),
    heat: await readJson<MemoryHeatState>(paths.memoryHeatFile),
    recentDecisions: await readJson<MemoryRecentDecisionsState>(paths.memoryRecentDecisionsFile),
  };
}

export function getLogRollupPacketPath(projectPaths: ProjectPaths): string {
  return join(projectPaths.statePacketLogRollupsDir, "recent.json");
}

export function getPhaseSummaryPacketPath(projectPaths: ProjectPaths): string {
  return join(projectPaths.statePacketPhaseSummariesDir, "current.json");
}

export async function readLogRollupDigest(projectPaths: ProjectPaths): Promise<string | null> {
  const packet = await readJson<MaterializedPacket>(getLogRollupPacketPath(projectPaths));

  if (!packet || packet.kind !== "log-rollup") {
    return null;
  }

  const details =
    packet.details && typeof packet.details === "object" && !Array.isArray(packet.details)
      ? packet.details as {
          logEntries?: Array<{ actor?: string; summary?: string }>;
          feedHeadlines?: string[];
        }
      : null;
  const lines = [packet.summary];

  for (const entry of details?.logEntries?.slice(0, 4) ?? []) {
    if (!entry?.summary) {
      continue;
    }

    lines.push(`- ${entry.actor ?? "unknown"}: ${entry.summary}`);
  }

  for (const headline of details?.feedHeadlines?.slice(0, 3) ?? []) {
    lines.push(`- ${headline}`);
  }

  return lines.join("\n");
}

export async function compileIdleProjectCognition(input: {
  hivePaths: HivePaths;
  projectId: string;
  projectPaths: ProjectPaths;
  plan: string;
  runtimeState: ProjectRuntimeState;
}): Promise<IdleCognitionResult> {
  await extractMemory({
    paths: input.hivePaths,
    announce: false,
  });

  const [logText, feedText, projectMemory, memoryArtifacts] = await Promise.all([
    Bun.file(input.projectPaths.log).text().catch(() => ""),
    Bun.file(input.hivePaths.feed).text().catch(() => ""),
    readProjectMemorySnapshot(input.hivePaths, input.projectId),
    readMemoryArtifacts(input.hivePaths),
  ]);

  const logRollup = await defaultCognitionWorkbench.runTask(logRollupTask, {
    projectId: input.projectId,
    logText,
    feedText,
  });
  const phaseSummary = await defaultCognitionWorkbench.runTask(phaseSummaryTask, {
    projectId: input.projectId,
    plan: input.plan,
    boardSummary: input.runtimeState.boardSummary,
    recentResultsSummary: input.runtimeState.recentResultsSummary,
  });
  const memoryHotset = await defaultCognitionWorkbench.runTask(memoryHotsetTask, {
    projectId: input.projectId,
    summary: memoryArtifacts.summary,
    heat: memoryArtifacts.heat,
    recentDecisions: memoryArtifacts.recentDecisions,
    projectMemory,
  });
  const staleMemory = await defaultCognitionWorkbench.runTask(staleMemoryTask, {
    projectId: input.projectId,
    heat: memoryArtifacts.heat,
    recentDecisions: memoryArtifacts.recentDecisions,
    projectMemory,
  });

  const packetWrites: Array<Promise<{ packet: MaterializedPacket; changed: boolean }>> = [];

  if (logRollup) {
    packetWrites.push(upsertPacket(getLogRollupPacketPath(input.projectPaths), {
      packetId: "recent",
      kind: "log-rollup",
      projectId: input.projectId,
      fingerprint: logRollup.fingerprint,
      producedAt: logRollup.compiledAt,
      expiresAt: packetExpiresAt(logRollup.compiledAt, logRollupTask.freshnessMs),
      tier: 0,
      summary: renderLogRollupSummary(logRollup.data),
      details: logRollup.data,
      source: {
        taskId: logRollup.taskId,
        trigger: logRollupTask.trigger,
        path: getLogRollupPacketPath(input.projectPaths),
      },
    }));
  }

  if (phaseSummary) {
    packetWrites.push(upsertPacket(getPhaseSummaryPacketPath(input.projectPaths), {
      packetId: "current",
      kind: "phase-summary",
      projectId: input.projectId,
      fingerprint: phaseSummary.fingerprint,
      producedAt: phaseSummary.compiledAt,
      expiresAt: packetExpiresAt(phaseSummary.compiledAt, phaseSummaryTask.freshnessMs),
      tier: 0,
      summary: renderPhaseSummarySummary(phaseSummary.data),
      details: phaseSummary.data,
      source: {
        taskId: phaseSummary.taskId,
        trigger: phaseSummaryTask.trigger,
        path: getPhaseSummaryPacketPath(input.projectPaths),
      },
    }));
  }

  if (memoryHotset) {
    packetWrites.push(upsertPacket(input.projectPaths.statePacketMemoryHotset, {
      packetId: "memory-hotset",
      kind: "memory-hotset",
      projectId: input.projectId,
      fingerprint: memoryHotset.fingerprint,
      producedAt: memoryHotset.compiledAt,
      expiresAt: packetExpiresAt(memoryHotset.compiledAt, memoryHotsetTask.freshnessMs),
      tier: 0,
      summary: renderMemoryHotsetSummary(memoryHotset.data),
      details: memoryHotset.data,
      source: {
        taskId: memoryHotset.taskId,
        trigger: memoryHotsetTask.trigger,
        path: input.projectPaths.statePacketMemoryHotset,
      },
    }));
  }

  if (staleMemory) {
    packetWrites.push(upsertPacket(input.projectPaths.statePacketStaleMemory, {
      packetId: "stale-memory",
      kind: "stale-memory",
      projectId: input.projectId,
      fingerprint: staleMemory.fingerprint,
      producedAt: staleMemory.compiledAt,
      expiresAt: packetExpiresAt(staleMemory.compiledAt, staleMemoryTask.freshnessMs),
      tier: 0,
      summary: renderStaleMemorySummary(staleMemory.data),
      details: staleMemory.data,
      source: {
        taskId: staleMemory.taskId,
        trigger: staleMemoryTask.trigger,
        path: input.projectPaths.statePacketStaleMemory,
      },
    }));
  }

  const settled = await Promise.all(packetWrites);
  const packetRefs = settled.map(({ packet }) => {
    const path =
      packet.kind === "log-rollup"
        ? getLogRollupPacketPath(input.projectPaths)
        : packet.kind === "phase-summary"
          ? getPhaseSummaryPacketPath(input.projectPaths)
          : packet.kind === "memory-hotset"
            ? input.projectPaths.statePacketMemoryHotset
            : input.projectPaths.statePacketStaleMemory;

    return toMaterializedPacketRef(packet, path);
  });
  const existingIndex = await readJson<CompilerCacheIndex>(input.projectPaths.stateCompilerCacheIndex);
  const compilerCacheIndex: CompilerCacheIndex = {
    projectId: input.projectId,
    revision: input.runtimeState.revision.revision,
    updatedAt: input.runtimeState.revision.updatedAt,
    packets: mergeMaterializedPacketRefs({
      existing: existingIndex?.packets ?? [],
      replaceKinds: ["log-rollup", "phase-summary", "memory-hotset", "stale-memory"],
      next: packetRefs,
    }),
  };

  await writeJson(input.projectPaths.stateCompilerCacheIndex, compilerCacheIndex);

  return {
    compilerCacheIndex,
    packets: packetRefs,
    updatedCount: settled.filter(({ changed }) => changed).length,
  };
}
