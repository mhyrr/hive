import { renderCognitiveRoutingPromptPolicy } from "../cognitive-routing";
import { buildCompiledStateView } from "../cognition";
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
import { readStewardDeltaHistory, refreshProjectRuntimeState } from "../state";

import {
  type DeltaHistoryEntry,
  renderDeltaHistory,
  renderRecentTurns,
} from "./sections";

export type StewardContext = {
  globalConfig: string;
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
  recentTurns: string;
  deltaHistory: DeltaHistoryEntry[];
  boardDigest: string;
  openMessagesDigest: string;
  activeRunsDigest: string;
  recentResultsDigest: string;
  humanInboxDigest: string;
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
  const [globalConfig, projectConfig, sessionMeta, sessionState, sessionPrompt, runtimeState, soul, memoryContext, history] =
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
      loadPromptMemoryContext(input.hivePaths, input.projectId),
      getSessionHistory(input.hivePaths.sessionsDir, input.sessionId),
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
  const compiledState = await buildCompiledStateView({
    projectPaths,
    workingSet: runtimeState.workingSet,
    fallback: {
      boardSummary: runtimeState.boardSummary,
      openMessagesSummary: runtimeState.openMessagesSummary,
      activeRunsSummary: runtimeState.activeRunsSummary,
      recentResultsSummary: runtimeState.recentResultsSummary,
      humanInboxSummary: runtimeState.humanInboxSummary,
    },
  });

  return {
    globalConfig,
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
    recentTurns: renderRecentTurns(history, input.recentTurnLimit ?? 6),
    deltaHistory,
    boardDigest: compiledState.boardDigest,
    openMessagesDigest: compiledState.openMessagesDigest,
    activeRunsDigest: compiledState.activeRunsDigest,
    recentResultsDigest: compiledState.recentResultsDigest,
    humanInboxDigest: compiledState.humanInboxDigest,
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
