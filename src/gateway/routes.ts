import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { GatewayBroadcast, GatewayOptions } from "./server";

import { feedCommand } from "../commands/feed";
import { parseStructuredFeedEntries } from "../lib/feed";
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
  getSessionHistory,
  getSessionState,
  listSessions,
  getSession,
  appendTurn,
  switchSessionProject,
  type SessionTurnDetails,
} from "../lib/sessions";
import { refreshProjectRuntimeState, type ProjectRuntimeState } from "../lib/state";
import { runDirectStewardTurn } from "../lib/steward";
import { resolveRuntimeHints } from "../lib/runtime";
import { normalizeProjectName } from "../lib/project";
import { UsageError } from "../lib/errors";

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
  statusNotes?: string[];
}): SessionTurnDetails {
  const uniqueNotes = [...new Set((input.statusNotes ?? []).map(normalizeStatusNote).filter(Boolean))];

  return {
    project: input.project,
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
    statusNotes: uniqueNotes.length > 0 ? uniqueNotes : null,
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

  if (run.agentId === "orchestrator") {
    return "The hive is actively assessing the project and deciding the next moves";
  }

  return `${run.agentId} is actively working${run.taskId ? ` on ${run.taskId}` : ""}`;
}

function summarizeRecentResult(input: {
  agentId: string;
  status: string;
  summary: string;
}): string {
  const base = input.agentId === "orchestrator"
    ? "The last completed hive pass"
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
    activeRuns.find((run) => run.agentId === "orchestrator") ??
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

    const leadTail = leadRun.agentId === "console"
      ? []
      : await readRunOutputTail(leadRun, 6);
    const latestVisibleLine = leadTail[leadTail.length - 1] ?? null;

    if (latestVisibleLine && leadRun.agentId !== "console") {
      lines.push(`- Latest visible output: ${latestVisibleLine}`);
    } else if (leadRun.agentId === "console") {
      lines.push("- Live reply generation is still in progress.");
    } else {
      lines.push("- No visible output from that run yet.");
    }
  } else {
    lines.push("- Nothing is actively running at the moment.");
  }

  const workerRuns = activeRuns.filter((run) => run.agentId !== "console" && run.agentId !== "orchestrator");

  if (workerRuns.length > 0) {
    lines.push(
      `- Active workers: ${workerRuns.map((run) => run.taskId ? `${run.agentId} on ${run.taskId}` : run.agentId).join(", ")}.`,
    );
  } else if (activeRuns.some((run) => run.agentId === "orchestrator")) {
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

async function createGatewaySession(input: {
  options: GatewayOptions;
  project: string;
}): Promise<Awaited<ReturnType<typeof createSession>>> {
  const globalConfig = await Bun.file(input.options.hivePaths.config).text().catch(() => "");
  let runtime = "claude";
  let model: string | null = null;

  try {
    const hints = resolveRuntimeHints({ globalConfig });
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
  switchOnly: boolean;
  switched: boolean;
}> {
  const trimmed = input.rawMessage.trim();
  const sessionState = await getSessionState(input.options.hivePaths.sessionsDir, input.sessionId);
  const currentProject =
    sessionState?.currentProject ||
    input.sessionProject ||
    (await getActiveProject(input.options.hivePaths)) ||
    "default";

  const switchMatch = trimmed.match(/^\/project\s+([^\s]+)(?:\s+(.*))?$/is);

  if (switchMatch) {
    const projectId = await resolveProjectId({
      options: input.options,
      token: switchMatch[1]!,
    });
    const message = (switchMatch[2] ?? "").trim();

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
      switchOnly: message.length === 0,
      switched: projectId !== currentProject,
    };
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
      switchOnly: message.length === 0,
      switched: projectId !== currentProject,
    };
  }

  return {
    projectId: currentProject,
    message: trimmed,
    switchOnly: false,
    switched: false,
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
    pushStatusNote(statusNotes, "Turn routed through queued orchestration.");
    broadcastSessionStream({
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      content: "Queued orchestration is assessing the project.",
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
      (run) => run.agentId === "orchestrator" && run.started >= firedAt,
    );

    if (orchestratorRun && !announcedOrchestratorRun) {
      announcedOrchestratorRun = true;
      pushStatusNote(statusNotes, `Orchestrator run ${orchestratorRun.runId} started.`);
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
        run.agentId !== "orchestrator" &&
        run.agentId !== "console" &&
        run.started >= firedAt &&
        !announcedWorkerRuns.has(run.runId),
    );

    if (freshWorkerRuns.length > 0) {
      for (const run of freshWorkerRuns) {
        announcedWorkerRuns.add(run.runId);
      }

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
        result.agentId === "orchestrator" &&
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
          content: "Queued orchestration finished without a visible reply.",
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
    content: "This is still in motion. I’ll keep the board moving, and the next orchestration result will land here when it’s ready.",
    source: "system",
    details: buildSessionTurnDetails({
      project: input.project,
      state: lastKnownState,
      statusNotes,
    }),
  });
}

async function continueConsoleWorkflow(input: {
  options: GatewayOptions;
  broadcast: GatewayBroadcast;
  sessionId: string;
  project: string;
  message: string;
}): Promise<void> {
  if (!input.project || input.project === "default") {
    return;
  }

  let supervisorLine = "Supervisor state updated.";
  const statusNotes: string[] = [];

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
    return;
  }

  broadcastSessionStream({
    broadcast: input.broadcast,
    sessionId: input.sessionId,
    project: input.project,
    content: "Reviewing the current project state and preparing a response.",
  });

  const projectPaths = getProjectPaths(input.options.hivePaths, input.project);
  await reconcileActiveConsoleRun(projectPaths);
  const existingConsoleRun = await readActiveRun(projectPaths, "console");

  if (existingConsoleRun) {
    pushStatusNote(statusNotes, `Live console run already active: ${existingConsoleRun.runId}.`);
    const currentActivity = await buildCurrentActivitySummary({
      options: input.options,
      project: input.project,
      lead: "I already have a live turn in progress, so I'm not starting another overlapping pass.",
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
        runId: existingConsoleRun.runId,
        runtime: existingConsoleRun.runtime,
        model: existingConsoleRun.model,
        statusNotes,
      }),
    });
    return;
  }

  try {
    const direct = await runDirectStewardTurn({
      hivePaths: input.options.hivePaths,
      projectId: input.project,
      sessionId: input.sessionId,
      humanMessage: input.message,
    });

    if (direct.mode === "fallback") {
      pushStatusNote(statusNotes, `Direct steward unavailable: ${direct.reason}`);

      if (/console run already active/i.test(direct.reason)) {
        const currentActivity = await buildCurrentActivitySummary({
          options: input.options,
          project: input.project,
          lead: "I already have a live turn in progress, so I'm not starting another overlapping pass.",
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
            statusNotes,
          }),
        });
        return;
      }

      broadcastSessionStream({
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        content: "Direct reply path is unavailable, so the hive is continuing through orchestrated work.",
      });

      await continueQueuedWorkflow({
        ...input,
        statusNotes,
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
        statusNotes,
      }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    pushStatusNote(statusNotes, `Direct steward failed: ${errorMessage}`);
    broadcastSessionStream({
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      content: "The direct reply path failed, so the hive is continuing through orchestrated work.",
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
      const [supervisor, activeRuns] = await Promise.all([
        reconcileDetachedSupervisorState(projectPaths),
        listActiveRuns(projectPaths),
      ]);

      const supervisorPayload = supervisor
        ? {
            status: supervisor.status,
            pid: supervisor.pid,
            logPath: supervisor.logPath,
            tail: await readTextTail(supervisor.logPath, 50),
          }
        : null;

      const runs = await Promise.all(
        activeRuns.map(async (run) => ({
          runId: run.runId,
          agentId: run.agentId,
          status: run.status,
          started: run.started,
          pid: run.pid,
          outputPath: getRunOutputPath(run),
          tail: await readRunOutputTail(run, 40),
        })),
      );

      return jsonOk({
        project: projectId,
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

      if (target.switchOnly) {
        const result = target.switched
          ? `Switched context to ${target.projectId}.`
          : `Already focused on ${target.projectId}.`;

        await appendTurn({
          sessionsDir,
          sessionId: session.sessionId,
          role: "assistant",
          content: result,
          source: "system",
        });

        scheduleProjectRuntimeRefresh({
          hivePaths: options.hivePaths,
          projectId: target.projectId,
        });

        return jsonOk({
          result,
          resultSource: "system",
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
