import { renderCognitiveRoutingPromptPolicy } from "../cognitive-routing";
import {
  buildBootstrapContext,
  renderOpenDecisions,
  renderRecentResults,
  renderHumanInbox,
} from "../context";
import { UsageError } from "../errors";
import { loadPromptMemoryContext } from "../memory";
import { type HivePaths, getProjectPaths, type ProjectPaths } from "../paths";
import { extractRepoPath } from "../project";
import {
  getProjectSessionState,
  getSession,
  getSessionHistory,
  getSessionPrompt,
  getSessionState,
} from "../sessions";
import {
  markSeenResultRunIds,
  readSeenResultRunIds,
  readStewardDeltaHistory,
  refreshProjectRuntimeState,
} from "../state";

import {
  type DeltaHistoryEntry,
  renderDeltaHistory,
  renderRecentTurns,
} from "./sections";

export type StewardContext = {
  globalConfig: string;
  projectConfig: string;
  projectPaths: ProjectPaths;
  repoPath: string;
  sessionPrompt: string;
  sessionRuntimeOverride: string | null;
  sessionModelOverride: string | null;
  sessionRuntime: string;
  sessionModel: string | null;
  sessionRevision: number;
  currentRevision: number;
  soul: string;
  identity: string;
  self: string;
  recentTurns: string;
  deltaHistory: DeltaHistoryEntry[];
  boardDigest: string;
  openDecisionsDigest: string;
  openMessagesDigest: string;
  activeRunsDigest: string;
  recentResultsDigest: string | null;
  humanInboxDigest: string;
  logRollupDigest?: string | null;
  phaseSummaryDigest?: string | null;
  memoryHotsetDigest?: string | null;
  staleMemoryDigest?: string | null;
  knowledgeDigest: string;
  recentDecisionsDigest: string;
  projectEntityDigest: string;
  memorySummaryPath: string;
  memoryHeatPath: string;
  recentDecisionsPath: string;
  projectEntitySummaryPath: string;
  journalPath: string;
};

export async function loadDeltaHistory(input: {
  projectPaths: ProjectPaths;
  lastSeenRevision: number;
}): Promise<DeltaHistoryEntry[]> {
  const packets = await readStewardDeltaHistory({
    projectPaths: input.projectPaths,
    sinceRevision: input.lastSeenRevision,
    limit: 12,
  });

  return packets.map((packet) => ({
    revision: packet.revision,
    changes: packet.changes.map((change) => change.summary),
  }));
}

export async function loadStewardContext(input: {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
  recentTurnLimit?: number;
}): Promise<StewardContext> {
  const projectPaths = getProjectPaths(input.hivePaths, input.projectId);
  const [globalConfig, projectConfig, sessionMeta, sessionState, sessionPrompt, runtimeState, soul, identity, self, memoryContext, history, seenRunIds] =
    await Promise.all([
      Bun.file(input.hivePaths.config).text().catch(() => ""),
      Bun.file(projectPaths.config).text(),
      getSession(input.hivePaths.sessionsDir, input.sessionId),
      getSessionState(input.hivePaths.sessionsDir, input.sessionId),
      getSessionPrompt(input.hivePaths.sessionsDir, input.sessionId),
      refreshProjectRuntimeState({
        hivePaths: input.hivePaths,
        projectId: input.projectId,
        projectPaths,
      }),
      Bun.file(input.hivePaths.soul).text().catch(() => ""),
      Bun.file(input.hivePaths.identity).text().catch(() => ""),
      Bun.file(input.hivePaths.self).text().catch(() => ""),
      loadPromptMemoryContext(input.hivePaths, input.projectId),
      getSessionHistory(input.hivePaths.sessionsDir, input.sessionId),
      readSeenResultRunIds(projectPaths),
    ]);

  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const sessionRevision = getProjectSessionState(sessionState, input.projectId).lastRevisionSeen;
  const deltaHistory = await loadDeltaHistory({
    projectPaths,
    lastSeenRevision: sessionRevision,
  });

  // Build the bootstrap context directly from the runtime state summaries.
  // This replaces the old buildCompiledStateView + working set packet reads.
  const bootstrapCtx = buildBootstrapContext({
    projectId: input.projectId,
    runtimeState,
  });

  // The bootstrap context is a single text block. We extract the individual
  // digest strings so the existing StewardContext shape stays compatible with
  // the prompts that consume it.
  return {
    globalConfig,
    projectConfig,
    projectPaths,
    repoPath,
    sessionPrompt,
    sessionRuntimeOverride: sessionMeta?.runtime ?? null,
    sessionModelOverride: sessionMeta?.model ?? null,
    sessionRuntime: sessionMeta?.runtime ?? "claude",
    sessionModel: sessionMeta?.model ?? null,
    sessionRevision,
    currentRevision: runtimeState.revision.revision,
    soul: soul.trim(),
    identity: identity.trim(),
    self: self.trim(),
    recentTurns: renderRecentTurns(history, input.recentTurnLimit ?? 6),
    deltaHistory,
    boardDigest: runtimeState.boardSummary.digest,
    openDecisionsDigest: renderOpenDecisions(runtimeState.boardSummary, runtimeState.humanInboxSummary),
    openMessagesDigest: runtimeState.openMessagesSummary.digest,
    activeRunsDigest: runtimeState.activeRunsSummary.digest,
    recentResultsDigest: await (async () => {
      const newItems = runtimeState.recentResultsSummary.items.filter(
        (item) => !seenRunIds.has(item.runId),
      );
      if (newItems.length > 0) {
        await markSeenResultRunIds(projectPaths, newItems.map((item) => item.runId));
      }
      return newItems.length > 0
        ? renderRecentResults({ ...runtimeState.recentResultsSummary, items: newItems })
        : null;
    })(),
    humanInboxDigest: renderHumanInbox(runtimeState.humanInboxSummary),
    // logRollupDigest, phaseSummaryDigest, memoryHotsetDigest, staleMemoryDigest:
    // omitted — these were produced by the old cognition packet compiler which
    // was removed. When idle compilation is re-added, populate them here.
    knowledgeDigest: memoryContext.globalKnowledgeDigest,
    recentDecisionsDigest: memoryContext.recentDecisionsDigest,
    projectEntityDigest: memoryContext.projectEntityDigest,
    memorySummaryPath: memoryContext.memorySummaryPath,
    memoryHeatPath: memoryContext.memoryHeatPath,
    recentDecisionsPath: memoryContext.recentDecisionsPath,
    projectEntitySummaryPath: memoryContext.projectEntitySummaryPath,
    journalPath: memoryContext.journalPath,
  };
}

export function renderStewardRoutingPolicy(input: {
  globalConfig: string;
  skillsDir: string;
  sessionRuntime?: string | null;
  sessionModel?: string | null;
}): string {
  return renderCognitiveRoutingPromptPolicy({
    globalConfig: input.globalConfig,
    skillsDir: input.skillsDir,
    sessionRuntime: input.sessionRuntime ?? undefined,
    sessionModel: input.sessionModel ?? undefined,
  });
}

export { renderDeltaHistory };

