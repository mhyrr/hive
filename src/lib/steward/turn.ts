import { existsSync, readFileSync } from "node:fs";
import { Agent, ProviderTransport } from "@mariozechner/pi-agent";
import { join } from "node:path";

import { UsageError } from "../errors";
import { appendFeedEntry } from "../feed";
import { parseFrontmatter } from "../frontmatter";
import { captureGitStatusSnapshot, diffGitStatusSnapshots } from "../git";
import { appendLogEntry } from "../log";
import { type HivePaths, getProjectPaths } from "../paths";
import {
  createRunDraft,
  finalizeRun,
  getRunOutputPath,
  markRunActive,
  reconcileActiveConsoleRun,
  readActiveRun,
  readRunRecord,
  type RunRecord,
  type RunResult,
  writeRunResult,
} from "../runs";
import { ensureDirectory } from "../paths";
import { switchSessionProject, updateSessionProjectState } from "../sessions";
import { refreshProjectRuntimeState } from "../state";
import { compressCompletedRunOutput } from "../tier1";
import {
  buildLaunchSpec,
  inferRuntimeAuthMode,
  type LaunchResult,
  resolveRuntimeHints,
  startLaunchSpec,
  validateRuntimeInstalled,
} from "../runtime";

import { loadStewardContext, renderStewardRoutingPolicy } from "./context";
import {
  buildDirectStewardTurnPrompt,
  buildPersistentStewardBootstrapMessage,
  buildPersistentStewardRefreshMessage,
  buildPersistentStewardSystemPrompt,
} from "./prompts";
import {
  buildPiModel,
  describePiModel,
  resolvePersistentStewardRuntime,
  resolvePiApiKey,
  type PersistentStewardRuntimeConfig,
} from "./runtime";
import { buildPersistentStewardTools } from "./tools";
import { sanitizeStewardOutput } from "./sanitize";
import { buildUsageDetails, type PersistentUsageSummary, summarizePersistentUsage } from "./usage";

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
    totalTokens?: number;
    cost?: {
      total?: number;
    };
  };
};

type ActivePersistentTurn = {
  sessionId: string;
  projectId: string;
  latestAssistantText: string;
  visibleAssistantText: string;
  lastEmittedText: string;
  pendingSegmentBreak: boolean;
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

export type PersistentStewardTurnStage =
  | "starting-session"
  | "loading-context"
  | "waiting-for-response";

export type PersistentStewardTurnStatus = {
  stage: PersistentStewardTurnStage;
  label: string;
  at: string;
};

const persistentStewardHandles = new Map<string, PersistentStewardHandle>();

const PI_TURN_TIMEOUT_MS = 300_000;
const PI_IDLE_MS = 600_000;

function getHandleKey(hiveHome: string, sessionId: string): string {
  return `${hiveHome}:${sessionId}`;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function mergeVisibleTranscript(primary: string, secondary: string): string {
  const normalizedPrimary = sanitizeStewardOutput(primary).trim();
  const normalizedSecondary = sanitizeStewardOutput(secondary).trim();

  if (!normalizedPrimary) {
    return normalizedSecondary;
  }

  if (!normalizedSecondary) {
    return normalizedPrimary;
  }

  if (
    normalizedPrimary === normalizedSecondary ||
    normalizedPrimary.endsWith(normalizedSecondary)
  ) {
    return normalizedPrimary;
  }

  if (normalizedSecondary.startsWith(normalizedPrimary)) {
    return normalizedSecondary;
  }

  return `${normalizedPrimary}\n\n---\n\n${normalizedSecondary}`;
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

function clearIdleTimer(handle: PersistentStewardHandle): void {
  if (handle.idleTimer) {
    clearTimeout(handle.idleTimer);
    handle.idleTimer = null;
  }
}

function scheduleIdleShutdown(handle: PersistentStewardHandle): void {
  if (handle.disposed) {
    return;
  }

  clearIdleTimer(handle);

  const idleMs = process.env.HIVE_TEST_PI_BEHAVIOR ? 100 : PI_IDLE_MS;

  handle.idleTimer = setTimeout(() => {
    void disposePersistentStewardHandle(handle, "idle");
  }, idleMs);
}

function buildPersistentTurnStatus(
  stage: PersistentStewardTurnStage,
): PersistentStewardTurnStatus {
  const labels: Record<PersistentStewardTurnStage, string> = {
    "starting-session": "Starting steward session...",
    "loading-context": "Loading project context...",
    "waiting-for-response": "Waiting for response...",
  };

  return {
    stage,
    label: labels[stage],
    at: new Date().toISOString(),
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

  const startedNewSegment =
    input.turn.lastEmittedText.length > 0 &&
    !input.nextText.startsWith(input.turn.lastEmittedText);
  const rawDelta = input.nextText.startsWith(input.turn.lastEmittedText)
    ? input.nextText.slice(input.turn.lastEmittedText.length)
    : input.nextText;

  input.turn.lastEmittedText = input.nextText;
  if (startedNewSegment && input.turn.visibleAssistantText.trim()) {
    input.turn.pendingSegmentBreak = true;
  }

  let delta = sanitizeStewardOutput(rawDelta);

  if (!delta.trim()) {
    return;
  }

  if (input.turn.pendingSegmentBreak) {
    delta = `\n\n---\n\n${delta}`;
    input.turn.pendingSegmentBreak = false;
  }

  input.turn.visibleAssistantText += delta;

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
  const secondReply =
    behavior === "segments"
      ? "Final synthesis: delegated worker findings are now merged."
      : "";
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
    noteActiveTurnEvent(input.turn);

    if (secondReply) {
      await wait(finalDelayMs);
      const secondHalfway = Math.max(1, Math.floor(secondReply.length / 2));
      input.turn.latestAssistantText = secondReply.slice(0, secondHalfway);
      queuePersistentTurnOutput({
        turn: input.turn,
        nextText: input.turn.latestAssistantText,
        onOutput: input.onOutput,
      });
      noteActiveTurnEvent(input.turn);

      await wait(finalDelayMs);
      input.turn.latestAssistantText = secondReply;
      queuePersistentTurnOutput({
        turn: input.turn,
        nextText: input.turn.latestAssistantText,
        onOutput: input.onOutput,
      });
    }

    input.turn.completedAt = Date.now();
    noteActiveTurnEvent(input.turn);
    await input.turn.outputChain;

    return {
      status: input.turn.abortRequested ? "cancelled" : "completed",
      finalVisibleOutput: input.turn.abortRequested
        ? ""
        : (input.turn.visibleAssistantText.trim() || secondReply || reply),
      usage: {
        durationMs: initialDelayMs + finalDelayMs + (secondReply ? finalDelayMs * 2 : 0),
        numTurns: secondReply ? 2 : 1,
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
  agent.setModel(buildPiModel(input.runtimeConfig) as never);
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
  globalConfig: string;
  systemPrompt: string;
}): Promise<PersistentStewardHandle> {
  const key = getHandleKey(input.hivePaths.home, input.sessionId);
  const runtimeConfig = resolvePersistentStewardRuntime({
    globalConfig: input.globalConfig,
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

export async function runDirectStewardTurn(input: {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
  humanMessage: string;
  onOutput?: (content: string) => Promise<void> | void;
}): Promise<StewardTurnResult> {
  const context = await loadStewardContext({
    hivePaths: input.hivePaths,
    projectId: input.projectId,
    sessionId: input.sessionId,
    recentTurnLimit: 8,
  });
  const hints = resolveRuntimeHints({
    globalConfig: context.globalConfig,
    runtimeOverride: context.sessionRuntimeOverride,
    modelOverride: context.sessionModelOverride,
  });

  await reconcileActiveConsoleRun(context.projectPaths);

  try {
    await validateRuntimeInstalled(hints.runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: "fallback",
      reason: message,
    };
  }

  const existingConsoleRun = await readActiveRun(context.projectPaths, "console");

  if (existingConsoleRun) {
    return {
      mode: "fallback",
      reason: `console run already active (${existingConsoleRun.runId})`,
    };
  }

  const prompt = buildDirectStewardTurnPrompt({
    ...context,
    hivePaths: input.hivePaths,
    projectId: input.projectId,
    sessionId: input.sessionId,
    cognitiveRoutingPolicy: renderStewardRoutingPolicy({
      globalConfig: context.globalConfig,
      skillsDir: input.hivePaths.skillsDir,
      sessionRuntime: hints.runtime,
      sessionModel: hints.model,
    }),
    humanMessage: input.humanMessage,
  });

  const beforeGit = captureGitStatusSnapshot(context.repoPath);
  const spec = buildLaunchSpec({
    runtime: hints.runtime,
    model: hints.model,
    repoPath: context.repoPath,
    hiveHome: input.hivePaths.home,
    prompt,
  });

  let run = await createRunDraft({
    projectId: input.projectId,
    projectPaths: context.projectPaths,
    agentId: "console",
    runtime: spec.runtime,
    model: spec.model,
    prompt,
    source: "console",
    sourceMessage: input.sessionId,
  });

  await appendLogEntry(
    context.projectPaths.log,
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

  const handle = startLaunchSpec(spec, context.repoPath, {
    outputPath: getRunOutputPath(run),
    quiet: true,
  });
  run = await markRunActive(context.projectPaths, run, handle.pid);

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
      projectPaths: context.projectPaths,
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
    projectPaths: context.projectPaths,
    run: persistedRun,
    status: stopRequested
      ? "cancelled"
      : launchResult?.signal || (launchResult?.code !== null && launchResult?.code !== 0)
        ? "failed"
        : "exited",
    exitCode: launchResult?.code ?? null,
  });
  const afterGit = captureGitStatusSnapshot(context.repoPath);
  const gitDelta = diffGitStatusSnapshots(beforeGit, afterGit);
  const finalVisibleOutput = mergeVisibleTranscript(
    streamedOutput,
    launchResult?.visibleOutput?.trim() ?? "",
  );
  const cognitiveDigest = await compressCompletedRunOutput({
    run: finalRun,
    globalConfig: context.globalConfig,
    finalVisibleOutput,
    changedFiles: gitDelta.changedFiles,
    gitSummaryLines: gitDelta.summaryLines,
  });

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
    cognitiveDigest,
  });

  const refreshedState = await refreshProjectRuntimeState({
    hivePaths: input.hivePaths,
    projectId: input.projectId,
    projectPaths: context.projectPaths,
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
  onStatus?: (status: PersistentStewardTurnStatus) => Promise<void> | void;
}): Promise<PersistentStewardTurnResult> {
  let activeHandle: PersistentStewardHandle | null = null;

  try {
    await input.onStatus?.(buildPersistentTurnStatus("loading-context"));
    const context = await loadStewardContext({
      hivePaths: input.hivePaths,
      projectId: input.projectId,
      sessionId: input.sessionId,
    });
    const cognitiveRoutingPolicy = renderStewardRoutingPolicy({
      globalConfig: context.globalConfig,
      skillsDir: input.hivePaths.skillsDir,
      sessionRuntime: context.sessionRuntime,
      sessionModel: context.sessionModel,
    });
    const systemPrompt = buildPersistentStewardSystemPrompt({
      sessionPrompt: context.sessionPrompt,
      soul: context.soul,
      identity: context.identity,
      self: context.self,
      cognitiveRoutingPolicy,
    });
    const handle = await acquirePersistentStewardHandle({
      hivePaths: input.hivePaths,
      sessionId: input.sessionId,
      repoPath: context.repoPath,
      runtime: context.sessionRuntime,
      model: context.sessionModel,
      globalConfig: context.globalConfig,
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
      visibleAssistantText: "",
      lastEmittedText: "",
      pendingSegmentBreak: false,
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

    // Drain any queued worker-completion notifications and prepend them
    // to the human message so the steward sees them as part of this turn.
    const pendingNotificationBlock = await drainPendingNotifications(input.hivePaths.home);
    const fullHumanMessage = pendingNotificationBlock
      ? `${pendingNotificationBlock}\n\n---\n\n${input.humanMessage}`
      : input.humanMessage;

    const promptMessage = handle.bootstrapped
      ? buildPersistentStewardRefreshMessage({
          ...context,
          hivePaths: input.hivePaths,
          projectId: input.projectId,
          humanMessage: fullHumanMessage,
          cognitiveRoutingPolicy,
        })
      : buildPersistentStewardBootstrapMessage({
          ...context,
          hivePaths: input.hivePaths,
          projectId: input.projectId,
          sessionId: input.sessionId,
          humanMessage: fullHumanMessage,
          cognitiveRoutingPolicy,
        });
    await input.onStatus?.(buildPersistentTurnStatus("waiting-for-response"));
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
        const finalVisibleOutput = turn.abortRequested
          ? ""
          : turn.visibleAssistantText.trim();

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

export function hasPersistentStewardSession(hiveHome: string): boolean {
  if ([...persistentStewardHandles.values()].some(
    (handle) => handle.hiveHome === hiveHome && !handle.disposed,
  )) {
    return true;
  }

  if (process.env.HIVE_ENABLE_PERSISTENT_STEWARD === "0") {
    return false;
  }

  try {
    const gatewayPath = join(hiveHome, "gateway.md");
    const activeSessionPath = join(hiveHome, "sessions", "active.md");

    if (!existsSync(gatewayPath) || !existsSync(activeSessionPath)) {
      return false;
    }

    const gateway = parseFrontmatter(readFileSync(gatewayPath, "utf8"));

    if ((gateway.attributes.status ?? "").toLowerCase() !== "active") {
      return false;
    }

    const gatewayPid = Number(gateway.attributes.pid ?? "");

    if (Number.isFinite(gatewayPid) && gatewayPid > 0) {
      try {
        process.kill(gatewayPid, 0);
      } catch {
        return false;
      }
    }

    const activeSession = parseFrontmatter(readFileSync(activeSessionPath, "utf8"));
    const sessionId = activeSession.attributes.session;

    if (!sessionId) {
      return false;
    }

    const sessionMetaPath = join(hiveHome, "sessions", sessionId, "meta.md");

    if (!existsSync(sessionMetaPath)) {
      return false;
    }

    const meta = parseFrontmatter(readFileSync(sessionMetaPath, "utf8"));
    const sessionStatePath = join(hiveHome, "sessions", sessionId, "state.json");
    const sessionState = existsSync(sessionStatePath)
      ? JSON.parse(readFileSync(sessionStatePath, "utf8")) as { currentProject?: string | null }
      : null;
    const activeProjectPath = join(hiveHome, "active-project.txt");
    const activeProject = existsSync(activeProjectPath)
      ? readFileSync(activeProjectPath, "utf8").trim()
      : "";
    const sessionProject = (sessionState?.currentProject ?? meta.attributes.project ?? "").trim();

    if (!sessionProject || sessionProject === "default") {
      return false;
    }

    if (activeProject && sessionProject !== activeProject) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function ensurePersistentStewardSessionReady(input: {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
}): Promise<void> {
  const context = await loadStewardContext({
    hivePaths: input.hivePaths,
    projectId: input.projectId,
    sessionId: input.sessionId,
  });
  const cognitiveRoutingPolicy = renderStewardRoutingPolicy({
    globalConfig: context.globalConfig,
    skillsDir: input.hivePaths.skillsDir,
    sessionRuntime: context.sessionRuntime,
    sessionModel: context.sessionModel,
  });
  const systemPrompt = buildPersistentStewardSystemPrompt({
    sessionPrompt: context.sessionPrompt,
    soul: context.soul,
    identity: context.identity,
    self: context.self,
    cognitiveRoutingPolicy,
  });
  const handle = await acquirePersistentStewardHandle({
    hivePaths: input.hivePaths,
    sessionId: input.sessionId,
    repoPath: context.repoPath,
    runtime: context.sessionRuntime,
    model: context.sessionModel,
    globalConfig: context.globalConfig,
    systemPrompt,
  });

  scheduleIdleShutdown(handle);
}

export async function disposePersistentStewardsForHome(hiveHome: string): Promise<void> {
  const matches = [...persistentStewardHandles.values()].filter((handle) => handle.hiveHome === hiveHome);

  await Promise.all(matches.map((handle) => disposePersistentStewardHandle(handle, "gateway-stop")));
}

// ---------------------------------------------------------------------------
// Steward run-completion notifications
// ---------------------------------------------------------------------------

type PendingRunNotification = {
  projectId: string;
  agentId: string;
  runId: string;
  status: string;
  summary: string;
  ts: string;
};

function pendingNotificationsDir(hiveHome: string): string {
  return join(hiveHome, "steward-notifications");
}

function pendingNotificationPath(hiveHome: string, runId: string): string {
  return join(pendingNotificationsDir(hiveHome), `${runId}.json`);
}

function buildRunCompletionDelta(result: RunResult): string {
  const digest = result.cognitiveDigest;
  const summaryText = digest?.summary
    ? digest.summary
    : result.finalVisibleOutput
      ? result.finalVisibleOutput.split("\n").slice(0, 5).join("\n")
      : "(no output)";
  const outcomeLabel = digest?.outcome ?? result.status;
  const costLabel = result.costUsd != null ? ` | cost: $${result.costUsd.toFixed(4)}` : "";
  const filesLabel =
    (digest?.filesChanged.length ?? 0) > 0
      ? ` | files: ${digest!.filesChanged.join(", ")}`
      : result.changedFiles.length > 0
        ? ` | files: ${result.changedFiles.slice(0, 8).join(", ")}`
        : "";

  return [
    `[run-completed] Worker ${result.agentId} finished (${outcomeLabel})${costLabel}${filesLabel}`,
    `Run: ${result.runId} | exited: ${result.ended}`,
    summaryText,
  ].join("\n");
}

export async function readPendingRunNotifications(
  hiveHome: string,
): Promise<PendingRunNotification[]> {
  const dir = pendingNotificationsDir(hiveHome);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const notifications: PendingRunNotification[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const raw = await Bun.file(join(dir, entry.name)).text();
      const parsed = JSON.parse(raw) as Partial<PendingRunNotification>;

      if (
        typeof parsed.projectId === "string" &&
        typeof parsed.agentId === "string" &&
        typeof parsed.runId === "string" &&
        typeof parsed.status === "string" &&
        typeof parsed.summary === "string" &&
        typeof parsed.ts === "string"
      ) {
        notifications.push(parsed as PendingRunNotification);
      }
    } catch {
      // Skip malformed notification files.
    }
  }

  return notifications.sort((a, b) => a.ts.localeCompare(b.ts));
}

export async function clearPendingRunNotifications(
  hiveHome: string,
): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(pendingNotificationsDir(hiveHome), { recursive: true, force: true });
}

async function writePendingRunNotification(
  hiveHome: string,
  notification: PendingRunNotification,
): Promise<void> {
  const dir = pendingNotificationsDir(hiveHome);
  await ensureDirectory(dir);
  await Bun.write(
    pendingNotificationPath(hiveHome, notification.runId),
    `${JSON.stringify(notification, null, 2)}\n`,
  );
}

/**
 * Notify the persistent steward that a worker run completed.
 *
 * Always queues to the file-based pending store. The next steward turn
 * drains the queue and includes the notifications in its prompt context.
 * This avoids bypassing session history, gateway streaming, and turn
 * lifecycle that a direct agent.prompt() would skip.
 */
export async function notifyStewardRunCompleted(
  hiveHome: string,
  _projectId: string,
  result: RunResult,
): Promise<"queued"> {
  const delta = buildRunCompletionDelta(result);
  const notification: PendingRunNotification = {
    projectId: _projectId,
    agentId: result.agentId,
    runId: result.runId,
    status: result.status,
    summary: delta,
    ts: result.ended,
  };

  await writePendingRunNotification(hiveHome, notification);
  return "queued";
}

/**
 * Drain pending run-completion notifications and return them as a block
 * of text to prepend to the steward's next turn. Clears the queue after
 * reading so notifications are only delivered once.
 */
export async function drainPendingNotifications(
  hiveHome: string,
): Promise<string | null> {
  const notifications = await readPendingRunNotifications(hiveHome);

  if (notifications.length === 0) {
    return null;
  }

  await clearPendingRunNotifications(hiveHome);

  const lines = notifications.map((n) => n.summary);
  return `## Worker Completions Since Last Turn\n\n${lines.join("\n\n")}`;
}
