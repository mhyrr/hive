import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

import { UsageError } from "./errors";
import { loadPromptMemoryContext } from "./memory";
import { HivePaths, ProjectPaths, getProjectPaths } from "./paths";
import { extractRepoPath } from "./project";
import { resolvePiRuntimeRoute } from "./runtime";
import {
  getProjectSessionState,
  getSession,
  getSessionHistory,
  getSessionPrompt,
  getSessionState,
} from "./sessions";
import { readStewardDeltaHistory, refreshProjectRuntimeState } from "./state";

type PiMessageContent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

type PiMessage = {
  role?: string;
  content?: PiMessageContent[] | string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: {
      total?: number;
    };
  };
};

type PiModelState = {
  provider?: string;
  id?: string;
};

type PiSessionState = {
  model?: PiModelState | null;
  isStreaming?: boolean;
  pendingMessageCount?: number;
  messageCount?: number;
  sessionFile?: string | null;
  sessionId?: string | null;
};

type PiSessionStats = {
  sessionId?: string;
  assistantMessages?: number;
  userMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
};

type PiResponseEnvelope = {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
};

type PiCommandResult = {
  command: string;
  data: unknown;
};

type DeltaHistoryEntry = {
  revision: number;
  changes: string[];
};

type PersistentStewardContext = {
  sessionId: string;
  projectId: string;
  projectPaths: ProjectPaths;
  repoPath: string;
  sessionPrompt: string;
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

type ActivePersistentTurn = {
  sessionId: string;
  projectId: string;
  latestAssistantText: string;
  lastEmittedText: string;
  abortRequested: boolean;
  agentRunStarted: boolean;
  agentRunCompleted: boolean;
  retryPending: boolean;
  lastEventAt: number;
  completedAt: number | null;
  lastAssistantError: string | null;
  finalError: string | null;
};

type PendingPiCommand = {
  command: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: PiCommandResult) => void;
  reject: (error: Error) => void;
};

type PersistentStewardHandle = {
  key: string;
  hiveHome: string;
  sessionId: string;
  repoPath: string;
  runtimeSignature: string;
  process: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  stderrBuffer: string[];
  pendingCommands: Map<string, PendingPiCommand>;
  commandCounter: number;
  ready: Promise<void>;
  bootstrapped: boolean;
  activeTurn: ActivePersistentTurn | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
};

type PersistentUsageSummary = {
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  totalTokens: number | null;
};

export type PersistentStewardTurnResult =
  | {
      mode: "persistent";
      status: "completed" | "cancelled";
      finalVisibleOutput: string;
      runtime: string;
      model: string | null;
      usage: PersistentUsageSummary;
    }
  | {
      mode: "fallback";
      reason: string;
    };

const persistentStewardHandles = new Map<string, PersistentStewardHandle>();

const PI_READY_TIMEOUT_MS = 10_000;
const PI_COMMAND_TIMEOUT_MS = 15_000;
const PI_TURN_TIMEOUT_MS = 300_000;
const PI_IDLE_MS = 600_000;
const PI_TURN_SETTLE_GRACE_MS = 250;

function getHandleKey(hiveHome: string, sessionId: string): string {
  return `${hiveHome}:${sessionId}`;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function truncate(value: string, max = 220): string {
  const normalized = normalizeInlineText(value).replace(/\s+/g, " ");

  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function extractPiMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const record = message as PiMessage;

  if (typeof record.content === "string") {
    return record.content;
  }

  if (!Array.isArray(record.content)) {
    return "";
  }

  return record.content
    .filter((item): item is Extract<PiMessageContent, { type: "text" }> =>
      item?.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("");
}

function extractPiMessageError(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const record = message as PiMessage;
  const errorMessage =
    typeof record.errorMessage === "string" ? normalizeInlineText(record.errorMessage) : "";

  if (errorMessage) {
    return errorMessage;
  }

  return record.stopReason === "error" ? "Pi reported an assistant error." : null;
}

function noteActiveTurnEvent(turn: ActivePersistentTurn): void {
  turn.lastEventAt = Date.now();
}

function observeAssistantMessage(
  turn: ActivePersistentTurn,
  message: unknown,
  isTerminal = false,
): void {
  const nextText = extractPiMessageText(message);

  if (nextText) {
    turn.latestAssistantText = nextText;
  }

  const error = extractPiMessageError(message);

  if (error) {
    turn.lastAssistantError = error;
    return;
  }

  if (isTerminal) {
    turn.lastAssistantError = null;
    turn.finalError = null;
  }
}

function renderRecentTurns(
  turns: Awaited<ReturnType<typeof getSessionHistory>>,
  limit = 6,
): string {
  const recent = turns.slice(-limit);

  if (recent.length === 0) {
    return "(no prior conversation)";
  }

  return recent
    .map((turn) => `### ${turn.role} (${turn.ts})\n${turn.content}`)
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

function describePiModel(model: PiModelState | null | undefined): string | null {
  if (!model?.provider || !model.id) {
    return null;
  }

  return `${model.provider}/${model.id}`;
}

function buildPersistentStewardSystemPrompt(sessionPrompt: string): string {
  return `${sessionPrompt || "# HIVE Steward Session"}

You are HIVE's persistent steward session.

Pi is only the live session engine. HIVE still owns the durable memory, project
state, board, logs, messages, and worker coordination. Treat the HIVE files as
the durable source of truth.

Operating rules:
- Answer the human directly and concretely.
- Use compact state first. Only perform deeper reads when the turn actually needs them.
- Use absolute paths when working across HIVE home and project files.
- Update PLAN.md, BOARD.md, LOG.md, and message files yourself when the state changes.
- Delegate through HIVE files or \`hive\` commands when specialized worker work is needed.
- Keep replies human-facing. Do not narrate internal session mechanics unless relevant.
- If the HIVE session tail conflicts with your in-memory assumptions, trust the HIVE session tail.
`;
}

function buildPersistentStewardBootstrapMessage(input: PersistentStewardContext & {
  hivePaths: HivePaths;
  humanMessage: string;
}): string {
  return `Bootstrap the live HIVE steward session before answering the human turn. Use this compact context to load the project into working memory. Do not simply restate the bootstrap back to the human.

## Session
- session: ${input.sessionId}
- project: ${input.projectId}
- repo: ${input.repoPath}
- current-revision: ${input.currentRevision}
- last-revision-seen-in-hive-session: ${input.sessionRevision}
- configured-steward-runtime: ${input.sessionRuntime}${input.sessionModel ? ` (${input.sessionModel})` : ""}

## Shared Soul
${input.soul}

## Absolute Paths
- SOUL.md: ${input.hivePaths.soul}
- IDENTITY.md: ${input.hivePaths.identity}
- SELF.md: ${input.hivePaths.self}
- AGENTS.md: ${input.hivePaths.agents}
- TRUST.md: ${input.hivePaths.trust}
- project-config: ${input.projectPaths.config}
- PLAN.md: ${input.projectPaths.plan}
- BOARD.md: ${input.projectPaths.board}
- LOG.md: ${input.projectPaths.log}
- project-memory: ${input.projectPaths.memory}
- messages-dir: ${input.hivePaths.msgDir}
- state-dir: ${input.projectPaths.stateDir}
- board-summary-json: ${input.projectPaths.stateBoardSummary}
- open-messages-json: ${input.projectPaths.stateOpenMessages}
- active-runs-json: ${input.projectPaths.stateActiveRuns}
- recent-results-json: ${input.projectPaths.stateRecentResults}
- human-inbox-json: ${input.projectPaths.stateHumanInbox}
- latest-delta-json: ${input.projectPaths.stateStewardDelta}
- delta-history-jsonl: ${input.projectPaths.stateDeltaHistory}
- memory-summary-json: ${input.memorySummaryPath}
- memory-heat-json: ${input.memoryHeatPath}
- recent-decisions-json: ${input.recentDecisionsPath}
- project-entity-summary: ${input.projectEntitySummaryPath}
- journal: ${input.journalPath}

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
${renderDeltaHistory(input.deltaHistory, input.sessionRevision)}

## Recent HIVE Session Tail
${input.recentTurns}

## Human Turn
${input.humanMessage}`;
}

function buildPersistentStewardRefreshMessage(input: PersistentStewardContext & {
  hivePaths: HivePaths;
  humanMessage: string;
}): string {
  return `Refresh the existing live HIVE steward session with the latest compact state and then answer the human turn.

## Session
- project: ${input.projectId}
- repo: ${input.repoPath}
- current-revision: ${input.currentRevision}
- last-revision-seen-in-hive-session: ${input.sessionRevision}
- configured-steward-runtime: ${input.sessionRuntime}${input.sessionModel ? ` (${input.sessionModel})` : ""}

## Current Paths
- project-config: ${input.projectPaths.config}
- PLAN.md: ${input.projectPaths.plan}
- BOARD.md: ${input.projectPaths.board}
- LOG.md: ${input.projectPaths.log}
- project-memory: ${input.projectPaths.memory}
- messages-dir: ${input.hivePaths.msgDir}
- state-dir: ${input.projectPaths.stateDir}

## Delta Since Last Seen
${renderDeltaHistory(input.deltaHistory, input.sessionRevision)}

## Compact Snapshot
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
### Recent Decisions
${input.recentDecisionsDigest}

### Project Entity Memory
${input.projectEntityDigest}

## Recent HIVE Session Tail
${input.recentTurns}

## Human Turn
${input.humanMessage}`;
}

async function loadPersistentStewardContext(input: {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
}): Promise<PersistentStewardContext> {
  const projectPaths = getProjectPaths(input.hivePaths, input.projectId);
  const [projectConfig, sessionMeta, sessionState, sessionPrompt, runtimeState, soul, memoryContext, history] =
    await Promise.all([
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

  return {
    sessionId: input.sessionId,
    projectId: input.projectId,
    projectPaths,
    repoPath,
    sessionPrompt,
    sessionRuntime: sessionMeta?.runtime ?? "claude",
    sessionModel: sessionMeta?.model ?? null,
    sessionRevision,
    currentRevision: runtimeState.revision.revision,
    soul: soul.trim(),
    recentTurns: renderRecentTurns(history),
    deltaHistory,
    boardDigest: runtimeState.boardSummary.digest,
    openMessagesDigest: runtimeState.openMessagesSummary.digest,
    activeRunsDigest: runtimeState.activeRunsSummary.digest,
    recentResultsDigest: renderRecentResultsDigest(runtimeState.recentResultsSummary.items),
    humanInboxDigest: renderHumanInboxDigest(runtimeState.humanInboxSummary.items),
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

function buildPiLaunchArgs(input: {
  sessionFile: string;
  provider: string | null;
  piModel: string | null;
  systemPrompt: string;
}): string[] {
  const args = [
    "--mode",
    "rpc",
    "--session",
    input.sessionFile,
    "--system-prompt",
    input.systemPrompt,
    "--tools",
    "read,bash,edit,write,grep,find,ls",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--offline",
  ];

  if (input.provider) {
    args.push("--provider", input.provider);
  }

  if (input.piModel) {
    args.push("--model", input.piModel);
  }

  return args;
}

function buildPiProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  input: {
    localAgentDir?: string | null;
    providerContext?: string | null;
    authPolicy?: "oauth-only" | "env" | null;
  },
): NodeJS.ProcessEnv {
  const env = {
    ...baseEnv,
  };

  // Make the Anthropic lane explicit for Pi. Claude-oriented persistent turns
  // should use OAuth/subscription unless the policy explicitly allows raw env
  // credentials through.
  if (input.providerContext === "anthropic" && input.authPolicy === "oauth-only") {
    delete env.ANTHROPIC_API_KEY;
  }

  if (input.localAgentDir) {
    env.PI_CODING_AGENT_DIR = input.localAgentDir;
  }

  return env;
}

function clearIdleTimer(handle: PersistentStewardHandle): void {
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
    handle.idleTimer = null;
  }
}

function scheduleIdleShutdown(handle: PersistentStewardHandle): void {
  clearIdleTimer(handle);

  const idleMsRaw = process.env.HIVE_PI_IDLE_MS?.trim();
  const idleMs = idleMsRaw ? Number(idleMsRaw) : PI_IDLE_MS;

  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    return;
  }

  handle.idleTimer = setTimeout(() => {
    void disposePersistentStewardHandle(handle, "idle");
  }, idleMs);
}

function rejectPendingCommand(command: PendingPiCommand, error: Error): void {
  clearTimeout(command.timeout);
  command.reject(error);
}

function rejectAllPending(handle: PersistentStewardHandle, error: Error): void {
  for (const pending of handle.pendingCommands.values()) {
    rejectPendingCommand(pending, error);
  }
  handle.pendingCommands.clear();
}

function shouldRetryWithLocalAgentDir(error: Error): boolean {
  return /settings\.json\.lock/i.test(error.message) && /EPERM|EACCES|permission/i.test(error.message);
}

function handlePiLine(handle: PersistentStewardHandle, line: string): void {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const envelope = parsed as PiResponseEnvelope;

  if (envelope.type === "response") {
    const id = typeof envelope.id === "string" ? envelope.id : null;

    if (!id) {
      return;
    }

    const pending = handle.pendingCommands.get(id);

    if (!pending) {
      return;
    }

    handle.pendingCommands.delete(id);
    clearTimeout(pending.timeout);

    if (envelope.success) {
      pending.resolve({
        command: pending.command,
        data: envelope.data,
      });
    } else {
      pending.reject(new Error(envelope.error || `Pi command failed: ${pending.command}`));
    }
    return;
  }

  if (!handle.activeTurn) {
    return;
  }

  const turn = handle.activeTurn;
  noteActiveTurnEvent(turn);

  if (envelope.type === "agent_start") {
    turn.agentRunStarted = true;
    turn.agentRunCompleted = false;
    turn.completedAt = null;
    return;
  }

  if (envelope.type === "agent_end") {
    const messages = Array.isArray((envelope as { messages?: unknown }).messages)
      ? ((envelope as { messages?: unknown[] }).messages ?? [])
      : [];

    for (const message of messages) {
      if (message && typeof message === "object" && (message as { role?: string }).role === "assistant") {
        observeAssistantMessage(turn, message, true);
      }
    }

    turn.agentRunCompleted = true;
    turn.completedAt = Date.now();
    return;
  }

  if (envelope.type === "auto_retry_start") {
    const errorMessage =
      typeof (envelope as { errorMessage?: unknown }).errorMessage === "string"
        ? normalizeInlineText((envelope as { errorMessage?: string }).errorMessage || "")
        : "";

    turn.retryPending = true;
    turn.agentRunCompleted = false;
    turn.completedAt = null;

    if (errorMessage) {
      turn.lastAssistantError = errorMessage;
    }

    return;
  }

  if (envelope.type === "auto_retry_end") {
    const retrySucceeded = (envelope as { success?: unknown }).success === true;
    const finalError =
      typeof (envelope as { finalError?: unknown }).finalError === "string"
        ? normalizeInlineText((envelope as { finalError?: string }).finalError || "")
        : "";

    turn.retryPending = false;

    if (retrySucceeded) {
      turn.lastAssistantError = null;
      turn.finalError = null;
    } else if (finalError) {
      turn.finalError = finalError;
    }

    return;
  }

  if (envelope.type === "turn_end") {
    const message = (envelope as { message?: unknown }).message;

    if (
      message &&
      typeof message === "object" &&
      (message as { role?: string }).role === "assistant"
    ) {
      observeAssistantMessage(turn, message, true);
    }

    return;
  }

  if (
    (envelope.type === "message_update" || envelope.type === "message_end") &&
    envelope &&
    typeof envelope === "object" &&
    "message" in envelope
  ) {
    const message = (envelope as { message?: unknown }).message;

    if (
      message &&
      typeof message === "object" &&
      (message as { role?: string }).role === "assistant"
    ) {
      observeAssistantMessage(turn, message, envelope.type === "message_end");
    }
  }
}

function wirePersistentStewardStreams(handle: PersistentStewardHandle): void {
  handle.process.stdout.on("data", (chunk) => {
    handle.stdoutBuffer += chunk.toString();

    while (true) {
      const newlineIndex = handle.stdoutBuffer.indexOf("\n");

      if (newlineIndex === -1) {
        break;
      }

      const line = handle.stdoutBuffer.slice(0, newlineIndex);
      handle.stdoutBuffer = handle.stdoutBuffer.slice(newlineIndex + 1);
      handlePiLine(handle, line);
    }
  });

  handle.process.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);

    handle.stderrBuffer.push(...lines.map((line) => truncate(line, 500)));

    if (handle.stderrBuffer.length > 20) {
      handle.stderrBuffer.splice(0, handle.stderrBuffer.length - 20);
    }
  });

  const onExit = (event: "close" | "error", detail: string): void => {
    if (handle.disposed) {
      return;
    }

    handle.disposed = true;
    clearIdleTimer(handle);
    rejectAllPending(
      handle,
      new Error(`Pi steward process ${event}d: ${detail}${handle.stderrBuffer.length ? `\n${handle.stderrBuffer.join("\n")}` : ""}`),
    );
    persistentStewardHandles.delete(handle.key);
  };

  handle.process.once("error", (error) => {
    onExit("error", error.message);
  });

  handle.process.once("close", (code, signal) => {
    onExit("close", `code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}`);
  });
}

async function sendPiCommand(
  handle: PersistentStewardHandle,
  input: {
    type: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<PiCommandResult> {
  if (handle.disposed) {
    throw new Error("Pi steward process is not available.");
  }

  const id = `cmd-${++handle.commandCounter}`;
  const timeoutMs = input.timeoutMs ?? PI_COMMAND_TIMEOUT_MS;

  const command = {
    id,
    type: input.type,
    ...(input.payload ?? {}),
  };

  const result = await new Promise<PiCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      handle.pendingCommands.delete(id);
      reject(new Error(`Timed out waiting for Pi command: ${input.type}`));
    }, timeoutMs);

    handle.pendingCommands.set(id, {
      command: input.type,
      timeout,
      resolve,
      reject,
    });

    try {
      handle.process.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      handle.pendingCommands.delete(id);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return result;
}

async function getPiState(handle: PersistentStewardHandle): Promise<PiSessionState> {
  const response = await sendPiCommand(handle, {
    type: "get_state",
    timeoutMs: PI_COMMAND_TIMEOUT_MS,
  });

  return (response.data ?? {}) as PiSessionState;
}

async function getPiSessionStats(handle: PersistentStewardHandle): Promise<PiSessionStats> {
  const response = await sendPiCommand(handle, {
    type: "get_session_stats",
    timeoutMs: PI_COMMAND_TIMEOUT_MS,
  });

  return (response.data ?? {}) as PiSessionStats;
}

async function getPiLastAssistantText(handle: PersistentStewardHandle): Promise<string> {
  const response = await sendPiCommand(handle, {
    type: "get_last_assistant_text",
    timeoutMs: PI_COMMAND_TIMEOUT_MS,
  });
  const data = (response.data ?? {}) as { text?: unknown };

  return typeof data.text === "string" ? data.text.trim() : "";
}

async function startPersistentStewardHandle(input: {
  hivePaths: HivePaths;
  sessionId: string;
  repoPath: string;
  runtime: string;
  model: string | null;
  systemPrompt: string;
  localAgentDir?: string | null;
}): Promise<PersistentStewardHandle> {
  const sessionFile = join(input.hivePaths.sessionsDir, input.sessionId, "pi-session.jsonl");
  const command = process.env.HIVE_PI_COMMAND?.trim() || "pi";
  const globalConfig = await Bun.file(input.hivePaths.config).text().catch(() => "");
  const piRoute = resolvePiRuntimeRoute({
    globalConfig,
    runtime: input.runtime,
  });

  if (!piRoute.provider) {
    throw new UsageError(
      `No Pi provider route is configured for runtime '${input.runtime}'. Configure pi-provider-${input.runtime}: <provider> in ~/.hive/config.md or use the direct steward path.`,
    );
  }

  const args = buildPiLaunchArgs({
    sessionFile,
    provider: piRoute.provider,
    piModel: piRoute.model,
    systemPrompt: input.systemPrompt,
  });
  const runtimeSignature = [
    input.runtime,
    input.model ?? "",
    piRoute.provider ?? "",
    piRoute.model ?? "",
    piRoute.authPolicy ?? "",
    input.repoPath,
  ].join(":");
  const env = buildPiProcessEnv(process.env, {
    localAgentDir: input.localAgentDir,
    providerContext: piRoute.providerContext,
    authPolicy: piRoute.authPolicy,
  });

  const processHandle = spawn(command, args, {
    cwd: input.repoPath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const key = getHandleKey(input.hivePaths.home, input.sessionId);
  const handle: PersistentStewardHandle = {
    key,
    hiveHome: input.hivePaths.home,
    sessionId: input.sessionId,
    repoPath: input.repoPath,
    runtimeSignature,
    process: processHandle,
    stdoutBuffer: "",
    stderrBuffer: [],
    pendingCommands: new Map(),
    commandCounter: 0,
    bootstrapped: false,
    activeTurn: null,
    idleTimer: null,
    disposed: false,
    ready: Promise.resolve(),
  };

  wirePersistentStewardStreams(handle);

  handle.ready = (async () => {
    const readyState = await Promise.race([
      getPiState(handle),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Timed out waiting for Pi steward session to start."));
        }, PI_READY_TIMEOUT_MS);
      }),
    ]);

    handle.bootstrapped = (readyState.messageCount ?? 0) > 0;
  })();

  try {
    await handle.ready;
  } catch (error) {
    await disposePersistentStewardHandle(handle, "startup-failed");
    throw error;
  }
  scheduleIdleShutdown(handle);
  return handle;
}

async function acquirePersistentStewardHandle(input: {
  hivePaths: HivePaths;
  sessionId: string;
  repoPath: string;
  runtime: string;
  model: string | null;
  systemPrompt: string;
}): Promise<PersistentStewardHandle> {
  const key = getHandleKey(input.hivePaths.home, input.sessionId);
  const globalConfig = await Bun.file(input.hivePaths.config).text().catch(() => "");
  const piRoute = resolvePiRuntimeRoute({
    globalConfig,
    runtime: input.runtime,
  });
  const runtimeSignature = [
    input.runtime,
    input.model ?? "",
    piRoute.provider ?? "",
    piRoute.model ?? "",
    piRoute.authPolicy ?? "",
    input.repoPath,
  ].join(":");
  const existing = persistentStewardHandles.get(key);

  if (existing && !existing.disposed && existing.runtimeSignature === runtimeSignature) {
    clearIdleTimer(existing);
    await existing.ready;
    return existing;
  }

  if (existing) {
    await disposePersistentStewardHandle(existing, "restarting");
  }

  const localAgentDir =
    process.env.HIVE_PI_AGENT_DIR?.trim() || null;

  try {
    const handle = await startPersistentStewardHandle({
      ...input,
      localAgentDir,
    });
    persistentStewardHandles.set(key, handle);
    return handle;
  } catch (error) {
    const typed = error instanceof Error ? error : new Error(String(error));

    if (localAgentDir || !shouldRetryWithLocalAgentDir(typed)) {
      throw typed;
    }
  }

  const fallbackAgentDir = join(input.hivePaths.home, ".pi-agent");

  try {
    const handle = await startPersistentStewardHandle({
      ...input,
      localAgentDir: fallbackAgentDir,
    });
    persistentStewardHandles.set(key, handle);
    return handle;
  } catch (error) {
    const typed = error instanceof Error ? error : new Error(String(error));
    throw typed;
  }
}

function subtractNumber(next: number | undefined, previous: number | undefined): number | null {
  if (typeof next !== "number" || typeof previous !== "number") {
    return null;
  }

  return next - previous;
}

function diffPersistentUsage(
  beforeStats: PiSessionStats,
  afterStats: PiSessionStats,
): PersistentUsageSummary {
  return {
    durationMs: null,
    numTurns: subtractNumber(afterStats.assistantMessages, beforeStats.assistantMessages),
    costUsd: subtractNumber(afterStats.cost, beforeStats.cost),
    inputTokens: subtractNumber(afterStats.tokens?.input, beforeStats.tokens?.input),
    outputTokens: subtractNumber(afterStats.tokens?.output, beforeStats.tokens?.output),
    cacheCreationInputTokens: subtractNumber(afterStats.tokens?.cacheWrite, beforeStats.tokens?.cacheWrite),
    cacheReadInputTokens: subtractNumber(afterStats.tokens?.cacheRead, beforeStats.tokens?.cacheRead),
    totalTokens: subtractNumber(afterStats.tokens?.total, beforeStats.tokens?.total),
  };
}

async function waitForPersistentTurnCompletion(input: {
  handle: PersistentStewardHandle;
  turn: ActivePersistentTurn;
  beforeStats: PiSessionStats;
  onOutput?: (content: string) => Promise<void> | void;
}): Promise<{
  status: "completed" | "cancelled";
  finalVisibleOutput: string;
  model: string | null;
  usage: PersistentUsageSummary;
}> {
  const deadline = Date.now() + PI_TURN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const state = await getPiState(input.handle);

    const nextText = input.turn.latestAssistantText;

    if (nextText && nextText !== input.turn.lastEmittedText) {
      const delta = nextText.startsWith(input.turn.lastEmittedText)
        ? nextText.slice(input.turn.lastEmittedText.length)
        : nextText;

      input.turn.lastEmittedText = nextText;

      if (delta.trim()) {
        await input.onOutput?.(delta);
      }
    }

    const isIdle = !state.isStreaming && (state.pendingMessageCount ?? 0) === 0;
    const completionObserved =
      input.turn.agentRunCompleted ||
      Boolean(input.turn.latestAssistantText) ||
      Boolean(input.turn.finalError);
    const settledLongEnough =
      Date.now() - (input.turn.completedAt ?? input.turn.lastEventAt) >= PI_TURN_SETTLE_GRACE_MS;

    if (
      isIdle &&
      !input.turn.retryPending &&
      input.turn.agentRunStarted &&
      completionObserved &&
      settledLongEnough
    ) {
      const [afterStats, finalText, finalState] = await Promise.all([
        getPiSessionStats(input.handle),
        getPiLastAssistantText(input.handle),
        getPiState(input.handle),
      ]);
      const finalVisibleOutput = input.turn.abortRequested
        ? ""
        : finalText || input.turn.latestAssistantText;

      if (!input.turn.abortRequested && !finalVisibleOutput.trim()) {
        throw new Error(
          input.turn.finalError ||
            input.turn.lastAssistantError ||
            "Persistent steward completed without a visible reply.",
        );
      }

      return {
        status: input.turn.abortRequested ? "cancelled" : "completed",
        finalVisibleOutput,
        model: describePiModel(finalState.model),
        usage: diffPersistentUsage(input.beforeStats, afterStats),
      };
    }

    await Bun.sleep(120);
  }

  throw new Error("Timed out waiting for the persistent steward turn to finish.");
}

export function isPersistentStewardTurnActive(input: {
  hivePaths: HivePaths;
  sessionId: string;
}): boolean {
  const handle = persistentStewardHandles.get(getHandleKey(input.hivePaths.home, input.sessionId));

  return Boolean(handle && !handle.disposed && handle.activeTurn);
}

export async function abortPersistentStewardTurn(input: {
  hivePaths: HivePaths;
  sessionId: string;
}): Promise<boolean> {
  const handle = persistentStewardHandles.get(getHandleKey(input.hivePaths.home, input.sessionId));

  if (!handle || handle.disposed || !handle.activeTurn) {
    return false;
  }

  handle.activeTurn.abortRequested = true;
  await sendPiCommand(handle, {
    type: "abort",
    timeoutMs: PI_COMMAND_TIMEOUT_MS,
  }).catch(() => {});
  return true;
}

export async function runPersistentStewardTurn(input: {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
  humanMessage: string;
  onOutput?: (content: string) => Promise<void> | void;
}): Promise<PersistentStewardTurnResult> {
  let activeHandle: PersistentStewardHandle | null = null;

  try {
    const context = await loadPersistentStewardContext({
      hivePaths: input.hivePaths,
      projectId: input.projectId,
      sessionId: input.sessionId,
    });
    const handle = await acquirePersistentStewardHandle({
      hivePaths: input.hivePaths,
      sessionId: input.sessionId,
      repoPath: context.repoPath,
      runtime: context.sessionRuntime,
      model: context.sessionModel,
      systemPrompt: buildPersistentStewardSystemPrompt(context.sessionPrompt),
    });
    activeHandle = handle;

    if (handle.activeTurn) {
      return {
        mode: "fallback",
        reason: "persistent steward turn already active",
      };
    }

    const beforeStats = await getPiSessionStats(handle);
    const turn: ActivePersistentTurn = {
      sessionId: input.sessionId,
      projectId: input.projectId,
      latestAssistantText: "",
      lastEmittedText: "",
      abortRequested: false,
      agentRunStarted: false,
      agentRunCompleted: false,
      retryPending: false,
      lastEventAt: Date.now(),
      completedAt: null,
      lastAssistantError: null,
      finalError: null,
    };
    handle.activeTurn = turn;
    clearIdleTimer(handle);

    const promptMessage = handle.bootstrapped
      ? buildPersistentStewardRefreshMessage({
          ...context,
          hivePaths: input.hivePaths,
          humanMessage: input.humanMessage,
        })
      : buildPersistentStewardBootstrapMessage({
          ...context,
          hivePaths: input.hivePaths,
          humanMessage: input.humanMessage,
        });

    await sendPiCommand(handle, {
      type: "prompt",
      payload: {
        message: promptMessage,
      },
      timeoutMs: PI_COMMAND_TIMEOUT_MS,
    });

    const completion = await waitForPersistentTurnCompletion({
      handle,
      turn,
      beforeStats,
      onOutput: input.onOutput,
    });

    handle.bootstrapped = true;
    handle.activeTurn = null;
    scheduleIdleShutdown(handle);

    return {
      mode: "persistent",
      status: completion.status,
      finalVisibleOutput: completion.finalVisibleOutput.trim(),
      runtime: "pi",
      model: completion.model,
      usage: completion.usage,
    };
  } catch (error) {
    if (activeHandle) {
      activeHandle.activeTurn = null;
      await disposePersistentStewardHandle(activeHandle, "turn-failed");
    }

    return {
      mode: "fallback",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function disposePersistentStewardHandle(
  handle: PersistentStewardHandle,
  reason = "shutdown",
): Promise<void> {
  if (handle.disposed) {
    return;
  }

  handle.disposed = true;
  clearIdleTimer(handle);
  persistentStewardHandles.delete(handle.key);
  rejectAllPending(handle, new Error(`Pi steward process disposed: ${reason}`));

  try {
    handle.process.stdin.end();
  } catch {
    // ignore
  }

  try {
    handle.process.kill("SIGTERM");
  } catch {
    return;
  }

  await Bun.sleep(150);

  if (!handle.process.killed) {
    try {
      handle.process.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

export async function disposePersistentStewardsForHome(hiveHome: string): Promise<void> {
  const matches = [...persistentStewardHandles.values()].filter((handle) => handle.hiveHome === hiveHome);

  await Promise.all(matches.map((handle) => disposePersistentStewardHandle(handle, "gateway-stop")));
}
