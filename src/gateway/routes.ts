import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GatewayBroadcast, GatewayOptions } from "./server";

import { feedCommand } from "../commands/feed";
import { parseStructuredFeedEntries } from "../lib/feed";
import {
  buildCognitiveRoutingSnapshot,
  renderCognitiveExecutionSummary,
  renderCognitiveRoutingInspectionSnapshot,
  resolveCognitiveExecutionLane,
} from "../lib/cognitive-routing";
import { refreshProjectCognitiveUsageSnapshot } from "../lib/cognitive-usage";
import { inboxCommand } from "../commands/inbox";
import { logCommand } from "../commands/log";
import { msgCommand, nudgeCommand } from "../commands/msg";
import { psCommand } from "../commands/ps";
import { sayCommand, sendGoalToProject } from "../commands/say";
import { statusCommand } from "../commands/status";
import { getActiveProject, getProjectPaths, listProjects, type HivePaths } from "../lib/paths";
import { runtimesCommand } from "../commands/runtimes";
import {
  getRunOutputPath,
  listActiveRuns,
  markRunStopRequested,
  readActiveRun,
  readRunRecord,
  readRunOutputTail,
  reconcileActiveConsoleRun,
  type RunRecord,
  type RunResult,
} from "../lib/runs";
import {
  reconcileDetachedSupervisorState,
  startDetachedSupervisor,
} from "../lib/detached-supervisor";
import { isProcessAlive, DEFAULT_MAX_PARALLEL, DEFAULT_SUPERVISOR_INTERVAL_SECONDS } from "../lib/supervisor";
import {
  createSession,
  getActiveSession,
  getPendingSessionTurns,
  getSession,
  getSessionHistory,
  getSessionState,
  listSessions,
  appendTurn,
  enqueuePendingSessionTurn,
  switchSessionProject,
  takePendingSessionTurns,
  updateSessionMeta,
  updateSessionProjectState,
  type SessionTurnDetails,
} from "../lib/sessions";
import {
  readStewardDeltaHistory,
  refreshProjectRuntimeState,
  type ProjectRuntimeState,
} from "../lib/state";
import { runDirectStewardTurn } from "../lib/steward";
import {
  abortPersistentStewardTurn,
  isPersistentStewardTurnActive,
  runPersistentStewardTurn,
} from "../lib/persistent-steward";
import { getAdapter, listRuntimeAdapters, resolveRuntimeHints } from "../lib/runtime";
import {
  findPlanAgent,
  normalizeProjectName,
  parseDefaultTeam,
  stripRuntimeHintsFromDescriptor,
} from "../lib/project";
import { UsageError } from "../lib/errors";
import { listApprovals, type ApprovalRequest } from "../lib/approvals";
import { listRecentEvents, type EventRecord } from "../lib/events";
import { preprocessHumanMessage } from "../lib/tier1";
import { now, toIsoTimestamp } from "../lib/time";

const pendingSessionTurnDrains = new Map<string, Promise<void>>();

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonOk(data: string | object): Response {
  const body = typeof data === "string" ? { result: data } : data;
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function buildOpenInvocation(input: {
  path: string;
  line?: number | null;
}): { command: string; args: string[]; strategy: "default-app" | "editor-cli" } {
  const normalizedPath = input.path.trim();
  const line = input.line ?? null;
  const explicitCommand = process.env.HIVE_OPEN_COMMAND?.trim();

  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: line ? [`${normalizedPath}:${line}`] : [normalizedPath],
      strategy: "editor-cli",
    };
  }

  const explicitEditorCli = process.env.HIVE_EDITOR_CLI?.trim();

  if (explicitEditorCli) {
    return {
      command: explicitEditorCli,
      args: line ? ["--goto", `${normalizedPath}:${line}`] : [normalizedPath],
      strategy: "editor-cli",
    };
  }

  if (process.platform === "darwin") {
    return {
      command: "open",
      args: [normalizedPath],
      strategy: "default-app",
    };
  }

  if (process.platform === "linux") {
    return {
      command: "xdg-open",
      args: [normalizedPath],
      strategy: "default-app",
    };
  }

  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", "", normalizedPath],
      strategy: "default-app",
    };
  }

  throw new UsageError(`Unsupported platform for opening files: ${process.platform}`);
}

async function openLocalPath(input: {
  path: string;
  line?: number | null;
}): Promise<{ strategy: "default-app" | "editor-cli" }> {
  const normalizedPath = input.path.trim();

  if (!normalizedPath) {
    throw new UsageError("Missing path");
  }

  if (!normalizedPath.startsWith("/")) {
    throw new UsageError("Path must be absolute");
  }

  const file = Bun.file(normalizedPath);

  if (!(await file.exists())) {
    throw new UsageError(`File not found: ${normalizedPath}`);
  }

  const invocation = buildOpenInvocation({
    path: normalizedPath,
    line: input.line ?? null,
  });

  Bun.spawn([invocation.command, ...invocation.args], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  return {
    strategy: invocation.strategy,
  };
}

export function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

async function appendSessionTurnAndBroadcast(input: {
  options: GatewayOptions;
  broadcast: GatewayBroadcast;
  sessionId: string;
  project: string;
  role: "human" | "assistant";
  content: string;
  source?: "human" | "system" | "model" | null;
  details?: SessionTurnDetails | null;
}): Promise<void> {
  const sessionsDir = join(input.options.hivePaths.home, "sessions");
  const eventTs = new Date().toISOString();

  await appendTurn({
    sessionsDir,
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    source: input.source ?? (input.role === "human" ? "human" : "system"),
    details: input.details ?? null,
  });

  input.broadcast({
    type: "session-message",
    ts: eventTs,
    project: input.project,
    data: {
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      source: input.source ?? (input.role === "human" ? "human" : "system"),
      details: input.details ?? null,
      ts: eventTs,
    },
  });

  scheduleProjectRuntimeRefresh({
    hivePaths: input.options.hivePaths,
    projectId: input.project,
  });
}

function broadcastSessionStream(input: {
  broadcast: GatewayBroadcast;
  sessionId: string;
  project: string;
  content: string;
}): void {
  const content = input.content.trim();

  if (!content) {
    return;
  }

  input.broadcast({
    type: "session-stream",
    ts: new Date().toISOString(),
    project: input.project,
    data: {
      sessionId: input.sessionId,
      content,
    },
  });
}

function normalizeStatusNote(note: string): string {
  return note.replace(/\r\n/g, "\n").trim();
}

function pushStatusNote(notes: string[], note: string): void {
  const normalized = normalizeStatusNote(note);

  if (!normalized || notes.includes(normalized)) {
    return;
  }

  notes.push(normalized);
}

function formatQueuedTurnBatchMessage(input: {
  batch: Array<{ content: string; ts: string }>;
}): string {
  if (input.batch.length === 0) {
    return "";
  }

  if (input.batch.length === 1) {
    return input.batch[0]!.content;
  }

  const lines = [
    "These follow-up messages arrived while you were still responding. Treat them as the next human turn and address them together in one reply.",
    "",
  ];

  for (const item of input.batch) {
    lines.push(`### ${formatActivityTime(item.ts) ?? item.ts}`);
    lines.push(item.content);
    lines.push("");
  }

  return lines.join("\n").trim();
}

function buildQueuedFollowUpLead(queuedCount: number): string {
  const countLabel = `${queuedCount} follow-up${queuedCount === 1 ? "" : "s"}`;
  return `I'm still in the middle of a live steward turn, so I queued your latest note and will pick it up next. ${countLabel} ${queuedCount === 1 ? "is" : "are"} waiting behind the current reply.`;
}

function buildInterruptedFollowUpLead(queuedCount: number): string {
  const countLabel = `${queuedCount} follow-up${queuedCount === 1 ? "" : "s"}`;
  return `I'm interrupting the current live steward draft so you don't have to wait for it to finish. ${countLabel} ${queuedCount === 1 ? "is" : "are"} lined up behind the restart.`;
}

function shouldPreemptLiveStewardTurn(input: {
  sessionId: string;
  run: RunRecord;
}): boolean {
  return input.run.source === "console" && input.run.sourceMessage === input.sessionId;
}

async function requestConsoleRunStop(input: {
  projectPaths: ReturnType<typeof getProjectPaths>;
  run: RunRecord;
  actor: string;
}): Promise<void> {
  await markRunStopRequested(input.run, input.actor);

  if (!input.run.pid || input.run.pid === process.pid) {
    return;
  }

  try {
    process.kill(input.run.pid, "SIGTERM");
  } catch {
    return;
  }

  void Bun.sleep(1_500).then(async () => {
    const activeRun = await readActiveRun(input.projectPaths, "console");

    if (
      activeRun?.runId === input.run.runId &&
      activeRun.pid === input.run.pid &&
      isProcessAlive(input.run.pid)
    ) {
      try {
        process.kill(input.run.pid, "SIGKILL");
      } catch {
        // Process already exited.
      }
    }
  });
}

function formatRuntimeSelection(runtime: string, model: string | null): string {
  return model ? `${runtime} (${model})` : `${runtime} (default model)`;
}

type SessionTurnRoutingDetails = NonNullable<SessionTurnDetails["routing"]>;

async function readGatewayGlobalConfig(options: GatewayOptions): Promise<string> {
  return Bun.file(options.hivePaths.config).text().catch(() => "");
}

function normalizeRoutingTrace(trace: string[] | undefined): string[] {
  return [...new Set((trace ?? []).map(normalizeStatusNote).filter(Boolean))];
}

function buildSessionTurnRouting(input: {
  tier: SessionTurnRoutingDetails["tier"];
  mode?: SessionTurnRoutingDetails["mode"];
  handledBy?: string | null;
  globalConfig: string;
  runtime?: string | null;
  model?: string | null;
  persistentStewardEnabled?: boolean;
  laneOverride?: string | null;
  fanOutUsed?: number | null;
  parallelismUsed?: number | null;
  reusedFreshWorkerOutput?: boolean | null;
  trace?: string[];
}): SessionTurnRoutingDetails {
  const execution = resolveCognitiveExecutionLane({
    globalConfig: input.globalConfig,
    runtime: input.runtime ?? null,
    selectedModel: input.model ?? null,
    persistentStewardEnabled: input.persistentStewardEnabled,
  });

  return {
    tier: input.tier,
    mode: input.mode ?? null,
    handledBy: input.handledBy ?? null,
    lane: input.laneOverride?.trim() || renderCognitiveExecutionSummary(execution),
    fanOutUsed: input.fanOutUsed ?? null,
    parallelismUsed: input.parallelismUsed ?? null,
    reusedFreshWorkerOutput: input.reusedFreshWorkerOutput ?? null,
    trace: normalizeRoutingTrace(input.trace),
  };
}

function normalizeConsoleMessageForMatch(message: string): string {
  return message.replace(/\s+/g, " ").trim().toLowerCase();
}

function isStatusCheckMessage(message: string): boolean {
  const normalized = normalizeConsoleMessageForMatch(message);

  return /\b(what's happening|what is happening|what's going on|what is going on|current status|status check|current activity|active agents|anything blocked|what changed in the last run)\b/.test(normalized);
}

function isTimeQueryMessage(message: string): boolean {
  const normalized = normalizeConsoleMessageForMatch(message);

  return /\b(what time is it|what's the time|what is the time|current time|what's the date|what is the date|today's date|todays date|current date)\b/.test(normalized);
}

function isProjectMetaQueryMessage(message: string): boolean {
  const normalized = normalizeConsoleMessageForMatch(message);

  return /\b(current project|active project|which project|what project)\b/.test(normalized);
}

function isRuntimeMetaQueryMessage(message: string): boolean {
  const normalized = normalizeConsoleMessageForMatch(message);

  return /\b(current runtime|current model|current lane|active runtime|active model|which runtime|which model|which lane|what runtime|what model|what lane)\b/.test(normalized);
}

function renderTier1LaneSummary(input: {
  provider: string;
  model: string;
}): string {
  if (input.provider === "ollama") {
    return `tier-1 local via Ollama | model: ${input.model}`;
  }

  return `tier-1 cloud via ${input.provider} | model: ${input.model}`;
}

type DirectConsoleResponse = {
  content: string;
  source: "system" | "model";
  details: SessionTurnDetails;
};

async function resolveDirectConsoleResponse(input: {
  options: GatewayOptions;
  project: string;
  message: string;
  globalConfig: string;
  sessionRuntime: string;
  sessionModel: string | null;
  persistentStewardEnabled: boolean;
}): Promise<DirectConsoleResponse | null> {
  if (!input.project || input.project === "default") {
    return null;
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.project);
  const execution = resolveCognitiveExecutionLane({
    globalConfig: input.globalConfig,
    runtime: input.sessionRuntime,
    selectedModel: input.sessionModel,
    persistentStewardEnabled: input.persistentStewardEnabled,
  });
  const selectionSummary = formatRuntimeSelection(input.sessionRuntime, input.sessionModel);
  let cachedState: ProjectRuntimeState | null = null;
  let cachedCurrentActivity: { summary: string; state: ProjectRuntimeState } | null = null;

  async function getState(): Promise<ProjectRuntimeState> {
    if (!cachedState) {
      cachedState = await refreshProjectRuntimeState({
        hivePaths: input.options.hivePaths,
        projectId: input.project,
        projectPaths,
      });
    }

    return cachedState;
  }

  async function getCurrentActivity(): Promise<{ summary: string; state: ProjectRuntimeState }> {
    if (!cachedCurrentActivity) {
      cachedCurrentActivity = await buildCurrentActivitySummary({
        options: input.options,
        project: input.project,
      });
      cachedState = cachedCurrentActivity.state;
    }

    return cachedCurrentActivity;
  }

  if (isTimeQueryMessage(input.message)) {
    const state = await getState();

    return {
      content: `Current UTC time: ${toIsoTimestamp(now())}.`,
      source: "system",
      details: buildSessionTurnDetails({
        project: input.project,
        state,
        runtime: "deterministic",
        routing: buildSessionTurnRouting({
          tier: "tier0",
          mode: "direct-answer",
          handledBy: "deterministic-time",
          globalConfig: input.globalConfig,
          runtime: input.sessionRuntime,
          model: input.sessionModel,
          persistentStewardEnabled: input.persistentStewardEnabled,
          laneOverride: "deterministic gateway preprocessor",
          fanOutUsed: 0,
          parallelismUsed: 1,
          trace: [
            "The gateway handled an obvious time/date query before waking the steward.",
            "No model was invoked because the answer came from deterministic local time.",
          ],
        }),
      }),
    };
  }

  if (isProjectMetaQueryMessage(input.message)) {
    const state = await getState();

    return {
      content: `Current project focus: ${input.project}.`,
      source: "system",
      details: buildSessionTurnDetails({
        project: input.project,
        state,
        runtime: "deterministic",
        routing: buildSessionTurnRouting({
          tier: "tier0",
          mode: "direct-answer",
          handledBy: "deterministic-project-meta",
          globalConfig: input.globalConfig,
          runtime: input.sessionRuntime,
          model: input.sessionModel,
          persistentStewardEnabled: input.persistentStewardEnabled,
          laneOverride: "deterministic gateway preprocessor",
          fanOutUsed: 0,
          parallelismUsed: 1,
          trace: [
            "The gateway answered a session metadata query before waking the steward.",
            "No model was invoked because the answer came from current session state.",
          ],
        }),
      }),
    };
  }

  if (isRuntimeMetaQueryMessage(input.message)) {
    const state = await getState();

    return {
      content: [
        `Session selection: ${selectionSummary}.`,
        `Current execution: ${renderCognitiveExecutionSummary(execution)}.`,
      ].join("\n"),
      source: "system",
      details: buildSessionTurnDetails({
        project: input.project,
        state,
        runtime: "deterministic",
        routing: buildSessionTurnRouting({
          tier: "tier0",
          mode: "direct-answer",
          handledBy: "deterministic-runtime-meta",
          globalConfig: input.globalConfig,
          runtime: input.sessionRuntime,
          model: input.sessionModel,
          persistentStewardEnabled: input.persistentStewardEnabled,
          laneOverride: "deterministic gateway preprocessor",
          fanOutUsed: 0,
          parallelismUsed: 1,
          trace: [
            "The gateway answered a runtime/model query from current session routing state.",
            "No model was invoked because the answer came from the active cognitive route map.",
          ],
        }),
      }),
    };
  }

  if (isStatusCheckMessage(input.message)) {
    const currentActivity = await getCurrentActivity();

    return {
      content: currentActivity.summary,
      source: "system",
      details: buildSessionTurnDetails({
        project: input.project,
        state: currentActivity.state,
        runtime: "deterministic",
        routing: buildSessionTurnRouting({
          tier: "tier0",
          mode: "direct-answer",
          handledBy: "deterministic-status",
          globalConfig: input.globalConfig,
          runtime: input.sessionRuntime,
          model: input.sessionModel,
          persistentStewardEnabled: input.persistentStewardEnabled,
          laneOverride: "deterministic gateway preprocessor",
          fanOutUsed: 0,
          parallelismUsed: 1,
          trace: [
            "The gateway recognized an explicit status check before waking the steward.",
            "The reply came from live derived state and current activity, not from a model turn.",
          ],
        }),
      }),
    };
  }

  const currentActivity = await getCurrentActivity();
  const recentResult = currentActivity.state.recentResultsSummary.items[0] ?? null;
  const compactContext = [
    `project: ${input.project}`,
    `session-selection: ${selectionSummary}`,
    `current-execution: ${renderCognitiveExecutionSummary(execution)}`,
    `current-time-utc: ${toIsoTimestamp(now())}`,
    `active-runs: ${currentActivity.state.activeRunsSummary.count}`,
    `open-human-items: ${currentActivity.state.humanInboxSummary.pendingHumanReplies}`,
    recentResult ? `recent-result: ${summarizeRecentResult(recentResult)}` : "recent-result: none",
    "",
    "current-activity:",
    currentActivity.summary,
  ].join("\n");

  const preprocessed = await preprocessHumanMessage({
    globalConfig: input.globalConfig,
    message: input.message,
    compactContext,
  });

  if (!preprocessed || preprocessed.classification === "complex" || preprocessed.classification === "directive") {
    return null;
  }

  if (preprocessed.classification === "status_check") {
    return {
      content: currentActivity.summary,
      source: "system",
      details: buildSessionTurnDetails({
        project: input.project,
        state: currentActivity.state,
        runtime: preprocessed.provider,
        model: preprocessed.model,
        authMode: "unknown",
        durationMs: preprocessed.durationMs,
        inputTokens: preprocessed.inputTokens,
        outputTokens: preprocessed.outputTokens,
        totalTokens: preprocessed.totalTokens,
        routing: buildSessionTurnRouting({
          tier: "tier1",
          mode: "direct-answer",
          handledBy: "tier1-preprocessor",
          globalConfig: input.globalConfig,
          runtime: input.sessionRuntime,
          model: input.sessionModel,
          persistentStewardEnabled: input.persistentStewardEnabled,
          laneOverride: renderTier1LaneSummary(preprocessed),
          fanOutUsed: 0,
          parallelismUsed: 1,
          trace: [
            "A conservative tier-1 preprocessor classified the message as a status check.",
            preprocessed.reason || "The gateway answered from compact live state without waking the steward.",
          ],
        }),
      }),
    };
  }

  if (preprocessed.classification === "simple_query" && preprocessed.answer.trim()) {
    return {
      content: preprocessed.answer.trim(),
      source: "model",
      details: buildSessionTurnDetails({
        project: input.project,
        state: currentActivity.state,
        runtime: preprocessed.provider,
        model: preprocessed.model,
        authMode: "unknown",
        durationMs: preprocessed.durationMs,
        inputTokens: preprocessed.inputTokens,
        outputTokens: preprocessed.outputTokens,
        totalTokens: preprocessed.totalTokens,
        routing: buildSessionTurnRouting({
          tier: "tier1",
          mode: "direct-answer",
          handledBy: "tier1-preprocessor",
          globalConfig: input.globalConfig,
          runtime: input.sessionRuntime,
          model: input.sessionModel,
          persistentStewardEnabled: input.persistentStewardEnabled,
          laneOverride: renderTier1LaneSummary(preprocessed),
          fanOutUsed: 0,
          parallelismUsed: 1,
          trace: [
            "A conservative tier-1 preprocessor answered the message directly from compact context.",
            preprocessed.reason || "The steward was not woken because extra depth was unlikely to change the answer.",
          ],
        }),
      }),
    };
  }

  return null;
}

function renderSlashCommandHelp(input: {
  currentProject: string;
  currentRuntime: string;
  currentModel: string | null;
}): string {
  return [
    "HIVE session help",
    `Current project: ${input.currentProject}`,
    `Current steward runtime: ${formatRuntimeSelection(input.currentRuntime, input.currentModel)}`,
    "",
    "Slash commands",
    "/help",
    "/project",
    "/project <project>",
    "/project <project> <message>",
    "/runtime",
    "/runtime <runtime>",
    "/runtime <runtime> <model>",
    "",
    "Routing shortcuts",
    "@<project>: <message>",
    "",
    "Examples",
    "/project hive what changed in the last run?",
    "/runtime claude",
    "/runtime codex gpt-5-codex",
    "@hive: summarize the active agents",
    "what's happening right now?",
    "take the next step on the current goal",
  ].join("\n");
}

function buildSessionTurnDetails(input: {
  project: string;
  state: ProjectRuntimeState;
  runId?: string | null;
  runtime?: string | null;
  model?: string | null;
  authMode?: SessionTurnDetails["authMode"];
  durationMs?: number | null;
  numTurns?: number | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  totalTokens?: number | null;
  routing?: SessionTurnDetails["routing"];
  statusNotes?: string[];
}): SessionTurnDetails {
  const uniqueNotes = [...new Set((input.statusNotes ?? []).map(normalizeStatusNote).filter(Boolean))];

  return {
    project: input.project,
    recordedAt: null,
    runId: input.runId ?? null,
    runtime: input.runtime ?? null,
    model: input.model ?? null,
    authMode: input.authMode ?? null,
    durationMs: input.durationMs ?? null,
    numTurns: input.numTurns ?? null,
    costUsd: input.costUsd ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    cacheCreationInputTokens: input.cacheCreationInputTokens ?? null,
    cacheReadInputTokens: input.cacheReadInputTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    board: {
      taskCount: input.state.boardSummary.taskCount,
      activeCount: input.state.boardSummary.activeCount,
      doneCount: input.state.boardSummary.doneCount,
      waitingCount: input.state.boardSummary.waitingCount,
      blockers: input.state.boardSummary.blockers.slice(0, 8),
    },
    messages: {
      openCount: input.state.openMessagesSummary.count,
      pendingHumanMessages: input.state.humanInboxSummary.pendingHumanMessages,
      pendingHumanReplies: input.state.humanInboxSummary.pendingHumanReplies,
    },
    runs: {
      activeCount: input.state.activeRunsSummary.count,
    },
    routing: input.routing ?? null,
    statusNotes: uniqueNotes.length > 0 ? uniqueNotes : null,
  };
}

type ContinueConsoleWorkflowInput = {
  options: GatewayOptions;
  broadcast: GatewayBroadcast;
  sessionId: string;
  project: string;
  message: string;
  origin?: "human" | "queued-follow-up";
};

async function schedulePendingSessionTurnDrain(input: {
  options: GatewayOptions;
  broadcast: GatewayBroadcast;
  sessionId: string;
}): Promise<void> {
  if (pendingSessionTurnDrains.has(input.sessionId)) {
    return;
  }

  const drainPromise = (async () => {
    while (true) {
      const sessionState = await getSessionState(
        input.options.hivePaths.sessionsDir,
        input.sessionId,
      );
      const pendingTurns = getPendingSessionTurns(sessionState);

      if (pendingTurns.length === 0) {
        return;
      }

      const projectId = pendingTurns[0]!.projectId;

      if (!projectId || projectId === "default") {
        await takePendingSessionTurns({
          sessionsDir: input.options.hivePaths.sessionsDir,
          sessionId: input.sessionId,
          projectId,
        });
        continue;
      }

      const projectPaths = getProjectPaths(input.options.hivePaths, projectId);
      await reconcileActiveConsoleRun(projectPaths);

      if (await readActiveRun(projectPaths, "console")) {
        await Bun.sleep(750);
        continue;
      }

      const batch = await takePendingSessionTurns({
        sessionsDir: input.options.hivePaths.sessionsDir,
        sessionId: input.sessionId,
        projectId,
      });

      if (batch.length === 0) {
        await Bun.sleep(150);
        continue;
      }

      broadcastSessionStream({
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: projectId,
        content:
          batch.length === 1
            ? "Picking up the follow-up you sent while I was finishing the last turn."
            : `Picking up ${batch.length} queued follow-ups now.`,
      });

      await continueConsoleWorkflow({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: projectId,
        message: formatQueuedTurnBatchMessage({ batch }),
        origin: "queued-follow-up",
      });
    }
  })().finally(() => {
    pendingSessionTurnDrains.delete(input.sessionId);
  });

  pendingSessionTurnDrains.set(input.sessionId, drainPromise);
  await drainPromise;
}

type GatewayLiveAgent = {
  runId: string;
  agentId: string;
  displayName: string;
  persona: string;
  descriptor: string;
  status: string;
  runtime: string;
  model: string | null;
  started: string;
  pid: number | null;
  taskId: string | null;
  source: string;
  latestOutput: string | null;
  tail: string[];
};

type GatewayRecentCompletion = {
  runId: string;
  agentId: string;
  displayName: string;
  persona: string;
  descriptor: string;
  status: string;
  ended: string;
  summary: string;
  changedFiles: string[];
  runtime: string | null;
  model: string | null;
};

type GatewayActivityItem = {
  id: string;
  ts: string;
  source: "delta" | "event";
  kind: string;
  actor: string | null;
  title: string;
  detail: string;
  tone: "info" | "warning" | "error" | "success";
};

type GatewayQueueIncident = {
  id: string;
  ts: string;
  kind: string;
  source: string;
  severity: "warning" | "error";
  summary: string;
  details: string[];
  routed: boolean;
};

type GatewayTimelineItem = {
  id: string;
  ts: string;
  source: "feed" | "event";
  project: string | null;
  title: string;
  details: string[];
  tone: "info" | "warning" | "error" | "success";
};

function classifyTone(text: string): GatewayTimelineItem["tone"] {
  const normalized = text.toLowerCase();

  if (
    normalized.includes("error") ||
    normalized.includes("failed") ||
    normalized.includes("crash") ||
    normalized.includes("rejected")
  ) {
    return "error";
  }

  if (
    normalized.includes("warning") ||
    normalized.includes("blocked") ||
    normalized.includes("approval requested") ||
    normalized.includes("stale")
  ) {
    return "warning";
  }

  if (
    normalized.includes("done") ||
    normalized.includes("completed") ||
    normalized.includes("approved") ||
    normalized.includes("resolved")
  ) {
    return "success";
  }

  return "info";
}

function toneFromSeverity(
  severity: EventRecord["severity"],
): GatewayTimelineItem["tone"] {
  if (severity === "error") {
    return "error";
  }

  if (severity === "warning") {
    return "warning";
  }

  return "info";
}

async function readProjectAgentContext(projectPaths: ProjectPaths): Promise<{
  plan: string;
  projectConfig: string;
}> {
  const [plan, projectConfig] = await Promise.all([
    Bun.file(projectPaths.plan).text().catch(() => ""),
    Bun.file(projectPaths.config).text().catch(() => ""),
  ]);

  return { plan, projectConfig };
}

function resolveAgentPresentation(input: {
  plan: string;
  projectConfig: string;
  agentId: string;
}): { displayName: string; persona: string; descriptor: string } {
  if (input.agentId === "console") {
    return {
      displayName: "steward",
      persona: "steward",
      descriptor: "live steward session",
    };
  }

  if (input.agentId === "steward") {
    return {
      displayName: "background steward",
      persona: "steward",
      descriptor: "background coordination steward",
    };
  }

  const planAgent = findPlanAgent(input.plan, input.agentId);

  if (planAgent) {
    return {
      displayName: input.agentId,
      persona: planAgent.persona,
      descriptor: stripRuntimeHintsFromDescriptor(planAgent.descriptor),
    };
  }

  const teamAgent = parseDefaultTeam(input.projectConfig).find(
    (agent) => agent.id === input.agentId,
  );

  if (teamAgent) {
    return {
      displayName: input.agentId,
      persona: teamAgent.persona,
      descriptor: stripRuntimeHintsFromDescriptor(teamAgent.descriptor),
    };
  }

  return {
    displayName: input.agentId,
    persona: "worker",
    descriptor: "active worker",
  };
}

function toneFromDeltaKind(kind: string): GatewayActivityItem["tone"] {
  if (kind === "worker-result" || kind === "steward-result") {
    return "success";
  }

  if (kind === "human-message") {
    return "warning";
  }

  if (kind === "message-cleared" || kind === "run-finished") {
    return "info";
  }

  return "info";
}

function mapDeltaActivity(input: {
  revision: number;
  ts: string;
  change: Awaited<ReturnType<typeof readStewardDeltaHistory>>[number]["changes"][number];
}): GatewayActivityItem {
  return {
    id: `delta-${input.revision}-${input.change.type}-${input.change.runId ?? input.change.filename ?? input.change.summary}`,
    ts: input.ts,
    source: "delta",
    kind: input.change.type,
    actor: input.change.agent ?? null,
    title: input.change.agent
      ? `${input.change.agent} · ${input.change.type}`
      : input.change.type.replace(/-/g, " "),
    detail: input.change.summary,
    tone: toneFromDeltaKind(input.change.type),
  };
}

function mapEventActivity(event: EventRecord): GatewayActivityItem {
  return {
    id: `event-${event.id}`,
    ts: event.ts,
    source: "event",
    kind: event.kind,
    actor: event.source,
    title: event.kind,
    detail: event.summary,
    tone: toneFromSeverity(event.severity),
  };
}

async function buildGatewayLiveSnapshot(input: {
  options: GatewayOptions;
  projectId: string | null;
}): Promise<{
  project: string | null;
  sessionId: string | null;
  summary: string | null;
  supervisor: {
    status: string;
    pid: number | null;
    tail: string[];
  } | null;
  agents: GatewayLiveAgent[];
  recentCompletions: GatewayRecentCompletion[];
  activity: GatewayActivityItem[];
}> {
  if (!input.projectId || input.projectId === "default") {
    return {
      project: null,
      sessionId: null,
      summary: null,
      supervisor: null,
      agents: [],
      recentCompletions: [],
      activity: [],
    };
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.projectId);
  const runtimeState = await refreshProjectRuntimeState({
    hivePaths: input.options.hivePaths,
    projectId: input.projectId,
    projectPaths,
  });
  const agentContext = await readProjectAgentContext(projectPaths);
  const [supervisorState, deltaHistory, recentEvents] = await Promise.all([
    reconcileDetachedSupervisorState(projectPaths),
    readStewardDeltaHistory({
      projectPaths,
      limit: 10,
    }),
    listRecentEvents({
      paths: input.options.hivePaths,
      scope: "all",
      limit: 20,
    }),
  ]);

  const agents = await Promise.all(
    runtimeState.activeRuns.map(async (run) => {
      const presentation = resolveAgentPresentation({
        ...agentContext,
        agentId: run.agentId,
      });
      const tail = await readRunOutputTail(run, 12);

      return {
        runId: run.runId,
        agentId: run.agentId,
        displayName: presentation.displayName,
        persona: presentation.persona,
        descriptor: presentation.descriptor,
        status: run.status,
        runtime: run.runtime,
        model: run.model,
        started: run.started,
        pid: run.pid,
        taskId: run.taskId,
        source: run.source,
        latestOutput: tail[tail.length - 1] ?? null,
        tail,
      };
    }),
  );

  const recentCompletions = await Promise.all(
    runtimeState.recentResultsSummary.items.slice(0, 6).map(async (result) => {
      const run = await readRunRecordForResult(result);
      const presentation = resolveAgentPresentation({
        ...agentContext,
        agentId: result.agentId,
      });

      return {
        runId: result.runId,
        agentId: result.agentId,
        displayName: presentation.displayName,
        persona: presentation.persona,
        descriptor: presentation.descriptor,
        status: result.status,
        ended: result.ended,
        summary: result.summary || result.status,
        changedFiles: result.changedFiles,
        runtime: run?.runtime ?? null,
        model: run?.model ?? null,
      };
    }),
  );

  const deltaActivities = deltaHistory
    .flatMap((packet) =>
      packet.changes.map((change) =>
        mapDeltaActivity({
          revision: packet.revision,
          ts: packet.ts,
          change,
        }),
      ),
    );
  const eventActivities = recentEvents
    .filter(
      (event) =>
        event.project === input.projectId &&
        (
          event.kind === "approval.requested" ||
          event.kind === "approval.resolved" ||
          event.kind === "event.routed" ||
          event.kind === "memory.extracted" ||
          event.severity !== "info"
        ),
    )
    .map((event) => mapEventActivity(event));
  const activity = [...deltaActivities, ...eventActivities]
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, 12);

  const currentActivity = await buildCurrentActivitySummary({
    options: input.options,
    project: input.projectId,
  });

  return {
    project: input.projectId,
    sessionId: runtimeState.sessionMeta?.sessionId ?? null,
    summary: currentActivity.summary,
    supervisor: supervisorState
      ? {
          status: supervisorState.status,
          pid: supervisorState.pid,
          tail: await readTextTail(supervisorState.logPath, 24),
        }
      : null,
    agents,
    recentCompletions,
    activity,
  };
}

async function buildGatewayQueueSnapshot(input: {
  options: GatewayOptions;
  projectId: string | null;
}): Promise<{
  project: string | null;
  approvals: ApprovalRequest[];
  waitingOnHuman: ProjectRuntimeState["humanInboxSummary"]["items"];
  incidents: GatewayQueueIncident[];
}> {
  if (!input.projectId || input.projectId === "default") {
    return {
      project: null,
      approvals: [],
      waitingOnHuman: [],
      incidents: [],
    };
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.projectId);
  const [runtimeState, approvals, recentExternalEvents] = await Promise.all([
    refreshProjectRuntimeState({
      hivePaths: input.options.hivePaths,
      projectId: input.projectId,
      projectPaths,
    }),
    listApprovals(input.options.hivePaths, "pending"),
    listRecentEvents({
      paths: input.options.hivePaths,
      scope: "external",
      limit: 30,
    }),
  ]);

  return {
    project: input.projectId,
    approvals: approvals.filter(
      (approval) => approval.project === null || approval.project === input.projectId,
    ),
    waitingOnHuman: runtimeState.humanInboxSummary.items.filter(
      (item) => item.needsHumanReply,
    ),
    incidents: recentExternalEvents
      .filter(
        (event) =>
          event.project === input.projectId &&
          event.severity !== "info",
      )
      .map((event) => ({
        id: event.id,
        ts: event.ts,
        kind: event.kind,
        source: event.source,
        severity: event.severity === "error" ? "error" : "warning",
        summary: event.summary,
        details: event.details,
        routed: event.data.routed === true,
      })),
  };
}

async function buildGatewayTimeline(input: {
  options: GatewayOptions;
  projectId: string | null;
  count: number;
}): Promise<{
  project: string | null;
  items: GatewayTimelineItem[];
}> {
  const feedText = await Bun.file(input.options.hivePaths.feed).text().catch(() => "");
  const feedItems = parseStructuredFeedEntries(feedText)
    .filter(
      (entry) =>
        !input.projectId ||
        entry.project === null ||
        entry.project === input.projectId,
    )
    .map((entry, index) => ({
      id: `feed-${entry.ts ?? "unknown"}-${index}`,
      ts: entry.ts ?? "",
      source: "feed" as const,
      project: entry.project,
      title: entry.headline,
      details: entry.details,
      tone: classifyTone(`${entry.headline} ${entry.details.join(" ")}`),
    }));
  const eventItems = (await listRecentEvents({
    paths: input.options.hivePaths,
    scope: "all",
    limit: input.count * 2,
  }))
    .filter(
      (event) =>
        !input.projectId ||
        event.project === input.projectId,
    )
    .map((event) => ({
      id: `event-${event.id}`,
      ts: event.ts,
      source: "event" as const,
      project: event.project,
      title: event.summary,
      details: [`${event.kind} · ${event.source}`, ...event.details],
      tone: toneFromSeverity(event.severity),
    }));

  return {
    project: input.projectId,
    items: [...feedItems, ...eventItems]
      .sort((left, right) => right.ts.localeCompare(left.ts))
      .slice(0, input.count),
  };
}

type ScheduledProjectRefresh = {
  running: boolean;
  queued: boolean;
};

const scheduledProjectRefreshes = new Map<string, ScheduledProjectRefresh>();

function getProjectRefreshKey(hivePaths: HivePaths, projectId: string): string {
  return `${hivePaths.home}:${projectId}`;
}

function scheduleProjectRuntimeRefresh(input: {
  hivePaths: HivePaths;
  projectId: string;
  delayMs?: number;
}): void {
  if (!input.projectId || input.projectId === "default") {
    return;
  }

  const key = getProjectRefreshKey(input.hivePaths, input.projectId);
  let state = scheduledProjectRefreshes.get(key);

  if (!state) {
    state = {
      running: false,
      queued: false,
    };
    scheduledProjectRefreshes.set(key, state);
  }

  state.queued = true;

  if (state.running) {
    return;
  }

  state.running = true;

  void (async () => {
    try {
      while (state?.queued) {
        state.queued = false;
        await Bun.sleep(input.delayMs ?? 50);

        if (state.queued) {
          continue;
        }

        const projectPaths = getProjectPaths(input.hivePaths, input.projectId);
        await refreshProjectRuntimeState({
          hivePaths: input.hivePaths,
          projectId: input.projectId,
          projectPaths,
        });
      }
    } catch {
      // Best-effort refresh for gateway responsiveness.
    } finally {
      if (state) {
        state.running = false;

        if (state.queued) {
          scheduleProjectRuntimeRefresh(input);
        } else if (scheduledProjectRefreshes.get(key) === state) {
          scheduledProjectRefreshes.delete(key);
        }
      }
    }
  })();
}

async function getSessionProjectFocus(input: {
  sessionsDir: string;
  sessionId: string;
  fallbackProject: string;
}): Promise<string> {
  return (
    (await getSessionState(input.sessionsDir, input.sessionId))?.currentProject ||
    input.fallbackProject
  );
}

async function resolveGatewayProjectFocus(input: {
  options: GatewayOptions;
  requestedProject?: string | null;
}): Promise<string | null> {
  if (input.requestedProject?.trim()) {
    return resolveProjectId({
      options: input.options,
      token: input.requestedProject,
    });
  }

  const sessionsDir = join(input.options.hivePaths.home, "sessions");
  const session = await getActiveSession(sessionsDir);

  if (session) {
    return getSessionProjectFocus({
      sessionsDir,
      sessionId: session.sessionId,
      fallbackProject: session.project,
    });
  }

  return (await getActiveProject(input.options.hivePaths)) ?? null;
}

async function readTextTail(path: string, limit = 50): Promise<string[]> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return [];
  }

  return (await file.text())
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-limit);
}

function formatActivityTime(iso: string | null): string | null {
  if (!iso) {
    return null;
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeLeadRun(run: RunRecord): string {
  if (run.agentId === "console") {
    return "I'm already working on the current conversation";
  }

  if (run.agentId === "steward") {
    return "The background steward is assessing the project and deciding the next moves";
  }

  return `${run.agentId} is actively working${run.taskId ? ` on ${run.taskId}` : ""}`;
}

function summarizeRecentResult(input: {
  agentId: string;
  status: string;
  summary: string;
}): string {
  const base = input.agentId === "steward"
    ? "The last completed background steward pass"
    : `The last completed step from ${input.agentId}`;

  if (input.summary.trim()) {
    return `${base}: ${input.summary.trim()}`;
  }

  return `${base} finished with status ${input.status}.`;
}

async function buildCurrentActivitySummary(input: {
  options: GatewayOptions;
  project: string;
  lead?: string;
}): Promise<{ summary: string; state: ProjectRuntimeState }> {
  const projectPaths = getProjectPaths(input.options.hivePaths, input.project);
  const state = await refreshProjectRuntimeState({
    hivePaths: input.options.hivePaths,
    projectId: input.project,
    projectPaths,
  });
  const activeRuns = state.activeRuns;
  const leadRun =
    activeRuns.find((run) => run.agentId === "console") ??
    activeRuns.find((run) => run.agentId === "steward") ??
    activeRuns[0] ??
    null;
  const lines: string[] = [];

  if (input.lead?.trim()) {
    lines.push(input.lead.trim());
    lines.push("");
  }

  lines.push("Here's what the hive is doing right now:");

  if (leadRun) {
    const since = formatActivityTime(leadRun.started);
    lines.push(
      `- ${describeLeadRun(leadRun)}${since ? ` since ${since}` : ""}.`,
    );

    const leadTail = await readRunOutputTail(leadRun, 6);
    const latestVisibleLine = leadTail[leadTail.length - 1] ?? null;

    if (latestVisibleLine) {
      lines.push(`- Latest visible output: ${latestVisibleLine}`);
    } else if (leadRun.agentId === "console") {
      lines.push("- Live reply generation is still in progress. Waiting for the first streamed update.");
    } else {
      lines.push("- No visible output from that run yet.");
    }
  } else {
    lines.push("- Nothing is actively running at the moment.");
  }

  const workerRuns = activeRuns.filter((run) => run.agentId !== "console" && run.agentId !== "steward");

  if (workerRuns.length > 0) {
    lines.push(
      `- Active workers: ${workerRuns.map((run) => run.taskId ? `${run.agentId} on ${run.taskId}` : run.agentId).join(", ")}.`,
    );
  } else if (activeRuns.some((run) => run.agentId === "steward")) {
    lines.push("- No worker handoffs have been launched yet.");
  }

  const waitingOnHuman = state.humanInboxSummary.items.find((item) => item.needsHumanReply);

  if (waitingOnHuman) {
    lines.push(`- Waiting on you: ${waitingOnHuman.summary}`);
  }

  const recentResult = state.recentResultsSummary.items[0] ?? null;

  if (recentResult) {
    lines.push(`- ${summarizeRecentResult(recentResult)}`);
  }

  if (activeRuns.length === 0 && state.openMessagesSummary.count > 0) {
    lines.push(`- ${state.openMessagesSummary.count} queued coordination item(s) are still open.`);
  }

  return {
    summary: lines.join("\n"),
    state,
  };
}

function joinNaturalList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }

  if (items.length === 1) {
    return items[0]!;
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

async function readRunRecordForResult(result: RunResult): Promise<RunRecord | null> {
  return readRunRecord(join(dirname(result.path), "run.md"));
}

async function ensureSupervisorRunning(input: {
  options: GatewayOptions;
  project: string;
}): Promise<string> {
  const projectPaths = getProjectPaths(input.options.hivePaths, input.project);
  const existing = await reconcileDetachedSupervisorState(projectPaths);

  if (existing?.status === "active" && isProcessAlive(existing.pid)) {
    return `Supervisor active (pid ${existing.pid})`;
  }

  const state = await startDetachedSupervisor({
    projectPaths,
    projectId: input.project,
    intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
    maxParallel: DEFAULT_MAX_PARALLEL,
  });

  return `Supervisor started (pid ${state.pid ?? "unknown"})`;
}

async function resolveGatewayStewardDefaults(input: {
  options: GatewayOptions;
  projectId: string;
}): Promise<{ runtime: string; model: string | null }> {
  const globalConfig = await Bun.file(input.options.hivePaths.config).text().catch(() => "");
  let projectConfig = "";
  let plan = "";

  if (input.projectId && input.projectId !== "default") {
    const projectPaths = getProjectPaths(input.options.hivePaths, input.projectId);
    const projectContext = await readProjectAgentContext(projectPaths);
    projectConfig = projectContext.projectConfig;
    plan = projectContext.plan;
  }

  return resolveRuntimeHints({
    globalConfig,
    teamAgent: parseDefaultTeam(projectConfig).find((agent) => agent.id === "steward") ?? null,
    planAgent: findPlanAgent(plan, "steward"),
  });
}

async function resolveGatewayStewardRuntime(input: {
  options: GatewayOptions;
  projectId: string;
  requestedRuntime?: string | null;
  requestedModel?: string | null;
}): Promise<{
  runtime: string;
  model: string | null;
  defaults: {
    runtime: string;
    model: string | null;
  };
}> {
  const defaults = await resolveGatewayStewardDefaults({
    options: input.options,
    projectId: input.projectId,
  });

  if (!input.requestedRuntime?.trim()) {
    return {
      runtime: defaults.runtime,
      model: defaults.model,
      defaults,
    };
  }

  const adapter = getAdapter(input.requestedRuntime);

  if (!adapter) {
    const runtimes = listRuntimeAdapters()
      .map((runtime) => runtime.name)
      .join(", ");
    throw new UsageError(`Unknown runtime: ${input.requestedRuntime}. Available runtimes: ${runtimes}.`);
  }

  const runtime = adapter.name;
  const explicitModel = input.requestedModel?.trim() ? input.requestedModel.trim() : null;

  return {
    runtime,
    model: explicitModel ?? (runtime === defaults.runtime ? defaults.model : null),
    defaults,
  };
}

type SessionSlashCommandResult = {
  projectId: string;
  continueWorkflow: boolean;
  message: string;
  result: string | null;
  resultSource?: "system";
};

async function resolveSessionSlashCommand(input: {
  options: GatewayOptions;
  sessionId: string;
  currentProject: string;
  rawMessage: string;
}): Promise<SessionSlashCommandResult | null> {
  const trimmed = input.rawMessage.trim();

  if (!trimmed.startsWith("/")) {
    return null;
  }

  if (trimmed === "/help" || trimmed === "/?") {
    const session = await getSession(input.options.hivePaths.sessionsDir, input.sessionId);
    return {
      projectId: input.currentProject,
      continueWorkflow: false,
      message: "",
      result: renderSlashCommandHelp({
        currentProject: input.currentProject,
        currentRuntime: session?.runtime ?? "unknown",
        currentModel: session?.model ?? null,
      }),
      resultSource: "system",
    };
  }

  if (trimmed === "/project") {
    return {
      projectId: input.currentProject,
      continueWorkflow: false,
      message: "",
      result: `Current project focus: ${input.currentProject}.`,
      resultSource: "system",
    };
  }

  const projectMatch = trimmed.match(/^\/project\s+([^\s]+)(?:\s+(.*))?$/is);

  if (projectMatch) {
    const projectId = await resolveProjectId({
      options: input.options,
      token: projectMatch[1]!,
    });
    const message = (projectMatch[2] ?? "").trim();
    const switched = projectId !== input.currentProject;

    if (switched) {
      await switchSessionProject({
        sessionsDir: input.options.hivePaths.sessionsDir,
        sessionId: input.sessionId,
        projectId,
      });
    }

    return {
      projectId,
      continueWorkflow: message.length > 0,
      message,
      result: message.length > 0
        ? null
        : switched
          ? `Switched context to ${projectId}.`
          : `Already focused on ${projectId}.`,
      resultSource: "system",
    };
  }

  const runtimeMatch = trimmed.match(/^\/runtime(?:\s+([^\s]+)(?:\s+(.+))?)?$/is);

  if (runtimeMatch) {
    const session = await getSession(input.options.hivePaths.sessionsDir, input.sessionId);

    if (!session) {
      throw new UsageError(`Session not found: ${input.sessionId}`);
    }

    const runtimeToken = runtimeMatch[1]?.trim() ?? "";
    const modelToken = runtimeMatch[2]?.trim() ?? null;
    const { runtime, model, defaults } = await resolveGatewayStewardRuntime({
      options: input.options,
      projectId: input.currentProject,
      requestedRuntime: runtimeToken || null,
      requestedModel: modelToken,
    });

    if (!runtimeToken) {
      const currentLabel = formatRuntimeSelection(session.runtime, session.model);
      const defaultLabel = formatRuntimeSelection(defaults.runtime, defaults.model);
      const matchesDefault =
        session.runtime === defaults.runtime &&
        (session.model ?? null) === (defaults.model ?? null);

      return {
        projectId: input.currentProject,
        continueWorkflow: false,
        message: "",
        result: matchesDefault
          ? `This steward session is using ${currentLabel}. That matches the project's steward default.`
          : `This steward session is using ${currentLabel}. The project's steward default is ${defaultLabel}.`,
        resultSource: "system",
      };
    }

    const projectPaths =
      input.currentProject && input.currentProject !== "default"
        ? getProjectPaths(input.options.hivePaths, input.currentProject)
        : null;

    if (projectPaths) {
      await reconcileActiveConsoleRun(projectPaths);
    }

    const activeConsoleRun = projectPaths ? await readActiveRun(projectPaths, "console") : null;
    const wasAlreadySelected =
      session.runtime === runtime && (session.model ?? null) === (model ?? null);

    if (!wasAlreadySelected) {
      await updateSessionMeta({
        sessionsDir: input.options.hivePaths.sessionsDir,
        sessionId: input.sessionId,
        runtime,
        model,
      });
    }

    const targetLabel = formatRuntimeSelection(runtime, model);
    const previousLabel = formatRuntimeSelection(session.runtime, session.model);
    const nextTurnNote = activeConsoleRun
      ? ` The current live turn stays on ${previousLabel}; the next turn will use ${targetLabel}.`
      : ` New turns in this session will use ${targetLabel}.`;

    return {
      projectId: input.currentProject,
      continueWorkflow: false,
      message: "",
      result: wasAlreadySelected
        ? `This steward session is already set to ${targetLabel}.${activeConsoleRun ? nextTurnNote : ""}`
        : `Switched the steward session to ${targetLabel}.${nextTurnNote}`,
      resultSource: "system",
    };
  }

  if (/^\/[^\s]+/.test(trimmed)) {
    const session = await getSession(input.options.hivePaths.sessionsDir, input.sessionId);
    return {
      projectId: input.currentProject,
      continueWorkflow: false,
      message: "",
      result: `Unknown slash command.\n\n${renderSlashCommandHelp({
        currentProject: input.currentProject,
        currentRuntime: session?.runtime ?? "unknown",
        currentModel: session?.model ?? null,
      })}`,
      resultSource: "system",
    };
  }

  return null;
}

async function createGatewaySession(input: {
  options: GatewayOptions;
  project: string;
}): Promise<Awaited<ReturnType<typeof createSession>>> {
  let runtime = "claude";
  let model: string | null = null;

  try {
    const hints = await resolveGatewayStewardRuntime({
      options: input.options,
      projectId: input.project,
    });
    runtime = hints.runtime;
    model = hints.model;
  } catch {
    // fall back to legacy default
  }

  return createSession({
    sessionsDir: input.options.hivePaths.sessionsDir,
    project: input.project,
    runtime,
    model,
    systemPrompt: "HIVE steward session",
  });
}

async function resolveProjectId(input: {
  options: GatewayOptions;
  token: string;
}): Promise<string> {
  const normalized = normalizeProjectName(input.token);
  const projects = await listProjects(input.options.hivePaths);
  const match = projects.find((project) => project === normalized);

  if (!match) {
    throw new UsageError(`Unknown project: ${input.token}`);
  }

  return match;
}

async function resolveSessionTurnTarget(input: {
  options: GatewayOptions;
  sessionId: string;
  sessionProject: string;
  rawMessage: string;
}): Promise<{
  projectId: string;
  message: string;
  continueWorkflow: boolean;
  result: string | null;
  resultSource?: "system";
}> {
  const trimmed = input.rawMessage.trim();
  const sessionState = await getSessionState(input.options.hivePaths.sessionsDir, input.sessionId);
  const currentProject =
    sessionState?.currentProject ||
    input.sessionProject ||
    (await getActiveProject(input.options.hivePaths)) ||
    "default";

  const slashCommand = await resolveSessionSlashCommand({
    options: input.options,
    sessionId: input.sessionId,
    currentProject,
    rawMessage: trimmed,
  });

  if (slashCommand) {
    return slashCommand;
  }

  const inlineMatch = trimmed.match(/^@([^\s:]+):?\s*(.*)$/s);

  if (inlineMatch) {
    const projectId = await resolveProjectId({
      options: input.options,
      token: inlineMatch[1]!,
    });
    const message = (inlineMatch[2] ?? "").trim();

    if (projectId !== currentProject) {
      await switchSessionProject({
        sessionsDir: input.options.hivePaths.sessionsDir,
        sessionId: input.sessionId,
        projectId,
      });
    }

    return {
      projectId,
      message,
      continueWorkflow: message.length > 0,
      result: message.length === 0
        ? projectId !== currentProject
          ? `Switched context to ${projectId}.`
          : `Already focused on ${projectId}.`
        : null,
      resultSource: "system",
    };
  }

  return {
    projectId: currentProject,
    message: trimmed,
    continueWorkflow: true,
    result: null,
  };
}

async function continueQueuedWorkflow(input: {
  options: GatewayOptions;
  broadcast: GatewayBroadcast;
  sessionId: string;
  project: string;
  message: string;
  statusNotes?: string[];
}): Promise<void> {
  const firedAt = new Date().toISOString();
  const globalConfig = await readGatewayGlobalConfig(input.options);
  const statusNotes = [...(input.statusNotes ?? [])];

  try {
    const sayResult = await sendGoalToProject({
      projectId: input.project,
      message: input.message,
      paths: input.options.hivePaths,
    });
    const supervisorLine =
      sayResult.split("\n").find((line) => /Supervisor/i.test(line)) ??
      "Supervisor state updated.";
    pushStatusNote(statusNotes, supervisorLine);
    pushStatusNote(statusNotes, "Turn routed through background coordination.");
    broadcastSessionStream({
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      content: "Background coordination is assessing the project.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await appendSessionTurnAndBroadcast({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: `I couldn't hand this off cleanly: ${errorMessage}`,
    });
    return;
  }

  if (!input.project || input.project === "default") {
    return;
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.project);
  const announcedAssignmentFiles = new Set<string>();
  const announcedWorkerRuns = new Set<string>();
  let announcedOrchestratorRun = false;
  let totalAssignments = 0;
  let totalWorkerRuns = 0;
  let maxParallelWorkers = 0;
  const deadline = Date.now() + 180_000;
  let lastKnownState: ProjectRuntimeState | null = null;

  while (Date.now() < deadline) {
    const state = await refreshProjectRuntimeState({
      hivePaths: input.options.hivePaths,
      projectId: input.project,
      projectPaths,
    });
    lastKnownState = state;
    const { activeRuns, openMessages, recentResults } = state;

    const orchestratorRun = activeRuns.find(
      (run) => run.agentId === "steward" && run.started >= firedAt,
    );

    if (orchestratorRun && !announcedOrchestratorRun) {
      announcedOrchestratorRun = true;
      pushStatusNote(statusNotes, `Background coordination pass ${orchestratorRun.runId} started.`);
      broadcastSessionStream({
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        content: "The hive is checking current work and preparing the next response.",
      });
    }

    const freshAssignments = openMessages.filter(
      (message) =>
        message.attributes.type === "assign" &&
        (message.attributes.ts ?? "") >= firedAt &&
        !announcedAssignmentFiles.has(message.filename),
    );

    if (freshAssignments.length > 0) {
      for (const message of freshAssignments) {
        announcedAssignmentFiles.add(message.filename);
      }
      totalAssignments += freshAssignments.length;

      const recipients = [
        ...new Set(freshAssignments.map((message) => message.attributes.to ?? "unknown")),
      ];
      const tasks = [
        ...new Set(
          freshAssignments
            .map((message) => message.attributes.task)
            .filter((task): task is string => Boolean(task)),
        ),
      ];
      const taskSummary = tasks.length > 0 ? ` for ${joinNaturalList(tasks)}` : "";

      const assignmentNote = `I handed work to ${joinNaturalList(recipients)}${taskSummary}.`;
      pushStatusNote(statusNotes, assignmentNote);
      broadcastSessionStream({
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        content: assignmentNote,
      });
    }

    const freshWorkerRuns = activeRuns.filter(
      (run) =>
        run.agentId !== "steward" &&
        run.agentId !== "console" &&
        run.started >= firedAt &&
        !announcedWorkerRuns.has(run.runId),
    );

    if (freshWorkerRuns.length > 0) {
      for (const run of freshWorkerRuns) {
        announcedWorkerRuns.add(run.runId);
      }
      totalWorkerRuns += freshWorkerRuns.length;
      maxParallelWorkers = Math.max(
        maxParallelWorkers,
        activeRuns.filter((run) => run.agentId !== "steward" && run.agentId !== "console").length,
      );

      const workers = freshWorkerRuns.map((run) =>
        run.taskId ? `${run.agentId} on ${run.taskId}` : run.agentId,
      );

      const workerNote = `Active now: ${joinNaturalList(workers)}.`;
      pushStatusNote(statusNotes, workerNote);
      broadcastSessionStream({
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        content: workerNote,
      });
    }

    const finalResult = recentResults.find(
      (result) =>
        result.agentId === "steward" &&
        result.ended >= firedAt &&
        result.finalVisibleOutput.trim().length > 0,
    );

    if (finalResult) {
      const finalOutput = finalResult.finalVisibleOutput.trim();
      const finalRun = await readRunRecordForResult(finalResult);
      const finalState = await refreshProjectRuntimeState({
        hivePaths: input.options.hivePaths,
        projectId: input.project,
        projectPaths,
      });
      lastKnownState = finalState;

      if (!finalOutput) {
        await appendSessionTurnAndBroadcast({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
          project: input.project,
          role: "assistant",
          content: "Background coordination finished without a visible reply.",
          source: "system",
          details: buildSessionTurnDetails({
            project: input.project,
            state: finalState,
            runId: finalResult.runId,
            runtime: finalRun?.runtime ?? null,
            model: finalRun?.model ?? null,
            authMode: finalResult.authMode,
            durationMs: finalResult.durationMs,
            numTurns: finalResult.numTurns,
            costUsd: finalResult.costUsd,
            inputTokens: finalResult.inputTokens,
            outputTokens: finalResult.outputTokens,
            cacheCreationInputTokens: finalResult.cacheCreationInputTokens,
            cacheReadInputTokens: finalResult.cacheReadInputTokens,
          totalTokens: finalResult.totalTokens,
            routing: buildSessionTurnRouting({
              tier: "tier2",
              mode: totalWorkerRuns > 1 ? "plural-synthesis" : "targeted-inspection",
              handledBy: "background-coordination",
              globalConfig,
              runtime: finalRun?.runtime ?? null,
              model: finalRun?.model ?? null,
              persistentStewardEnabled: false,
              fanOutUsed: totalAssignments > 0 ? totalAssignments : totalWorkerRuns,
              parallelismUsed: maxParallelWorkers > 0 ? maxParallelWorkers : null,
              reusedFreshWorkerOutput: false,
              trace: [
                "Message was routed through background coordination instead of the live steward path.",
                announcedOrchestratorRun
                  ? "A disposable steward pass synthesized the final reply."
                  : "No persistent steward lane was used for this reply.",
                totalWorkerRuns > 0
                  ? `Observed ${totalWorkerRuns} worker run(s) during coordination.`
                  : "No fresh worker runs were observed before the steward replied.",
              ],
            }),
            statusNotes,
          }),
        });
        return;
      }

      await appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: finalOutput,
        source: "model",
        details: buildSessionTurnDetails({
          project: input.project,
          state: finalState,
          runId: finalResult.runId,
          runtime: finalRun?.runtime ?? null,
          model: finalRun?.model ?? null,
          authMode: finalResult.authMode,
          durationMs: finalResult.durationMs,
          numTurns: finalResult.numTurns,
          costUsd: finalResult.costUsd,
          inputTokens: finalResult.inputTokens,
          outputTokens: finalResult.outputTokens,
          cacheCreationInputTokens: finalResult.cacheCreationInputTokens,
          cacheReadInputTokens: finalResult.cacheReadInputTokens,
          totalTokens: finalResult.totalTokens,
          routing: buildSessionTurnRouting({
            tier: "tier2",
            mode: totalWorkerRuns > 1 ? "plural-synthesis" : "targeted-inspection",
            handledBy: "background-coordination",
            globalConfig,
            runtime: finalRun?.runtime ?? null,
            model: finalRun?.model ?? null,
            persistentStewardEnabled: false,
            fanOutUsed: totalAssignments > 0 ? totalAssignments : totalWorkerRuns,
            parallelismUsed: maxParallelWorkers > 0 ? maxParallelWorkers : null,
            reusedFreshWorkerOutput: false,
            trace: [
              "Message was routed through background coordination instead of the live steward path.",
              announcedOrchestratorRun
                ? "A disposable steward pass synthesized the final reply."
                : "No persistent steward lane was used for this reply.",
              totalWorkerRuns > 0
                ? `Observed ${totalWorkerRuns} worker run(s) during coordination.`
                : "The steward replied without launching new workers.",
            ],
          }),
          statusNotes,
        }),
      });
      return;
    }

    await Bun.sleep(1_000);
  }

  if (!lastKnownState) {
    lastKnownState = await refreshProjectRuntimeState({
      hivePaths: input.options.hivePaths,
      projectId: input.project,
      projectPaths,
    });
  }

  await appendSessionTurnAndBroadcast({
    options: input.options,
    broadcast: input.broadcast,
    sessionId: input.sessionId,
    project: input.project,
    role: "assistant",
    content: "This is still in motion. I’ll keep the board moving, and the next background coordination result will land here when it’s ready.",
    source: "system",
    details: buildSessionTurnDetails({
      project: input.project,
      state: lastKnownState,
      routing: buildSessionTurnRouting({
        tier: "tier2",
        mode: totalWorkerRuns > 1 ? "plural-synthesis" : "targeted-inspection",
        handledBy: "background-coordination",
        globalConfig,
        persistentStewardEnabled: false,
        fanOutUsed: totalAssignments > 0 ? totalAssignments : totalWorkerRuns,
        parallelismUsed: maxParallelWorkers > 0 ? maxParallelWorkers : null,
        reusedFreshWorkerOutput: false,
        trace: [
          "Message remains in background coordination because no final reply was ready before the timeout window.",
          totalWorkerRuns > 0
            ? `Observed ${totalWorkerRuns} worker run(s) still in flight.`
            : "The steward has not emitted a final visible reply yet.",
        ],
      }),
      statusNotes,
    }),
  });
}

async function continueConsoleWorkflow(input: ContinueConsoleWorkflowInput): Promise<void> {
  const globalConfig = await readGatewayGlobalConfig(input.options);
  const sessionMeta = await getSession(input.options.hivePaths.sessionsDir, input.sessionId);
  const sessionRuntime = sessionMeta?.runtime ?? "claude";
  const sessionModel = sessionMeta?.model ?? null;
  const persistentStewardEnabled = process.env.HIVE_ENABLE_PERSISTENT_STEWARD !== "0";
  const directResponse = await resolveDirectConsoleResponse({
    options: input.options,
    project: input.project,
    message: input.message,
    globalConfig,
    sessionRuntime,
    sessionModel,
    persistentStewardEnabled,
  });

  if (directResponse) {
    await appendSessionTurnAndBroadcast({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: directResponse.content,
      source: directResponse.source,
      details: directResponse.details,
    });
    void schedulePendingSessionTurnDrain({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
    });
    return;
  }

  if (!input.project || input.project === "default") {
    return;
  }

  let supervisorLine = "Supervisor state updated.";
  const statusNotes: string[] = [];

  function clearPlaceholderTimer(): void {
    // The UI already shows a local thinking state immediately after submit.
    // Avoid injecting synthetic filler copy while waiting for the first real reply chunk.
  }

  try {
    supervisorLine = await ensureSupervisorRunning({
      options: input.options,
      project: input.project,
    });
    pushStatusNote(statusNotes, supervisorLine);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await appendSessionTurnAndBroadcast({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: `I couldn't prepare the runtime infrastructure: ${errorMessage}`,
    });
    clearPlaceholderTimer();
    return;
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.project);
  await reconcileActiveConsoleRun(projectPaths);
  const existingConsoleRun = await readActiveRun(projectPaths, "console");

  if (existingConsoleRun) {
    clearPlaceholderTimer();
    if (input.origin === "queued-follow-up") {
      await enqueuePendingSessionTurn({
        sessionsDir: input.options.hivePaths.sessionsDir,
        sessionId: input.sessionId,
        projectId: input.project,
        content: input.message,
      });
      void schedulePendingSessionTurnDrain({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
      });
      return;
    }

    const queuedState = await enqueuePendingSessionTurn({
      sessionsDir: input.options.hivePaths.sessionsDir,
      sessionId: input.sessionId,
      projectId: input.project,
      content: input.message,
    });
    const queuedCount = getPendingSessionTurns(queuedState, input.project).length;

    const canPreempt = shouldPreemptLiveStewardTurn({
      sessionId: input.sessionId,
      run: existingConsoleRun,
    });

    pushStatusNote(statusNotes, `Live console run already active: ${existingConsoleRun.runId}.`);

    const currentActivity = canPreempt
      ? await (async () => {
          await requestConsoleRunStop({
            projectPaths,
            run: existingConsoleRun,
            actor: "human-follow-up",
          });
          pushStatusNote(
            statusNotes,
            `Requested stop for live steward run ${existingConsoleRun.runId}.`,
          );
          pushStatusNote(
            statusNotes,
            `Queued ${queuedCount} follow-up message(s) behind the restart.`,
          );

          return buildCurrentActivitySummary({
            options: input.options,
            project: input.project,
            lead: buildInterruptedFollowUpLead(queuedCount),
          });
        })()
      : await (async () => {
          pushStatusNote(statusNotes, `Queued ${queuedCount} follow-up message(s) for the live steward.`);

          return buildCurrentActivitySummary({
            options: input.options,
            project: input.project,
            lead: buildQueuedFollowUpLead(queuedCount),
          });
        })();

    await appendSessionTurnAndBroadcast({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: currentActivity.summary,
      source: "system",
      details: buildSessionTurnDetails({
        project: input.project,
        state: currentActivity.state,
        runId: existingConsoleRun.runId,
        runtime: existingConsoleRun.runtime,
        model: existingConsoleRun.model,
        routing: buildSessionTurnRouting({
          tier: "tier3",
          mode: null,
          handledBy: "live-direct-steward",
          globalConfig,
          runtime: existingConsoleRun.runtime,
          model: existingConsoleRun.model,
          persistentStewardEnabled: false,
          fanOutUsed: 0,
          parallelismUsed: 1,
          trace: [
            "A live direct steward run was already active, so the new message was queued behind it.",
            canPreempt
              ? "The existing direct steward run was asked to stop so the queued follow-up can restart cleanly."
              : "The active steward run kept ownership of the lane.",
          ],
        }),
        statusNotes,
      }),
    });
    void schedulePendingSessionTurnDrain({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
    });
    return;
  }

  let streamedReply = "";

  if (persistentStewardEnabled) {
    if (isPersistentStewardTurnActive({
      hivePaths: input.options.hivePaths,
      sessionId: input.sessionId,
    })) {
      clearPlaceholderTimer();
      if (input.origin === "queued-follow-up") {
        await enqueuePendingSessionTurn({
          sessionsDir: input.options.hivePaths.sessionsDir,
          sessionId: input.sessionId,
          projectId: input.project,
          content: input.message,
        });
        void schedulePendingSessionTurnDrain({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
        });
        return;
      }

      const queuedState = await enqueuePendingSessionTurn({
        sessionsDir: input.options.hivePaths.sessionsDir,
        sessionId: input.sessionId,
        projectId: input.project,
        content: input.message,
      });
      const queuedCount = getPendingSessionTurns(queuedState, input.project).length;
      const aborted = await abortPersistentStewardTurn({
        hivePaths: input.options.hivePaths,
        sessionId: input.sessionId,
      });

      pushStatusNote(statusNotes, "Live persistent steward turn already active via Pi.");

      if (aborted) {
        pushStatusNote(statusNotes, "Requested abort for the live persistent steward turn.");
        pushStatusNote(statusNotes, `Queued ${queuedCount} follow-up message(s) behind the restart.`);
      } else {
        pushStatusNote(statusNotes, `Queued ${queuedCount} follow-up message(s) for the live steward.`);
      }

      const currentActivity = await buildCurrentActivitySummary({
        options: input.options,
        project: input.project,
        lead: aborted
          ? buildInterruptedFollowUpLead(queuedCount)
          : buildQueuedFollowUpLead(queuedCount),
      });

      await appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: currentActivity.summary,
        source: "system",
        details: buildSessionTurnDetails({
          project: input.project,
          state: currentActivity.state,
          runtime: "pi",
          model: sessionModel,
          routing: buildSessionTurnRouting({
            tier: "tier3",
            mode: null,
            handledBy: "live-persistent-steward",
            globalConfig,
            runtime: sessionRuntime,
            model: sessionModel,
            persistentStewardEnabled: true,
            fanOutUsed: 0,
            parallelismUsed: 1,
            trace: [
              "A live persistent steward turn was already active, so the new message was queued behind it.",
              aborted
                ? "The active persistent turn was asked to abort so the queued follow-up can restart."
                : "The active persistent steward kept ownership of the lane.",
            ],
          }),
          statusNotes,
        }),
      });
      void schedulePendingSessionTurnDrain({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
      });
      return;
    }

    const persistent = await runPersistentStewardTurn({
      hivePaths: input.options.hivePaths,
      projectId: input.project,
      sessionId: input.sessionId,
      humanMessage: input.message,
      onOutput: (chunk) => {
        if (!chunk.trim()) {
          return;
        }

        clearPlaceholderTimer();
        streamedReply += chunk;
        broadcastSessionStream({
          broadcast: input.broadcast,
          sessionId: input.sessionId,
          project: input.project,
          content: streamedReply.trimEnd(),
        });
      },
    });

    if (persistent.mode === "persistent") {
      clearPlaceholderTimer();

      if (persistent.status === "cancelled") {
        pushStatusNote(statusNotes, "Persistent steward turn interrupted before it produced a final reply.");
        void schedulePendingSessionTurnDrain({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
        });
        return;
      }

      if (persistent.finalVisibleOutput.trim()) {
        pushStatusNote(statusNotes, "Persistent steward turn completed via Pi.");
        const finalState = await refreshProjectRuntimeState({
          hivePaths: input.options.hivePaths,
          projectId: input.project,
          projectPaths,
        });

        await appendSessionTurnAndBroadcast({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
          project: input.project,
          role: "assistant",
          content: persistent.finalVisibleOutput.trim(),
          source: "model",
          details: buildSessionTurnDetails({
            project: input.project,
            state: finalState,
            runtime: persistent.runtime,
            model: persistent.model,
            authMode: "unknown",
            durationMs: persistent.usage.durationMs,
            numTurns: persistent.usage.numTurns,
            costUsd: persistent.usage.costUsd,
            inputTokens: persistent.usage.inputTokens,
            outputTokens: persistent.usage.outputTokens,
            cacheCreationInputTokens: persistent.usage.cacheCreationInputTokens,
            cacheReadInputTokens: persistent.usage.cacheReadInputTokens,
            totalTokens: persistent.usage.totalTokens,
            routing: buildSessionTurnRouting({
              tier: "tier3",
              mode: "direct-answer",
              handledBy: "persistent-steward",
              globalConfig,
              runtime: sessionRuntime,
              model: sessionModel,
              persistentStewardEnabled: true,
              fanOutUsed: 0,
              parallelismUsed: 1,
              reusedFreshWorkerOutput: false,
              trace: [
                "The message was routed to the persistent steward lane.",
                "Pi handled the turn using the configured steward runtime route.",
                "No separate tier-1 or worker pre-router intercepted the message before the steward.",
              ],
            }),
            statusNotes,
          }),
        });

        const syncedState = await refreshProjectRuntimeState({
          hivePaths: input.options.hivePaths,
          projectId: input.project,
          projectPaths,
        });
        await updateSessionProjectState({
          sessionsDir: input.options.hivePaths.sessionsDir,
          sessionId: input.sessionId,
          projectId: input.project,
          lastRevisionSeen: syncedState.revision.revision,
        });
        void schedulePendingSessionTurnDrain({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
        });
        return;
      }

      pushStatusNote(
        statusNotes,
        "Persistent steward produced no visible reply; falling back to the direct steward path.",
      );
    } else {
      pushStatusNote(statusNotes, `Persistent steward unavailable: ${persistent.reason}`);
    }
  }

  try {
    streamedReply = "";
    const direct = await runDirectStewardTurn({
      hivePaths: input.options.hivePaths,
      projectId: input.project,
      sessionId: input.sessionId,
      humanMessage: input.message,
      onOutput: (chunk) => {
        if (!chunk.trim()) {
          return;
        }

        clearPlaceholderTimer();
        streamedReply += chunk;
        broadcastSessionStream({
          broadcast: input.broadcast,
          sessionId: input.sessionId,
          project: input.project,
          content: streamedReply.trimEnd(),
        });
      },
    });

    if (direct.mode === "fallback") {
      clearPlaceholderTimer();
      pushStatusNote(statusNotes, `Direct steward unavailable: ${direct.reason}`);

      if (/console run already active/i.test(direct.reason)) {
        if (input.origin === "queued-follow-up") {
          await enqueuePendingSessionTurn({
            sessionsDir: input.options.hivePaths.sessionsDir,
            sessionId: input.sessionId,
            projectId: input.project,
            content: input.message,
          });
          void schedulePendingSessionTurnDrain({
            options: input.options,
            broadcast: input.broadcast,
            sessionId: input.sessionId,
          });
          return;
        }

        const queuedState = await enqueuePendingSessionTurn({
          sessionsDir: input.options.hivePaths.sessionsDir,
          sessionId: input.sessionId,
          projectId: input.project,
          content: input.message,
        });
        const queuedCount = getPendingSessionTurns(queuedState, input.project).length;

        pushStatusNote(statusNotes, `Queued ${queuedCount} follow-up message(s) for the live steward.`);
        const currentActivity = await buildCurrentActivitySummary({
          options: input.options,
          project: input.project,
          lead: buildQueuedFollowUpLead(queuedCount),
        });

        await appendSessionTurnAndBroadcast({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
          project: input.project,
          role: "assistant",
          content: currentActivity.summary,
          source: "system",
          details: buildSessionTurnDetails({
            project: input.project,
            state: currentActivity.state,
            routing: buildSessionTurnRouting({
              tier: "tier3",
              mode: null,
              handledBy: "queued-direct-steward",
              globalConfig,
              runtime: sessionRuntime,
              model: sessionModel,
              persistentStewardEnabled: false,
              fanOutUsed: 0,
              parallelismUsed: 1,
              trace: [
                "The direct steward lane was busy, so the message was queued behind the current live steward turn.",
              ],
            }),
            statusNotes,
          }),
        });
        void schedulePendingSessionTurnDrain({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
        });
        return;
      }

      broadcastSessionStream({
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        content: "Direct reply path is unavailable, so the hive is continuing through background coordination.",
      });

      await continueQueuedWorkflow({
        ...input,
        statusNotes,
      });
      return;
    }

    clearPlaceholderTimer();

    if (direct.finalRun.status === "cancelled") {
      pushStatusNote(statusNotes, `Direct steward run interrupted: ${direct.finalRun.runId}.`);
      void schedulePendingSessionTurnDrain({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
      });
      return;
    }

    pushStatusNote(statusNotes, `Direct steward run completed: ${direct.finalRun.runId}.`);
    const finalState = await refreshProjectRuntimeState({
      hivePaths: input.options.hivePaths,
      projectId: input.project,
      projectPaths,
    });

    if (direct.finalVisibleOutput.trim()) {
      await appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: direct.finalVisibleOutput.trim(),
        source: "model",
        details: buildSessionTurnDetails({
          project: input.project,
          state: finalState,
          runId: direct.finalRun.runId,
          runtime: direct.finalRun.runtime,
          model: direct.finalRun.model,
          authMode: direct.result.metadata?.authMode ?? null,
          durationMs: direct.result.metadata?.durationMs ?? null,
          numTurns: direct.result.metadata?.numTurns ?? null,
          costUsd: direct.result.metadata?.costUsd ?? null,
          inputTokens: direct.result.metadata?.inputTokens ?? null,
          outputTokens: direct.result.metadata?.outputTokens ?? null,
          cacheCreationInputTokens: direct.result.metadata?.cacheCreationInputTokens ?? null,
          cacheReadInputTokens: direct.result.metadata?.cacheReadInputTokens ?? null,
          totalTokens: direct.result.metadata?.totalTokens ?? null,
          routing: buildSessionTurnRouting({
            tier: "tier3",
            mode: "direct-answer",
            handledBy: "direct-steward",
            globalConfig,
            runtime: direct.finalRun.runtime,
            model: direct.finalRun.model,
            persistentStewardEnabled: false,
            fanOutUsed: 0,
            parallelismUsed: 1,
            reusedFreshWorkerOutput: false,
            trace: [
              "The persistent steward lane was unavailable or bypassed, so the direct steward runtime handled the turn.",
              "This reply came from a disposable direct steward run rather than the long-lived Pi session.",
            ],
          }),
          statusNotes,
        }),
      });
      void schedulePendingSessionTurnDrain({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
      });
      return;
    }

    await appendSessionTurnAndBroadcast({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: "The direct turn finished without a visible reply.",
      source: "system",
        details: buildSessionTurnDetails({
          project: input.project,
          state: finalState,
          runId: direct.finalRun.runId,
          runtime: direct.finalRun.runtime,
        model: direct.finalRun.model,
        authMode: direct.result.metadata?.authMode ?? null,
        durationMs: direct.result.metadata?.durationMs ?? null,
        numTurns: direct.result.metadata?.numTurns ?? null,
        costUsd: direct.result.metadata?.costUsd ?? null,
        inputTokens: direct.result.metadata?.inputTokens ?? null,
        outputTokens: direct.result.metadata?.outputTokens ?? null,
          cacheCreationInputTokens: direct.result.metadata?.cacheCreationInputTokens ?? null,
          cacheReadInputTokens: direct.result.metadata?.cacheReadInputTokens ?? null,
          totalTokens: direct.result.metadata?.totalTokens ?? null,
          routing: buildSessionTurnRouting({
            tier: "tier3",
            mode: "direct-answer",
            handledBy: "direct-steward",
            globalConfig,
            runtime: direct.finalRun.runtime,
            model: direct.finalRun.model,
            persistentStewardEnabled: false,
            fanOutUsed: 0,
            parallelismUsed: 1,
            reusedFreshWorkerOutput: false,
            trace: [
              "The direct steward runtime completed the turn but did not emit a visible reply.",
            ],
          }),
          statusNotes,
        }),
      });
    void schedulePendingSessionTurnDrain({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
    });
  } catch (error) {
    clearPlaceholderTimer();
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    pushStatusNote(statusNotes, `Direct steward failed: ${errorMessage}`);
    broadcastSessionStream({
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      content: "The direct reply path failed, so the hive is continuing through background coordination.",
    });

    await continueQueuedWorkflow({
      ...input,
      statusNotes,
    });
  }
}

type RouteHandler = (
  req: Request,
  url: URL,
  options: GatewayOptions,
  broadcast: GatewayBroadcast,
) => Promise<Response>;

const getRoutes: Record<string, RouteHandler> = {
  "/api/status": async (_req, _url, _options, _broadcast) => {
    try {
      const result = await statusCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/feed": async (_req, url, _options, _broadcast) => {
    try {
      const count = url.searchParams.get("count") ?? "20";
      const result = await feedCommand([count]);
      return jsonOk({ result, entries: parseStructuredFeedEntries(result) });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/live": async (_req, url, options, _broadcast) => {
    try {
      const projectId = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });
      const snapshot = await buildGatewayLiveSnapshot({
        options,
        projectId,
      });
      return jsonOk(snapshot);
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/queue": async (_req, url, options, _broadcast) => {
    try {
      const projectId = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });
      const queue = await buildGatewayQueueSnapshot({
        options,
        projectId,
      });
      return jsonOk(queue);
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/timeline": async (_req, url, options, _broadcast) => {
    try {
      const rawCount = url.searchParams.get("count") ?? "40";
      const count = Number(rawCount);

      if (!Number.isInteger(count) || count <= 0) {
        return jsonError(400, "Invalid count");
      }

      const projectId = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });
      const timeline = await buildGatewayTimeline({
        options,
        projectId,
        count,
      });
      return jsonOk(timeline);
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/file": async (_req, url, _options, _broadcast) => {
    const requestedPath = url.searchParams.get("path")?.trim() ?? "";

    if (!requestedPath) {
      return jsonError(400, "Missing path");
    }

    if (!requestedPath.startsWith("/")) {
      return jsonError(400, "Path must be absolute");
    }

    const normalizedPath = requestedPath.split("#")[0] ?? requestedPath;
    const file = Bun.file(normalizedPath);

    if (!(await file.exists())) {
      return jsonError(404, `File not found: ${normalizedPath}`);
    }

    return new Response(await file.text(), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        ...corsHeaders(),
      },
    });
  },

  "/api/ps": async (_req, _url, _options, _broadcast) => {
    try {
      const result = await psCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/projects": async (_req, _url, options, _broadcast) => {
    try {
      const projects = await listProjects(options.hivePaths);
      return jsonOk({ projects });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/process-logs": async (_req, url, options, _broadcast) => {
    try {
      const projectId = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });

      if (!projectId || projectId === "default") {
        return jsonOk({
          project: null,
          supervisor: null,
          runs: [],
        });
      }

      const projectPaths = getProjectPaths(options.hivePaths, projectId);
      const requestedRunId = url.searchParams.get("run")?.trim() || null;
      const requestedLineCount = toPositiveInteger(url.searchParams.get("lines"));
      const tailLimit = Math.min(Math.max(requestedLineCount ?? (requestedRunId ? 240 : 40), 20), 400);
      const [supervisor, activeRuns] = await Promise.all([
        reconcileDetachedSupervisorState(projectPaths),
        listActiveRuns(projectPaths),
      ]);

      const supervisorPayload = supervisor
        ? {
            status: supervisor.status,
            pid: supervisor.pid,
            logPath: supervisor.logPath,
            tail: await readTextTail(
              supervisor.logPath,
              requestedRunId === "supervisor" ? tailLimit : 50,
            ),
          }
        : null;

      const runs = await Promise.all(
        activeRuns.map(async (run) => {
          const isFocusedRun = requestedRunId !== null && requestedRunId === run.runId;

          return {
            runId: run.runId,
            agentId: run.agentId,
            status: run.status,
            runtime: run.runtime,
            model: run.model,
            started: run.started,
            pid: run.pid,
            outputPath: getRunOutputPath(run),
            tail: await readRunOutputTail(run, isFocusedRun ? tailLimit : 40),
          };
        }),
      );

      return jsonOk({
        project: projectId,
        selectedRunId: requestedRunId,
        supervisor: supervisorPayload,
        runs,
      });
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/runtimes": async (_req, _url, _options, _broadcast) => {
    try {
      const result = await runtimesCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/cognition": async (_req, _url, options, _broadcast) => {
    try {
      const globalConfig = await readGatewayGlobalConfig(options);
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const activeSession = await getActiveSession(sessionsDir);
      const currentProject = activeSession
        ? await getSessionProjectFocus({
            sessionsDir,
            sessionId: activeSession.sessionId,
            fallbackProject: activeSession.project,
          })
        : null;
      const snapshot = await buildCognitiveRoutingSnapshot({
        globalConfig,
        session: activeSession
          ? {
              sessionId: activeSession.sessionId,
              project: currentProject ?? activeSession.project,
              runtime: activeSession.runtime,
              model: activeSession.model,
            }
          : null,
        persistentStewardEnabled: process.env.HIVE_ENABLE_PERSISTENT_STEWARD !== "0",
      });
      const usage = currentProject && currentProject !== "default"
        ? await refreshProjectCognitiveUsageSnapshot({
            hivePaths: options.hivePaths,
            projectId: currentProject,
            globalConfig,
          })
        : null;

      return jsonOk({
        policy: snapshot.policy,
        activeSession: snapshot.activeSession,
        activeLane: snapshot.activeLane,
        activeExecution: snapshot.activeExecution,
        defaultLane: snapshot.defaultLane,
        defaultExecution: snapshot.defaultExecution,
        tier1: snapshot.tier1,
        localModels: snapshot.localModels,
        usage,
        rendered: renderCognitiveRoutingInspectionSnapshot({
          snapshot,
          usage,
          configPath: options.hivePaths.config,
          skillsDir: options.hivePaths.skillsDir,
        }),
      });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/history": async (_req, _url, options, _broadcast) => {
    try {
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const session = await getActiveSession(sessionsDir);
      if (!session) {
        return jsonOk({ turns: [], sessionId: null, project: null });
      }
      const turns = await getSessionHistory(sessionsDir, session.sessionId);
      const project = await getSessionProjectFocus({
        sessionsDir,
        sessionId: session.sessionId,
        fallbackProject: session.project,
      });
      return jsonOk({ turns, sessionId: session.sessionId, project });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/sessions": async (_req, _url, options, _broadcast) => {
    try {
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const sessions = await listSessions(sessionsDir);
      const enrichedSessions = await Promise.all(
        sessions.map(async (session) => ({
          ...session,
          currentProject: await getSessionProjectFocus({
            sessionsDir,
            sessionId: session.sessionId,
            fallbackProject: session.project,
          }),
        })),
      );
      return jsonOk({ sessions: enrichedSessions });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },
};

const postRoutes: Record<string, RouteHandler> = {
  "/api/say": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { message?: string };
      if (!body.message) {
        return jsonError(400, "Missing 'message' field in request body");
      }
      const result = await sayCommand([body.message]);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/send": async (req, _url, options, broadcast) => {
    try {
      const body = await req.json() as { message?: string };
      if (!body.message) {
        return jsonError(400, "Missing 'message' field");
      }

      const sessionsDir = join(options.hivePaths.home, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      let session = await getActiveSession(sessionsDir);
      if (!session) {
        const activeProject = await getActiveProject(options.hivePaths);
        session = await createGatewaySession({
          options,
          project: activeProject || "default",
        });
      }

      const target = await resolveSessionTurnTarget({
        options,
        sessionId: session.sessionId,
        sessionProject: session.project,
        rawMessage: body.message,
      });

      await appendTurn({
        sessionsDir,
        sessionId: session.sessionId,
        role: "human",
        content: body.message,
        source: "human",
      });

      if (!target.continueWorkflow) {
        const result = target.result ?? "Command completed.";
        await appendTurn({
          sessionsDir,
          sessionId: session.sessionId,
          role: "assistant",
          content: result,
          source: target.resultSource ?? "system",
        });

        scheduleProjectRuntimeRefresh({
          hivePaths: options.hivePaths,
          projectId: target.projectId,
        });

        return jsonOk({
          result,
          resultSource: target.resultSource ?? "system",
          sessionId: session.sessionId,
          project: target.projectId,
        });
      }

      scheduleProjectRuntimeRefresh({
        hivePaths: options.hivePaths,
        projectId: target.projectId,
      });

      void continueConsoleWorkflow({
        options,
        broadcast,
        sessionId: session.sessionId,
        project: target.projectId,
        message: target.message || body.message,
      }).catch(() => {
        // Keep the request path fast; background session updates are best-effort.
      });

      return jsonOk({
        accepted: true,
        sessionId: session.sessionId,
        project: target.projectId,
      });
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/new": async (_req, _url, options, _broadcast) => {
    try {
      const sessionsDir = join(options.hivePaths.home, "sessions");
      await mkdir(sessionsDir, { recursive: true });
      const activeProject = await getActiveProject(options.hivePaths);
      const session = await createGatewaySession({
        options,
        project: activeProject || "default",
      });

      scheduleProjectRuntimeRefresh({
        hivePaths: options.hivePaths,
        projectId: session.project,
      });

      return jsonOk({ sessionId: session.sessionId, project: session.project });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/supervisor/restart": async (_req, _url, options, _broadcast) => {
    try {
      const activeProject = await getActiveProject(options.hivePaths);
      if (!activeProject) {
        return jsonError(400, "No active project");
      }
      const projectPaths = getProjectPaths(options.hivePaths, activeProject);

      // Kill existing supervisor if alive
      const existing = await reconcileDetachedSupervisorState(projectPaths);
      if (existing?.status === "active" && existing.pid && isProcessAlive(existing.pid)) {
        try {
          process.kill(existing.pid, "SIGTERM");
          // Brief wait for graceful shutdown
          await Bun.sleep(1_000);
          if (isProcessAlive(existing.pid)) {
            process.kill(existing.pid, "SIGKILL");
          }
        } catch {
          // process already dead
        }
      }

      // Start fresh
      const state = await startDetachedSupervisor({
        projectPaths,
        projectId: activeProject,
        intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
        maxParallel: DEFAULT_MAX_PARALLEL,
      });

      return jsonOk({
        message: `Supervisor restarted (pid ${state.pid ?? "unknown"})`,
        pid: state.pid,
      });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/nudge": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { message?: string };
      if (!body.message) {
        return jsonError(400, "Missing 'message' field in request body");
      }
      const result = await nudgeCommand([body.message]);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/msg": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { type?: string; from?: string; to?: string; body?: string };
      if (!body.from || !body.to || !body.body) {
        return jsonError(400, "Missing required fields: 'from', 'to', 'body'");
      }
      const args: string[] = [];
      if (body.type) {
        args.push("--type", body.type);
      }
      args.push(body.from, body.to, body.body);
      const result = await msgCommand(args);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/log": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { message?: string };
      if (!body.message) {
        return jsonError(400, "Missing 'message' field in request body");
      }
      const result = await logCommand([body.message]);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/open": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { path?: string; line?: number | string | null };
      const path = body.path?.trim();

      if (!path) {
        return jsonError(400, "Missing 'path' field");
      }

      const result = await openLocalPath({
        path,
        line: toPositiveInteger(body.line),
      });

      return jsonOk({
        ok: true,
        strategy: result.strategy,
      });
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },
};

function matchInboxRoute(pathname: string): string | null {
  const match = pathname.match(/^\/api\/inbox(?:\/([^/]+))?$/);
  if (!match) return null;
  return match[1] ?? "";
}

function matchSessionsRoute(pathname: string): string | null {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (!match) return null;
  return match[1];
}

export async function handleApi(
  req: Request,
  url: URL,
  options: GatewayOptions,
  broadcast: GatewayBroadcast,
): Promise<Response> {
  const pathname = url.pathname;

  if (req.method === "GET") {
    // Check inbox route with optional agent param
    const inboxAgent = matchInboxRoute(pathname);
    if (inboxAgent !== null) {
      try {
        const args = inboxAgent ? [inboxAgent] : [];
        const result = await inboxCommand(args);
        return jsonOk(result);
      } catch (err) {
        return jsonError(500, err instanceof Error ? err.message : "Unknown error");
      }
    }

    // Check sessions/:id route
    const sessionId = matchSessionsRoute(pathname);
    if (sessionId !== null) {
      try {
        const sessionsDir = join(options.hivePaths.home, "sessions");
        const session = await getSession(sessionsDir, sessionId);
        if (!session) {
          return jsonError(404, `Session not found: ${sessionId}`);
        }
        const turns = await getSessionHistory(sessionsDir, sessionId);
        const currentProject = await getSessionProjectFocus({
          sessionsDir,
          sessionId,
          fallbackProject: session.project,
        });
        return jsonOk({
          session: {
            ...session,
            currentProject,
          },
          turns,
        });
      } catch (err) {
        return jsonError(500, err instanceof Error ? err.message : "Unknown error");
      }
    }

    const handler = getRoutes[pathname];
    if (handler) {
      return handler(req, url, options, broadcast);
    }
  }

  if (req.method === "POST") {
    const handler = postRoutes[pathname];
    if (handler) {
      return handler(req, url, options, broadcast);
    }
  }

  return jsonError(404, `Unknown API endpoint: ${req.method} ${pathname}`);
}
