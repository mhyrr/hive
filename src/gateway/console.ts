import { existsSync } from "node:fs";
import { join } from "node:path";

import { sendGoalToProject } from "../commands/say";
import {
  renderCognitiveExecutionSummary,
  resolveCognitiveExecutionLane,
} from "../lib/cognitive-routing";
import { reconcileDetachedSupervisorState, startDetachedSupervisor } from "../lib/detached-supervisor";
import { UsageError } from "../lib/errors";
import { getActiveProject, getProjectPaths, listProjects, type HivePaths } from "../lib/paths";
import { ensurePersistentStewardSessionReady } from "../lib/persistent-steward";
import {
  findPlanAgent,
  normalizeProjectName,
  parseDefaultTeam,
} from "../lib/project";
import {
  readActiveRun,
  reconcileActiveConsoleRun,
} from "../lib/runs";
import { getAdapter, listRuntimeAdapters, resolveRuntimeHints } from "../lib/runtime";
import {
  appendTurn,
  createSession,
  getActiveSession,
  getPendingSessionTurns,
  getSession,
  getSessionState,
  switchSessionProject,
  takePendingSessionTurns,
  updateSessionMeta,
  type SessionTurnDetails,
} from "../lib/sessions";
import {
  refreshProjectRuntimeState,
  type ProjectRuntimeState,
} from "../lib/state";
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
  isProcessAlive,
} from "../lib/supervisor";
import { preprocessHumanMessage } from "../lib/tier1";
import { now, toIsoTimestamp } from "../lib/time";
import { continueConsoleWorkflow as continueStewardConsoleWorkflow } from "../lib/steward/workflow";
import {
  ensureManagedGatewaySupervisor,
  type GatewayBroadcast,
  type GatewayOptions,
} from "./server";
import {
  buildCurrentActivitySummary,
  formatActivityTime,
  readProjectAgentContext,
  summarizeRecentResult,
} from "./snapshots";

const pendingSessionTurnDrains = new Map<string, Promise<void>>();

type ScheduledProjectRefresh = {
  running: boolean;
  queued: boolean;
};

const scheduledProjectRefreshes = new Map<string, ScheduledProjectRefresh>();

function normalizeStatusNote(note: string): string {
  return note.replace(/\r\n/g, "\n").trim();
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

function formatRuntimeSelection(runtime: string, model: string | null): string {
  return model ? `${runtime} (${model})` : `${runtime} (default model)`;
}

type SessionTurnRoutingDetails = NonNullable<SessionTurnDetails["routing"]>;

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
  statusText?: string | null;
  stage?: string | null;
}): void {
  const content = input.content.trim();
  const statusText = input.statusText?.trim() ?? "";

  if (!content && !statusText) {
    return;
  }

  input.broadcast({
    type: "session-stream",
    ts: new Date().toISOString(),
    project: input.project,
    data: {
      sessionId: input.sessionId,
      content,
      statusText: statusText || null,
      stage: input.stage ?? null,
    },
  });
}

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
    "/council <question>",
    "/dream <goal>",
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
    "/dream improve the hive status command output",
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
  compilation?: SessionTurnDetails["compilation"];
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
    compilation: input.compilation ?? null,
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

function getProjectRefreshKey(hivePaths: HivePaths, projectId: string): string {
  return `${hivePaths.home}:${projectId}`;
}

export function scheduleProjectRuntimeRefresh(input: {
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

export async function getSessionProjectFocus(input: {
  sessionsDir: string;
  sessionId: string;
  fallbackProject: string;
}): Promise<string> {
  return (
    (await getSessionState(input.sessionsDir, input.sessionId))?.currentProject ||
    input.fallbackProject
  );
}

export async function resolveGatewayProjectFocus(input: {
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

async function ensureSupervisorRunning(input: {
  options: GatewayOptions;
  project: string;
}): Promise<string> {
  const managed = await ensureManagedGatewaySupervisor({
    hivePaths: input.options.hivePaths,
    projectId: input.project,
    intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
    maxParallel: DEFAULT_MAX_PARALLEL,
  });

  if (managed?.status === "active" && isProcessAlive(managed.pid)) {
    return `Supervisor active (pid ${managed.pid})`;
  }

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

  const councilMatch = trimmed.match(/^\/council\s+(.+)$/is);

  if (councilMatch) {
    const questionText = councilMatch[1]!.trim();
    const projectId = input.currentProject;

    if (!projectId || projectId === "default") {
      return {
        projectId,
        continueWorkflow: false,
        message: "",
        result: "No active project. Use /project <name> to set one first.",
        resultSource: "system",
      };
    }

    return {
      projectId,
      continueWorkflow: true,
      message: `Convene a model council on this question:\n\n${questionText}\n\nUse at least 3 diverse models from the pool via convene_council. Synthesize a unified answer as chair, surfacing agreement and disagreement.`,
      result: "",
      resultSource: "system",
    };
  }

  const dreamMatch = trimmed.match(/^\/dream\s+(.+)$/is);

  if (dreamMatch) {
    const goalText = dreamMatch[1]!.trim();
    const projectId = input.currentProject;

    if (!projectId || projectId === "default") {
      return {
        projectId,
        continueWorkflow: false,
        message: "",
        result: "No active project. Use /project <name> to set one first.",
        resultSource: "system",
      };
    }

    // Route through steward conversation — the steward decomposes and delegates
    return {
      projectId,
      continueWorkflow: true,
      message: `Plan and execute this goal:\n\n${goalText}\n\nDecompose it into parallel tasks, then delegate each one to workers.`,
      result: "",
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

export async function createGatewaySession(input: {
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

export async function primeGatewayPersistentStewardSession(input: {
  options: GatewayOptions;
  sessionId?: string | null;
}): Promise<void> {
  if (process.env.HIVE_ENABLE_PERSISTENT_STEWARD === "0") {
    return;
  }

  const sessionsDir = input.options.hivePaths.sessionsDir;
  const session = input.sessionId
    ? await getSession(sessionsDir, input.sessionId)
    : await getActiveSession(sessionsDir);

  if (!session) {
    return;
  }

  const projectId = await getSessionProjectFocus({
    sessionsDir,
    sessionId: session.sessionId,
    fallbackProject: session.project,
  });

  if (!projectId || projectId === "default") {
    return;
  }

  await ensurePersistentStewardSessionReady({
    hivePaths: input.options.hivePaths,
    projectId,
    sessionId: session.sessionId,
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

export async function resolveSessionTurnTarget(input: {
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

export function createStewardWorkflowCallbacks(input: {
  options: GatewayOptions;
  broadcast: GatewayBroadcast;
  sessionId: string;
}) {
  return {
    appendSessionTurnAndBroadcast: async (turn: {
      sessionId: string;
      project: string;
      role: "assistant";
      content: string;
      source?: "system" | "model" | null;
      details?: SessionTurnDetails | null;
    }) =>
      appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        ...turn,
      }),
    broadcastSessionStream: (stream: {
      sessionId: string;
      project: string;
      content: string;
      statusText?: string | null;
      stage?: string | null;
    }) =>
      broadcastSessionStream({
        broadcast: input.broadcast,
        ...stream,
      }),
    buildCurrentActivitySummary: (summary: {
      project: string;
      lead?: string;
    }) =>
      buildCurrentActivitySummary({
        options: input.options,
        ...summary,
      }),
    buildSessionTurnDetails,
    buildSessionTurnRouting,
    resolveDirectConsoleResponse: (params: {
      project: string;
      message: string;
      globalConfig: string;
      sessionRuntime: string;
      sessionModel: string | null;
      persistentStewardEnabled: boolean;
    }) =>
      resolveDirectConsoleResponse({
        options: input.options,
        ...params,
      }),
    ensureSupervisorRunning: (project: string) =>
      ensureSupervisorRunning({
        options: input.options,
        project,
      }),
    schedulePendingSessionTurnDrain: () => {
      void schedulePendingSessionTurnDrain({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
      });
    },
    sendGoalToProject: (goal: {
      projectId: string;
      message: string;
    }) =>
      sendGoalToProject({
        ...goal,
        paths: input.options.hivePaths,
      }),
  };
}

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

      await continueStewardConsoleWorkflow({
        hivePaths: input.options.hivePaths,
        callbacks: createStewardWorkflowCallbacks({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
        }),
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
