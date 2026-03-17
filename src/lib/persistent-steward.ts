import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  getModels,
  Type,
  getEnvApiKey,
  getModel,
  type AssistantMessage,
  type KnownProvider,
  type Tool,
} from "@mariozechner/pi-ai";
import { Agent, ProviderTransport } from "@mariozechner/pi-agent";

import { renderCognitiveRoutingPromptPolicy } from "./cognitive-routing";
import { UsageError } from "./errors";
import { loadPromptMemoryContext } from "./memory";
import { HivePaths, ProjectPaths, getProjectPaths } from "./paths";
import { extractRepoPath } from "./project";
import { resolvePiRuntimeRoute } from "./runtime";
import { isPiModelSupported, isPiProviderSupported } from "./pi";
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
  cognitiveRoutingPolicy: string;
};

type ActivePersistentTurn = {
  sessionId: string;
  projectId: string;
  latestAssistantText: string;
  lastEmittedText: string;
  abortRequested: boolean;
  lastEventAt: number;
  completedAt: number | null;
  lastAssistantError: string | null;
  finalError: string | null;
  abortController: AbortController | null;
  outputChain: Promise<void>;
};

type PersistentStewardHandle = {
  key: string;
  hiveHome: string;
  sessionId: string;
  repoPath: string;
  runtimeSignature: string;
  provider: string;
  modelId: string;
  systemPrompt: string;
  authPolicy: "oauth-only" | "env" | null;
  agent: Agent;
  bootstrapped: boolean;
  activeTurn: ActivePersistentTurn | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
};

type PersistentStewardTool = Tool & {
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<string>;
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

const PI_TURN_TIMEOUT_MS = 300_000;
const PI_IDLE_MS = 600_000;
const PI_TOOL_OUTPUT_MAX_CHARS = 12_000;
const PI_BASH_TIMEOUT_MS = 20_000;

function getHandleKey(hiveHome: string, sessionId: string): string {
  return `${hiveHome}:${sessionId}`;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
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

function describePiModel(input: {
  provider: string;
  modelId: string;
}): string {
  return `${input.provider}/${input.modelId}`;
}

function buildPersistentStewardSystemPrompt(input: {
  sessionPrompt: string;
  cognitiveRoutingPolicy: string;
}): string {
  return `${input.sessionPrompt || "# HIVE Steward Session"}

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
- Follow the cognitive routing policy below instead of defaulting to either solo replies or broad fan-out.
- Keep replies human-facing. Do not narrate internal session mechanics unless relevant.
- If the HIVE session tail conflicts with your in-memory assumptions, trust the HIVE session tail.

Cognitive routing policy:
${input.cognitiveRoutingPolicy}
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

## Cognitive Routing Policy
${input.cognitiveRoutingPolicy}

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

## Cognitive Routing Policy
${input.cognitiveRoutingPolicy}

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
    cognitiveRoutingPolicy: renderCognitiveRoutingPromptPolicy({
      globalConfig,
      skillsDir: input.hivePaths.skillsDir,
      sessionRuntime: sessionMeta?.runtime ?? "claude",
      sessionModel: sessionMeta?.model ?? null,
    }),
  };
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

type PersistentStewardRuntimeConfig = {
  provider: string;
  modelId: string;
  authPolicy: "oauth-only" | "env" | null;
  runtimeSignature: string;
};

type PersistentStewardExecutionContext = {
  hiveHome: string;
  repoPath: string;
  allowedRoots: string[];
};

function isWithinRoot(path: string, root: string): boolean {
  const relation = relative(root, path);

  return relation === "" || (!relation.startsWith("..") && relation !== "");
}

function getAllowedRoots(input: {
  hiveHome: string;
  repoPath: string;
}): string[] {
  return [...new Set([resolve(input.repoPath), resolve(input.hiveHome)])];
}

function resolveStewardPath(
  execution: PersistentStewardExecutionContext,
  requestedPath: string,
  cwd = execution.repoPath,
): string {
  const trimmed = requestedPath.trim();

  if (!trimmed) {
    throw new Error("A non-empty path is required.");
  }

  const candidate = resolve(cwd, trimmed);

  if (!execution.allowedRoots.some((root) => isWithinRoot(candidate, root))) {
    throw new Error(`Path escapes the steward workspace: ${candidate}`);
  }

  return candidate;
}

function normalizeMultilineText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function truncateToolOutput(value: string, maxChars = PI_TOOL_OUTPUT_MAX_CHARS): string {
  const normalized = normalizeMultilineText(value);

  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const headLength = Math.max(200, Math.floor((maxChars - 40) / 2));
  const tailLength = Math.max(120, maxChars - headLength - 40);

  return [
    normalized.slice(0, headLength).trimEnd(),
    "",
    "[... steward tool output truncated ...]",
    "",
    normalized.slice(-tailLength).trimStart(),
  ].join("\n");
}

function countMatches(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let cursor = 0;

  while (true) {
    const matchIndex = text.indexOf(needle, cursor);

    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    cursor = matchIndex + needle.length;
  }
}

async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutKiller: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        HIVE_HOME: process.env.HIVE_HOME ?? undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      if (timeoutKiller) {
        clearTimeout(timeoutKiller);
      }
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      fn();
    };

    const requestKill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore process cleanup failures.
      }

      timeoutKiller = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore process cleanup failures.
        }
      }, 150);
    };

    const onAbort = () => {
      aborted = true;
      requestKill();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      requestKill();
    }, input.timeoutMs);

    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      finish(() => {
        rejectPromise(error);
      });
    });

    child.once("close", (code) => {
      finish(() => {
        if (aborted) {
          rejectPromise(new Error("The steward command was aborted."));
          return;
        }

        if (timedOut) {
          rejectPromise(new Error(`The steward command timed out after ${input.timeoutMs}ms.`));
          return;
        }

        resolvePromise({
          stdout,
          stderr,
          exitCode: code,
        });
      });
    });
  });
}

async function renderDirectoryTree(input: {
  rootPath: string;
  depth: number;
  includeHidden: boolean;
  maxEntries: number;
}): Promise<string> {
  const lines: string[] = [];
  let emitted = 0;

  const walk = async (currentPath: string, currentDepth: number, prefix: string): Promise<void> => {
    if (emitted >= input.maxEntries || currentDepth < 0) {
      return;
    }

    let entries = await readdir(currentPath, { withFileTypes: true });
    entries = entries
      .filter((entry) => input.includeHidden || !entry.name.startsWith("."))
      .sort((left, right) => {
        if (left.isDirectory() && !right.isDirectory()) {
          return -1;
        }

        if (!left.isDirectory() && right.isDirectory()) {
          return 1;
        }

        return left.name.localeCompare(right.name);
      });

    for (const entry of entries) {
      if (emitted >= input.maxEntries) {
        lines.push(`${prefix}…`);
        return;
      }

      emitted += 1;
      lines.push(`${prefix}${entry.isDirectory() ? `${entry.name}/` : entry.name}`);

      if (entry.isDirectory() && currentDepth > 0) {
        await walk(join(currentPath, entry.name), currentDepth - 1, `${prefix}  `);
      }
    }
  };

  try {
    await readdir(input.rootPath);
  } catch {
    return input.rootPath;
  }

  await walk(input.rootPath, input.depth, "");
  return lines.length > 0 ? lines.join("\n") : "(empty)";
}

async function runNameSearch(input: {
  rootPath: string;
  query: string;
  type: "file" | "dir" | "any";
  maxResults: number;
}): Promise<string[]> {
  const matches: string[] = [];
  const normalizedQuery = input.query.trim().toLowerCase();

  const walk = async (currentPath: string): Promise<void> => {
    if (matches.length >= input.maxResults) {
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= input.maxResults) {
        return;
      }

      if (entry.name.startsWith(".")) {
        continue;
      }

      const nextPath = join(currentPath, entry.name);
      const kind =
        entry.isDirectory()
          ? "dir"
          : entry.isFile()
            ? "file"
            : "any";
      const relativePath = relative(input.rootPath, nextPath) || entry.name;
      const matchesKind = input.type === "any" || input.type === kind;
      const matchesQuery =
        !normalizedQuery ||
        relativePath.toLowerCase().includes(normalizedQuery) ||
        entry.name.toLowerCase().includes(normalizedQuery);

      if (matchesKind && matchesQuery) {
        matches.push(relativePath);
      }

      if (entry.isDirectory()) {
        await walk(nextPath);
      }
    }
  };

  await walk(input.rootPath);
  return matches;
}

function resolvePiApiKey(
  provider: string,
  input: {
    authPolicy: "oauth-only" | "env" | null;
  },
): string | undefined {
  if (provider === "anthropic" && input.authPolicy === "oauth-only") {
    return process.env.ANTHROPIC_OAUTH_TOKEN?.trim() || undefined;
  }

  const apiKey = getEnvApiKey(provider);
  return typeof apiKey === "string" && apiKey.trim() ? apiKey : undefined;
}

function resolvePersistentStewardModel(input: {
  provider: string;
  configuredModel: string | null;
  sessionModel: string | null;
}): string {
  if (input.configuredModel) {
    if (!isPiModelSupported(input.provider, input.configuredModel)) {
      throw new UsageError(
        `Configured Pi model '${input.configuredModel}' is not supported for provider '${input.provider}'.`,
      );
    }

    return input.configuredModel;
  }

  if (input.sessionModel && isPiModelSupported(input.provider, input.sessionModel)) {
    return input.sessionModel;
  }

  const fallback = getModels(input.provider as KnownProvider)[0]?.id ?? null;

  if (!fallback) {
    throw new UsageError(`No Pi model is available for provider '${input.provider}'.`);
  }

  return fallback;
}

function resolvePersistentStewardRuntime(input: {
  globalConfig: string;
  runtime: string;
  sessionModel: string | null;
  repoPath: string;
}): PersistentStewardRuntimeConfig {
  const piRoute = resolvePiRuntimeRoute({
    globalConfig: input.globalConfig,
    runtime: input.runtime,
  });

  if (!piRoute.provider) {
    throw new UsageError(
      `No Pi provider route is configured for runtime '${input.runtime}'. Configure pi-provider-${input.runtime}: <provider> in ~/.hive/config.md or use the direct steward path.`,
    );
  }

  if (!isPiProviderSupported(piRoute.provider)) {
    throw new UsageError(`Pi provider '${piRoute.provider}' is not supported in-process.`);
  }

  const modelId = resolvePersistentStewardModel({
    provider: piRoute.provider,
    configuredModel: piRoute.model,
    sessionModel: input.sessionModel,
  });

  return {
    provider: piRoute.provider,
    modelId,
    authPolicy: piRoute.authPolicy,
    runtimeSignature: [
      input.runtime,
      modelId,
      piRoute.provider,
      piRoute.authPolicy ?? "",
      input.repoPath,
    ].join(":"),
  };
}

function buildPersistentStewardTools(input: {
  hiveHome: string;
  repoPath: string;
}): PersistentStewardTool[] {
  const execution: PersistentStewardExecutionContext = {
    hiveHome: input.hiveHome,
    repoPath: input.repoPath,
    allowedRoots: getAllowedRoots({
      hiveHome: input.hiveHome,
      repoPath: input.repoPath,
    }),
  };

  return [
    {
      name: "read",
      description: "Read a file from the repo or HIVE home. Use absolute paths when possible.",
      parameters: Type.Object({
        path: Type.String(),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        endLine: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_toolCallId, args) {
        const path = resolveStewardPath(execution, String(args.path ?? ""));
        const file = Bun.file(path);

        if (!(await file.exists())) {
          throw new Error(`File not found: ${path}`);
        }

        const text = (await file.text()).replace(/\r\n/g, "\n");
        const lines = text.split("\n");
        const startLine = Math.min(lines.length || 1, Math.max(1, Number(args.startLine ?? 1)));
        const defaultEnd = Math.min(lines.length || startLine, startLine + 199);
        const endLine = Math.min(
          lines.length || startLine,
          Math.max(startLine, Number(args.endLine ?? defaultEnd)),
        );
        const selected = lines
          .slice(startLine - 1, endLine)
          .map((line, index) => `${startLine + index}| ${line}`);

        return truncateToolOutput(
          [`path: ${path}`, `lines: ${startLine}-${endLine} of ${lines.length}`, "", selected.join("\n")].join("\n"),
        );
      },
    },
    {
      name: "write",
      description: "Write a full file in the repo or HIVE home. This overwrites existing content.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
      }),
      async execute(_toolCallId, args) {
        const path = resolveStewardPath(execution, String(args.path ?? ""));
        const content = String(args.content ?? "");

        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, content);

        return `Wrote ${content.length} bytes to ${path}.`;
      },
    },
    {
      name: "edit",
      description: "Edit an existing file by replacing exact text. Set replaceAll true only when every match should change.",
      parameters: Type.Object({
        path: Type.String(),
        oldText: Type.String(),
        newText: Type.String(),
        replaceAll: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, args) {
        const path = resolveStewardPath(execution, String(args.path ?? ""));
        const oldText = String(args.oldText ?? "");
        const newText = String(args.newText ?? "");
        const replaceAll = args.replaceAll === true;
        const file = Bun.file(path);

        if (!(await file.exists())) {
          throw new Error(`File not found: ${path}`);
        }

        if (!oldText) {
          throw new Error("edit requires a non-empty oldText.");
        }

        const current = await file.text();
        const matches = countMatches(current, oldText);

        if (matches === 0) {
          throw new Error(`oldText was not found in ${path}.`);
        }

        if (matches > 1 && !replaceAll) {
          throw new Error(
            `oldText matched ${matches} times in ${path}. Set replaceAll: true or provide a more specific snippet.`,
          );
        }

        const next = replaceAll
          ? current.split(oldText).join(newText)
          : current.replace(oldText, newText);

        await Bun.write(path, next);

        return `Edited ${path} (${replaceAll ? `${matches} replacements` : "1 replacement"}).`;
      },
    },
    {
      name: "ls",
      description: "List files or directories beneath a path.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
        includeHidden: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, args) {
        const path = resolveStewardPath(execution, String(args.path ?? execution.repoPath));
        const tree = await renderDirectoryTree({
          rootPath: path,
          depth: Number(args.depth ?? 2),
          includeHidden: args.includeHidden === true,
          maxEntries: 160,
        });

        return truncateToolOutput([`path: ${path}`, "", tree].join("\n"));
      },
    },
    {
      name: "find",
      description: "Find files or directories by name substring.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        type: Type.Optional(Type.Union([
          Type.Literal("file"),
          Type.Literal("dir"),
          Type.Literal("any"),
        ])),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      async execute(_toolCallId, args) {
        const path = resolveStewardPath(execution, String(args.path ?? execution.repoPath));
        const matches = await runNameSearch({
          rootPath: path,
          query: typeof args.query === "string" ? args.query : "",
          type:
            args.type === "file" || args.type === "dir" || args.type === "any"
              ? args.type
              : "any",
          maxResults: Number(args.maxResults ?? 40),
        });

        return truncateToolOutput(
          [`path: ${path}`, "", matches.length > 0 ? matches.join("\n") : "(no matches)"].join("\n"),
        );
      },
    },
    {
      name: "grep",
      description: "Search file contents with ripgrep. Use this before broad reads when you only need a few facts.",
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
        maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      async execute(_toolCallId, args, signal) {
        const pattern = String(args.pattern ?? "").trim();

        if (!pattern) {
          throw new Error("grep requires a non-empty pattern.");
        }

        const path = resolveStewardPath(execution, String(args.path ?? execution.repoPath));
        const result = await runCommand({
          command: "rg",
          args: [
            "-n",
            "--hidden",
            "--no-heading",
            "--color",
            "never",
            "-C",
            String(Number(args.contextLines ?? 1)),
            "--max-count",
            String(Number(args.maxMatches ?? 40)),
            pattern,
            path,
          ],
          cwd: execution.repoPath,
          timeoutMs: PI_BASH_TIMEOUT_MS,
          signal,
        }).catch(async (error) => {
          if (!(error instanceof Error) || !/ENOENT/i.test(error.message)) {
            throw error;
          }

          return runCommand({
            command: "grep",
            args: ["-R", "-n", pattern, path],
            cwd: execution.repoPath,
            timeoutMs: PI_BASH_TIMEOUT_MS,
            signal,
          });
        });

        if (result.exitCode === 1 && !result.stdout.trim()) {
          return "(no matches)";
        }

        return truncateToolOutput(result.stdout || result.stderr || `(exit ${result.exitCode ?? "unknown"})`);
      },
    },
    {
      name: "bash",
      description: "Run a shell command from the repo or HIVE home when reading or editing files alone is not enough.",
      parameters: Type.Object({
        command: Type.String(),
        cwd: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: PI_BASH_TIMEOUT_MS })),
      }),
      async execute(_toolCallId, args, signal) {
        const command = String(args.command ?? "").trim();

        if (!command) {
          throw new Error("bash requires a non-empty command.");
        }

        const cwd = args.cwd
          ? resolveStewardPath(execution, String(args.cwd), execution.repoPath)
          : execution.repoPath;
        const result = await runCommand({
          command: "/bin/sh",
          args: ["-lc", command],
          cwd,
          timeoutMs: Number(args.timeoutMs ?? PI_BASH_TIMEOUT_MS),
          signal,
        });

        return truncateToolOutput(
          [
            `cwd: ${cwd}`,
            `exit: ${result.exitCode ?? "unknown"}`,
            result.stdout.trim() ? `stdout:\n${result.stdout.trimEnd()}` : "",
            result.stderr.trim() ? `stderr:\n${result.stderr.trimEnd()}` : "",
          ].filter(Boolean).join("\n\n"),
        );
      },
    },
  ];
}

function summarizePersistentUsage(input: {
  generatedMessages: unknown[];
  durationMs: number;
}): PersistentUsageSummary {
  const assistants = input.generatedMessages.filter(
    (message): message is AssistantMessage =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { role?: string }).role === "assistant",
  );
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let totalTokens = 0;
  let sawCost = false;
  let sawInput = false;
  let sawOutput = false;
  let sawCacheCreation = false;
  let sawCacheRead = false;
  let sawTotal = false;

  for (const message of assistants) {
    if (typeof message.usage?.cost?.total === "number") {
      costUsd += message.usage.cost.total;
      sawCost = true;
    }

    if (typeof message.usage?.input === "number") {
      inputTokens += message.usage.input;
      sawInput = true;
    }

    if (typeof message.usage?.output === "number") {
      outputTokens += message.usage.output;
      sawOutput = true;
    }

    if (typeof message.usage?.cacheWrite === "number") {
      cacheCreationInputTokens += message.usage.cacheWrite;
      sawCacheCreation = true;
    }

    if (typeof message.usage?.cacheRead === "number") {
      cacheReadInputTokens += message.usage.cacheRead;
      sawCacheRead = true;
    }

    if (typeof message.usage?.totalTokens === "number") {
      totalTokens += message.usage.totalTokens;
      sawTotal = true;
    }
  }

  return {
    durationMs: input.durationMs,
    numTurns: assistants.length > 0 ? assistants.length : null,
    costUsd: sawCost ? costUsd : null,
    inputTokens: sawInput ? inputTokens : null,
    outputTokens: sawOutput ? outputTokens : null,
    cacheCreationInputTokens: sawCacheCreation ? cacheCreationInputTokens : null,
    cacheReadInputTokens: sawCacheRead ? cacheReadInputTokens : null,
    totalTokens: sawTotal ? totalTokens : null,
  };
}

function queuePersistentTurnOutput(input: {
  turn: ActivePersistentTurn;
  nextText: string;
  onOutput?: (content: string) => Promise<void> | void;
}): void {
  if (input.nextText === input.turn.lastEmittedText) {
    return;
  }

  const delta = input.nextText.startsWith(input.turn.lastEmittedText)
    ? input.nextText.slice(input.turn.lastEmittedText.length)
    : input.nextText;

  input.turn.lastEmittedText = input.nextText;

  if (!delta.trim()) {
    return;
  }

  input.turn.outputChain = input.turn.outputChain.then(async () => {
    await input.onOutput?.(delta);
  });
}

function getMockAuthState(input: {
  provider: string;
  authPolicy: "oauth-only" | "env" | null;
}): string {
  if (input.provider !== "anthropic") {
    return resolvePiApiKey(input.provider, { authPolicy: input.authPolicy }) ? "configured" : "none";
  }

  if (input.authPolicy === "oauth-only") {
    return process.env.ANTHROPIC_OAUTH_TOKEN?.trim() ? "oauth" : "none";
  }

  if (process.env.ANTHROPIC_OAUTH_TOKEN?.trim()) {
    return "oauth";
  }

  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return "api";
  }

  return "none";
}

async function runMockPersistentStewardTurn(input: {
  handle: PersistentStewardHandle;
  turn: ActivePersistentTurn;
  promptMessage: string;
  onOutput?: (content: string) => Promise<void> | void;
}): Promise<{
  status: "completed" | "cancelled";
  finalVisibleOutput: string;
  usage: PersistentUsageSummary;
}> {
  const behavior = process.env.HIVE_TEST_PI_BEHAVIOR?.trim() || "reply";
  const humanTurnMatch = /## Human Turn\n([\s\S]*)$/m.exec(input.promptMessage);
  const humanTurn = humanTurnMatch?.[1]?.trim() || "mock task";
  const replyPrefix =
    behavior === "auth"
      ? `Mock persistent steward auth: ${getMockAuthState({
          provider: input.handle.provider,
          authPolicy: input.handle.authPolicy,
        })} | `
      : "Mock persistent steward reply: ";
  const reply = `${replyPrefix}${humanTurn}`;
  const initialDelayMs = behavior === "slow" ? 650 : 25;
  const finalDelayMs = behavior === "slow" ? 250 : 35;

  input.turn.abortController = new AbortController();
  noteActiveTurnEvent(input.turn);

  const wait = async (ms: number) => {
    if (ms > 0) {
      await Bun.sleep(ms);
    }

    if (input.turn.abortRequested || input.turn.abortController?.signal.aborted) {
      throw new Error("aborted");
    }
  };

  try {
    if (behavior === "error") {
      await wait(40);
      input.turn.lastAssistantError = "Connection error.";
      input.turn.finalError = "Connection error.";
      input.turn.completedAt = Date.now();
      throw new Error("Connection error.");
    }

    await wait(initialDelayMs);
    const halfway = Math.max(1, Math.floor(reply.length / 2));
    input.turn.latestAssistantText = reply.slice(0, halfway);
    queuePersistentTurnOutput({
      turn: input.turn,
      nextText: input.turn.latestAssistantText,
      onOutput: input.onOutput,
    });
    noteActiveTurnEvent(input.turn);

    await wait(finalDelayMs);
    input.turn.latestAssistantText = reply;
    queuePersistentTurnOutput({
      turn: input.turn,
      nextText: input.turn.latestAssistantText,
      onOutput: input.onOutput,
    });
    input.turn.completedAt = Date.now();
    noteActiveTurnEvent(input.turn);
    await input.turn.outputChain;

    return {
      status: input.turn.abortRequested ? "cancelled" : "completed",
      finalVisibleOutput: input.turn.abortRequested ? "" : reply,
      usage: {
        durationMs: initialDelayMs + finalDelayMs,
        numTurns: 1,
        costUsd: 0.02,
        inputTokens: 21,
        outputTokens: 13,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 34,
      },
    };
  } catch (error) {
    if (input.turn.abortRequested || input.turn.abortController?.signal.aborted) {
      return {
        status: "cancelled",
        finalVisibleOutput: "",
        usage: {
          durationMs: null,
          numTurns: null,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          totalTokens: null,
        },
      };
    }

    throw error;
  }
}

async function startPersistentStewardHandle(input: {
  hivePaths: HivePaths;
  sessionId: string;
  repoPath: string;
  runtimeConfig: PersistentStewardRuntimeConfig;
  systemPrompt: string;
}): Promise<PersistentStewardHandle> {
  const key = getHandleKey(input.hivePaths.home, input.sessionId);
  const agent = new Agent({
    transport: new ProviderTransport({
      getApiKey: (provider) =>
        resolvePiApiKey(provider, {
          authPolicy: input.runtimeConfig.authPolicy,
        }),
    }),
  });

  agent.setSystemPrompt(input.systemPrompt);
  agent.setModel(getModel(input.runtimeConfig.provider as never, input.runtimeConfig.modelId as never));
  agent.setTools(buildPersistentStewardTools({
    hiveHome: input.hivePaths.home,
    repoPath: input.repoPath,
  }) as never);

  if (!process.env.HIVE_TEST_PI_BEHAVIOR) {
    const apiKey = resolvePiApiKey(input.runtimeConfig.provider, {
      authPolicy: input.runtimeConfig.authPolicy,
    });

    if (!apiKey) {
      throw new UsageError(
        `No Pi credentials are available for provider '${input.runtimeConfig.provider}'.`,
      );
    }
  }

  const handle: PersistentStewardHandle = {
    key,
    hiveHome: input.hivePaths.home,
    sessionId: input.sessionId,
    repoPath: input.repoPath,
    runtimeSignature: input.runtimeConfig.runtimeSignature,
    provider: input.runtimeConfig.provider,
    modelId: input.runtimeConfig.modelId,
    systemPrompt: input.systemPrompt,
    authPolicy: input.runtimeConfig.authPolicy,
    agent,
    bootstrapped: false,
    activeTurn: null,
    idleTimer: null,
    disposed: false,
  };

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
  const runtimeConfig = resolvePersistentStewardRuntime({
    globalConfig,
    runtime: input.runtime,
    sessionModel: input.model,
    repoPath: input.repoPath,
  });
  const existing = persistentStewardHandles.get(key);

  if (existing && !existing.disposed && existing.runtimeSignature === runtimeConfig.runtimeSignature) {
    clearIdleTimer(existing);
    return existing;
  }

  if (existing) {
    await disposePersistentStewardHandle(existing, "restarting");
  }

  const handle = await startPersistentStewardHandle({
    hivePaths: input.hivePaths,
    sessionId: input.sessionId,
    repoPath: input.repoPath,
    runtimeConfig,
    systemPrompt: input.systemPrompt,
  });
  persistentStewardHandles.set(key, handle);
  return handle;
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
  handle.activeTurn.abortController?.abort();
  handle.agent.abort();
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
    const systemPrompt = buildPersistentStewardSystemPrompt({
      sessionPrompt: context.sessionPrompt,
      cognitiveRoutingPolicy: context.cognitiveRoutingPolicy,
    });
    const handle = await acquirePersistentStewardHandle({
      hivePaths: input.hivePaths,
      sessionId: input.sessionId,
      repoPath: context.repoPath,
      runtime: context.sessionRuntime,
      model: context.sessionModel,
      systemPrompt,
    });
    activeHandle = handle;

    if (handle.activeTurn) {
      return {
        mode: "fallback",
        reason: "persistent steward turn already active",
      };
    }

    const turn: ActivePersistentTurn = {
      sessionId: input.sessionId,
      projectId: input.projectId,
      latestAssistantText: "",
      lastEmittedText: "",
      abortRequested: false,
      lastEventAt: Date.now(),
      completedAt: null,
      lastAssistantError: null,
      finalError: null,
      abortController: null,
      outputChain: Promise.resolve(),
    };
    handle.activeTurn = turn;
    handle.systemPrompt = systemPrompt;
    handle.agent.setSystemPrompt(systemPrompt);
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
    const unsubscribe = handle.agent.subscribe((event) => {
      if (handle.activeTurn !== turn) {
        return;
      }

      noteActiveTurnEvent(turn);

      if ("message" in event && event.message?.role === "assistant") {
        observeAssistantMessage(turn, event.message, event.type === "message_end");

        if (turn.latestAssistantText) {
          queuePersistentTurnOutput({
            turn,
            nextText: turn.latestAssistantText,
            onOutput: input.onOutput,
          });
        }
      }

      if (event.type === "agent_end" || event.type === "turn_end") {
        turn.completedAt = Date.now();
      }
    });

    const startedAt = Date.now();
    const messageCountBefore = handle.agent.state.messages.length;
    const completion = await Promise.race([
      (async () => {
        if (process.env.HIVE_TEST_PI_BEHAVIOR) {
          const mock = await runMockPersistentStewardTurn({
            handle,
            turn,
            promptMessage,
            onOutput: input.onOutput,
          });

          return {
            ...mock,
            model: describePiModel({
              provider: handle.provider,
              modelId: handle.modelId,
            }),
          };
        }

        await handle.agent.prompt(promptMessage);
        await turn.outputChain;

        const generatedMessages = handle.agent.state.messages.slice(messageCountBefore);
        const finalVisibleOutput = turn.abortRequested ? "" : turn.latestAssistantText.trim();

        if (!turn.abortRequested && !finalVisibleOutput) {
          throw new Error(
            turn.finalError ||
              turn.lastAssistantError ||
              "Persistent steward completed without a visible reply.",
          );
        }

        return {
          status: turn.abortRequested ? "cancelled" : "completed",
          finalVisibleOutput,
          model: describePiModel({
            provider: handle.provider,
            modelId: handle.modelId,
          }),
          usage: summarizePersistentUsage({
            generatedMessages,
            durationMs: Date.now() - startedAt,
          }),
        };
      })(),
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(() => {
          turn.abortRequested = true;
          turn.abortController?.abort();
          handle.agent.abort();
          reject(new Error("Timed out waiting for the persistent steward turn to finish."));
        }, PI_TURN_TIMEOUT_MS);

        turn.outputChain.finally(() => {
          clearTimeout(timeout);
        });
      }),
    ]).finally(() => {
      unsubscribe();
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
  _reason = "shutdown",
): Promise<void> {
  if (handle.disposed) {
    return;
  }

  handle.disposed = true;
  clearIdleTimer(handle);
  persistentStewardHandles.delete(handle.key);
  handle.activeTurn?.abortController?.abort();
  handle.agent.abort();
  handle.activeTurn = null;
}

export async function disposePersistentStewardsForHome(hiveHome: string): Promise<void> {
  const matches = [...persistentStewardHandles.values()].filter((handle) => handle.hiveHome === hiveHome);

  await Promise.all(matches.map((handle) => disposePersistentStewardHandle(handle, "gateway-stop")));
}
