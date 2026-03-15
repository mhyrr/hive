import { UsageError } from "./errors";
import { appendFeedEntry } from "./feed";
import { captureGitStatusSnapshot, diffGitStatusSnapshots } from "./git";
import { appendLogEntry } from "./log";
import { loadPromptMemoryContext } from "./memory";
import { HivePaths, getProjectPaths, ProjectPaths } from "./paths";
import { extractRepoPath } from "./project";
import {
  createRunDraft,
  finalizeRun,
  getRunOutputPath,
  markRunActive,
  reconcileActiveConsoleRun,
  readActiveRun,
  readRunRecord,
  RunRecord,
  writeRunResult,
} from "./runs";
import {
  getProjectSessionState,
  getSession,
  getSessionHistory,
  getSessionPrompt,
  getSessionState,
  switchSessionProject,
  updateSessionProjectState,
} from "./sessions";
import { readStewardDeltaHistory, refreshProjectRuntimeState } from "./state";
import {
  buildLaunchSpec,
  formatRuntimeTokenSummary,
  inferRuntimeAuthMode,
  LaunchResult,
  resolveRuntimeHints,
  startLaunchSpec,
  validateRuntimeInstalled,
} from "./runtime";

type DeltaHistoryEntry = {
  revision: number;
  changes: string[];
};

export type StewardTurnResult =
  | {
      mode: "direct";
      run: RunRecord;
      result: LaunchResult;
      finalRun: RunRecord;
      streamedOutput: string;
      finalVisibleOutput: string;
    }
  | {
      mode: "fallback";
      reason: string;
    };

type DirectStewardTurnInput = {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
  humanMessage: string;
  onOutput?: (content: string) => Promise<void> | void;
};

type StewardPromptContext = {
  projectId: string;
  repoPath: string;
  hivePaths: HivePaths;
  projectPaths: ProjectPaths;
  sessionId: string;
  sessionPrompt: string;
  sessionStateRevision: number;
  currentRevision: number;
  deltaHistory: DeltaHistoryEntry[];
  recentTurns: string;
  soul: string;
  identityPath: string;
  selfPath: string;
  agentsPath: string;
  trustPath: string;
  memorySummaryPath: string;
  memoryHeatPath: string;
  recentDecisionsPath: string;
  projectEntitySummaryPath: string;
  journalPath: string;
  boardDigest: string;
  openMessagesDigest: string;
  activeRunsDigest: string;
  recentResultsDigest: string;
  humanInboxDigest: string;
  knowledgeDigest: string;
  recentDecisionsDigest: string;
  projectEntityDigest: string;
  humanMessage: string;
};

function buildUsageDetails(
  runtime: string,
  metadata: LaunchResult["metadata"],
): string[] {
  const details: string[] = [];
  const authMode = metadata?.authMode ?? inferRuntimeAuthMode(runtime);
  const tokenSummary = formatRuntimeTokenSummary(metadata);

  details.push(`auth: ${authMode}`);

  if (metadata?.durationMs) {
    details.push(`duration: ${(metadata.durationMs / 1000).toFixed(1)}s`);
  }

  if (metadata?.numTurns) {
    details.push(`turns: ${metadata.numTurns}`);
  }

  if (tokenSummary) {
    details.push(`tokens: ${tokenSummary}`);
  }

  if (metadata?.costUsd != null) {
    details.push(`cost: $${metadata.costUsd.toFixed(4)}`);
  }

  return details;
}

async function readRunOutputDelta(
  run: RunRecord,
  seenLength: number,
): Promise<{ nextLength: number; content: string | null }> {
  const file = Bun.file(getRunOutputPath(run));

  if (!(await file.exists())) {
    return {
      nextLength: seenLength,
      content: null,
    };
  }

  const rawText = await file.text().catch(() => null);

  if (rawText === null) {
    return {
      nextLength: seenLength,
      content: null,
    };
  }

  const raw = rawText.replace(/\r\n/g, "\n");

  if (raw.length <= seenLength) {
    return {
      nextLength: raw.length,
      content: null,
    };
  }

  const delta = raw.slice(seenLength);

  return {
    nextLength: raw.length,
    content: delta.trim() ? delta : null,
  };
}

function renderRecentTurns(turns: Awaited<ReturnType<typeof getSessionHistory>>): string {
  const recent = turns.slice(-8);

  if (recent.length === 0) {
    return "(no prior conversation)";
  }

  return recent
    .map((turn) => `### ${turn.role} (${turn.ts})\n${turn.content}`)
    .join("\n\n");
}

function renderDeltaHistory(deltaHistory: DeltaHistoryEntry[], lastSeenRevision: number): string {
  if (lastSeenRevision === 0 || deltaHistory.length === 0) {
    return "(bootstrap: no prior session revision)";
  }

  return deltaHistory
    .map((entry) =>
      [`### revision ${entry.revision}`, ...entry.changes.map((change) => `- ${change}`)].join("\n"),
    )
    .join("\n\n");
}

function renderRecentResultsDigest(
  items: Awaited<ReturnType<typeof refreshProjectRuntimeState>>["recentResultsSummary"]["items"],
): string {
  if (items.length === 0) {
    return "(none)";
  }

  return items
    .slice(0, 5)
    .map((item) => `- ${item.agentId} | ${item.status} | ${item.summary || "no visible output"}`)
    .join("\n");
}

function renderHumanInboxDigest(
  items: Awaited<ReturnType<typeof refreshProjectRuntimeState>>["humanInboxSummary"]["items"],
): string {
  if (items.length === 0) {
    return "(none)";
  }

  return items
    .slice(0, 6)
    .map((item) => `- ${item.from} -> ${item.to} [${item.type}] ${item.summary}`)
    .join("\n");
}

function buildStewardTurnPrompt(input: StewardPromptContext): string {
  return `${input.sessionPrompt || "# HIVE Steward Session"}

You are the live steward for project ${input.projectId}. This is a continuing conversation with the human, not a fresh orchestrator bootstrap. Use the compact state and delta history first. Only read raw files when the current turn actually requires it.

## Session Contract
- session: ${input.sessionId}
- current-revision: ${input.currentRevision}
- last-revision-seen-in-session: ${input.sessionStateRevision}

## Shared Soul
${input.soul}

Read agent identity: ${input.identityPath}
Read user preferences: ${input.selfPath}
Read operational doctrine: ${input.agentsPath}
Read trust policy: ${input.trustPath}

## Operating Rules
- Answer the human directly and concretely.
- Treat each turn as a routing decision: direct answer, deeper state inspection, or plural synthesis.
- Optimize for expected answer quality, not raw latency.
- If action is needed, do it yourself through files or \`hive\` commands. Do not tell the human to operate the system for you.
- BOARD.md is steward-owned. Update it directly when plan/task state changes.
- When you delegate, create assignment messages with \`task:\`, \`launch: auto\`, and \`scope:\`.
- If the answer would materially improve from multiple perspectives, use the configured team and synthesize instead of defaulting to a solo reply.
- If fresh worker output already covers the needed perspectives, use it instead of re-running work.
- Keep LOG.md and feed.md high signal.
- Use the compact runtime state first; raw markdown reads should be targeted.
- Always end with visible text for the human. If you only make tool calls, the session will look broken.

## Project
- repo: ${input.repoPath}
- project-config: ${input.projectPaths.config}
- PLAN.md: ${input.projectPaths.plan}
- BOARD.md: ${input.projectPaths.board}
- LOG.md: ${input.projectPaths.log}
- project-memory: ${input.projectPaths.memory}
- memory-summary-json: ${input.memorySummaryPath}
- memory-heat-json: ${input.memoryHeatPath}
- recent-decisions-json: ${input.recentDecisionsPath}
- project-entity-summary: ${input.projectEntitySummaryPath}
- journal: ${input.journalPath}
- messages-dir: ${input.hivePaths.msgDir}
- state-dir: ${input.projectPaths.stateDir}
- board-summary-json: ${input.projectPaths.stateBoardSummary}
- open-messages-json: ${input.projectPaths.stateOpenMessages}
- active-runs-json: ${input.projectPaths.stateActiveRuns}
- recent-results-json: ${input.projectPaths.stateRecentResults}
- human-inbox-json: ${input.projectPaths.stateHumanInbox}
- latest-delta-json: ${input.projectPaths.stateStewardDelta}
- delta-history-jsonl: ${input.projectPaths.stateDeltaHistory}

## Compact State
### Board
${input.boardDigest}

### Open Messages
${input.openMessagesDigest}

### Active Runs
${input.activeRunsDigest}

### Recent Results
${input.recentResultsDigest}

### Human Inbox
${input.humanInboxDigest}

## Durable Memory
### Global Knowledge
${input.knowledgeDigest}

### Recent Decisions
${input.recentDecisionsDigest}

### Project Entity Memory
${input.projectEntityDigest}

## Delta Since Last Seen
${renderDeltaHistory(input.deltaHistory, input.sessionStateRevision)}

## Recent Conversation
${input.recentTurns}

## Human Turn
${input.humanMessage}`;
}

async function loadDeltaHistory(input: {
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

export async function runDirectStewardTurn(
  input: DirectStewardTurnInput,
): Promise<StewardTurnResult> {
  const projectPaths = getProjectPaths(input.hivePaths, input.projectId);
  const [globalConfig, projectConfig, sessionMeta, sessionState, sessionPrompt] =
    await Promise.all([
      Bun.file(input.hivePaths.config).text().catch(() => ""),
      Bun.file(projectPaths.config).text(),
      getSession(input.hivePaths.sessionsDir, input.sessionId),
      getSessionState(input.hivePaths.sessionsDir, input.sessionId),
      getSessionPrompt(input.hivePaths.sessionsDir, input.sessionId),
    ]);

  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const hints = resolveRuntimeHints({
    globalConfig,
    runtimeOverride: sessionMeta?.runtime ?? null,
    modelOverride: sessionMeta?.model ?? null,
  });

  await reconcileActiveConsoleRun(projectPaths);

  try {
    await validateRuntimeInstalled(hints.runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: "fallback",
      reason: message,
    };
  }

  const existingConsoleRun = await readActiveRun(projectPaths, "console");

  if (existingConsoleRun) {
    return {
      mode: "fallback",
      reason: `console run already active (${existingConsoleRun.runId})`,
    };
  }

  const runtimeState = await refreshProjectRuntimeState({
    hivePaths: input.hivePaths,
    projectId: input.projectId,
    projectPaths,
  });

  const deltaHistory = await loadDeltaHistory({
    projectPaths,
    lastSeenRevision: getProjectSessionState(sessionState, input.projectId).lastRevisionSeen,
  });
  const soul = await Bun.file(input.hivePaths.soul).text().catch(() => "");
  const memoryContext = await loadPromptMemoryContext(input.hivePaths, input.projectId);
  const recentTurns = renderRecentTurns(
    await getSessionHistory(input.hivePaths.sessionsDir, input.sessionId),
  );
  const prompt = buildStewardTurnPrompt({
    projectId: input.projectId,
    repoPath,
    hivePaths: input.hivePaths,
    projectPaths,
    sessionId: input.sessionId,
    sessionPrompt,
    sessionStateRevision: getProjectSessionState(sessionState, input.projectId).lastRevisionSeen,
    currentRevision: runtimeState.revision.revision,
    deltaHistory,
    recentTurns,
    soul: soul.trim(),
    identityPath: input.hivePaths.identity,
    selfPath: input.hivePaths.self,
    agentsPath: input.hivePaths.agents,
    trustPath: input.hivePaths.trust,
    memorySummaryPath: memoryContext.memorySummaryPath,
    memoryHeatPath: memoryContext.memoryHeatPath,
    recentDecisionsPath: memoryContext.recentDecisionsPath,
    projectEntitySummaryPath: memoryContext.projectEntitySummaryPath,
    journalPath: memoryContext.journalPath,
    boardDigest: runtimeState.boardSummary.digest,
    openMessagesDigest: runtimeState.openMessagesSummary.digest,
    activeRunsDigest: runtimeState.activeRunsSummary.digest,
    recentResultsDigest: renderRecentResultsDigest(runtimeState.recentResultsSummary.items),
    humanInboxDigest: renderHumanInboxDigest(runtimeState.humanInboxSummary.items),
    knowledgeDigest: memoryContext.globalKnowledgeDigest,
    recentDecisionsDigest: memoryContext.recentDecisionsDigest,
    projectEntityDigest: memoryContext.projectEntityDigest,
    humanMessage: input.humanMessage,
  });

  const beforeGit = captureGitStatusSnapshot(repoPath);
  const spec = buildLaunchSpec({
    runtime: hints.runtime,
    model: hints.model,
    repoPath,
    hiveHome: input.hivePaths.home,
    prompt,
  });

  let run = await createRunDraft({
    projectId: input.projectId,
    projectPaths,
    agentId: "console",
    runtime: spec.runtime,
    model: spec.model,
    prompt,
    source: "console",
    sourceMessage: input.sessionId,
  });

  await appendLogEntry(
    projectPaths.log,
    "hive steward session",
    `Direct steward turn started for session ${input.sessionId}`,
  );
  await appendFeedEntry(input.hivePaths, {
    project: input.projectId,
    headline: "Steward turn started",
    details: [
      `session: ${input.sessionId}`,
      `runtime: ${spec.runtime}`,
      `auth: ${inferRuntimeAuthMode(spec.runtime)}`,
    ],
  });

  const handle = startLaunchSpec(spec, repoPath, {
    outputPath: getRunOutputPath(run),
    quiet: true,
  });
  run = await markRunActive(projectPaths, run, handle.pid);

  let streamedOutput = "";
  let seenLength = 0;
  let settled = false;
  let launchError: unknown = null;
  let launchResult: LaunchResult | null = null;
  const waitPromise = handle
    .wait()
    .then((result) => {
      launchResult = result;
      settled = true;
    })
    .catch((error) => {
      launchError = error;
      settled = true;
    });

  while (!settled) {
    const update = await readRunOutputDelta(run, seenLength);
    seenLength = update.nextLength;

    if (update.content) {
      streamedOutput += update.content;
      await input.onOutput?.(update.content);
    }

    await Bun.sleep(500);
  }

  await waitPromise;

  const finalUpdate = await readRunOutputDelta(run, seenLength);
  if (finalUpdate.content) {
    streamedOutput += finalUpdate.content;
    await input.onOutput?.(finalUpdate.content);
  }

  if (launchError) {
    const persisted = (await readRunRecord(run.path)) ?? run;
    const failedRun = await finalizeRun({
      projectPaths,
      run: persisted,
      status: "failed",
      exitCode: null,
    });
    await writeRunResult(failedRun, {
      changedFiles: [],
      gitSummaryLines: ["direct steward turn failed before exit"],
      finalVisibleOutput: streamedOutput,
    });
    throw launchError;
  }

  const persistedRun = (await readRunRecord(run.path)) ?? run;
  const stopRequested = Boolean(persistedRun.stopRequestedAt);
  const finalRun = await finalizeRun({
    projectPaths,
    run: persistedRun,
    status: stopRequested
      ? "cancelled"
      : launchResult?.signal || (launchResult?.code !== null && launchResult?.code !== 0)
        ? "failed"
        : "exited",
    exitCode: launchResult?.code ?? null,
  });
  const afterGit = captureGitStatusSnapshot(repoPath);
  const gitDelta = diffGitStatusSnapshots(beforeGit, afterGit);
  const finalVisibleOutput = launchResult?.visibleOutput?.trim() || streamedOutput.trim();

  await writeRunResult(finalRun, {
    changedFiles: gitDelta.changedFiles,
    gitSummaryLines: gitDelta.summaryLines,
    finalVisibleOutput,
    authMode: launchResult?.metadata?.authMode ?? inferRuntimeAuthMode(spec.runtime),
    costUsd: launchResult?.metadata?.costUsd ?? null,
    durationMs: launchResult?.metadata?.durationMs ?? null,
    numTurns: launchResult?.metadata?.numTurns ?? null,
    inputTokens: launchResult?.metadata?.inputTokens ?? null,
    outputTokens: launchResult?.metadata?.outputTokens ?? null,
    cacheCreationInputTokens: launchResult?.metadata?.cacheCreationInputTokens ?? null,
    cacheReadInputTokens: launchResult?.metadata?.cacheReadInputTokens ?? null,
    totalTokens: launchResult?.metadata?.totalTokens ?? null,
  });

  const refreshedState = await refreshProjectRuntimeState({
    hivePaths: input.hivePaths,
    projectId: input.projectId,
    projectPaths,
  });
  await switchSessionProject({
    sessionsDir: input.hivePaths.sessionsDir,
    sessionId: input.sessionId,
    projectId: input.projectId,
  });
  await updateSessionProjectState({
    sessionsDir: input.hivePaths.sessionsDir,
    sessionId: input.sessionId,
    projectId: input.projectId,
    lastRevisionSeen: refreshedState.revision.revision,
    lastRunId: finalRun.runId,
  });

  await appendFeedEntry(input.hivePaths, {
    project: input.projectId,
    headline: "Steward turn completed",
    details: [
      `session: ${input.sessionId}`,
      `run: ${finalRun.runId}`,
      `exit: ${launchResult?.code ?? "unknown"}${launchResult?.signal ? ` | signal: ${launchResult.signal}` : ""}`,
      ...buildUsageDetails(spec.runtime, launchResult?.metadata ?? null),
    ],
  });

  return {
    mode: "direct",
    run,
    result: launchResult!,
    finalRun,
    streamedOutput: streamedOutput.trim(),
    finalVisibleOutput,
  };
}
