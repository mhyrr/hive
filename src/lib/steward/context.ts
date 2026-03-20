import { renderCognitiveRoutingPromptPolicy } from "../cognitive-routing";
import { buildBootstrapContext } from "../context";
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
  identity: string;
  self: string;
  recentTurns: string;
  deltaHistory: DeltaHistoryEntry[];
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
  const [globalConfig, projectConfig, sessionMeta, sessionState, sessionPrompt, runtimeState, soul, identity, self, memoryContext, history] =
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
    openDecisionsDigest: renderOpenDecisionsFromState(runtimeState),
    openMessagesDigest: runtimeState.openMessagesSummary.digest,
    activeRunsDigest: runtimeState.activeRunsSummary.digest,
    recentResultsDigest: renderRecentResultsFromState(runtimeState),
    humanInboxDigest: renderHumanInboxFromState(runtimeState),
    logRollupDigest: null,
    phaseSummaryDigest: null,
    memoryHotsetDigest: null,
    staleMemoryDigest: null,
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

// ---------------------------------------------------------------------------
// Helpers — inline digest rendering from runtime state
// ---------------------------------------------------------------------------

import type { ProjectRuntimeState } from "../state";

function renderOpenDecisionsFromState(state: ProjectRuntimeState): string {
  const waitingOnHuman = state.humanInboxSummary.items
    .filter((item) => item.needsHumanReply)
    .map((item) => item.summary)
    .slice(0, 6);

  if (
    state.boardSummary.blockers.length === 0 &&
    state.boardSummary.decisions.length === 0 &&
    waitingOnHuman.length === 0
  ) {
    return "No open decisions, blockers, or pending human replies.";
  }

  const lines = [
    `Open decisions: ${state.boardSummary.blockers.length} blocker(s), ${state.boardSummary.decisions.length} recent decision(s), ${waitingOnHuman.length} pending human repl${waitingOnHuman.length === 1 ? "y" : "ies"}.`,
  ];

  for (const blocker of state.boardSummary.blockers.slice(0, 4)) {
    lines.push(`- blocker: ${blocker}`);
  }

  for (const item of waitingOnHuman.slice(0, 4)) {
    lines.push(`- human: ${item}`);
  }

  return lines.join("\n");
}

function renderRecentResultsFromState(state: ProjectRuntimeState): string {
  if (state.recentResultsSummary.items.length === 0) {
    return "(none)";
  }

  return state.recentResultsSummary.items
    .slice(0, 5)
    .map((item) => `- ${item.agentId} | ${item.status} | ${item.summary || "no visible output"}`)
    .join("\n");
}

function renderHumanInboxFromState(state: ProjectRuntimeState): string {
  if (state.humanInboxSummary.items.length === 0) {
    return "(none)";
  }

  return state.humanInboxSummary.items
    .slice(0, 6)
    .map((item) => `- ${item.from} -> ${item.to} [${item.type}] ${item.summary}`)
    .join("\n");
}
