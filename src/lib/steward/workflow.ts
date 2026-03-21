import { dirname, join } from "node:path";

import { type HivePaths, getProjectPaths } from "../paths";
import {
  appendTurn,
  enqueuePendingSessionTurn,
  getPendingSessionTurns,
  getProjectSessionState,
  getSession,
  getSessionState,
  updateSessionProjectState,
  type SessionTurnDetails,
} from "../sessions";
import {
  markRunStopRequested,
  readActiveRun,
  readRunRecord,
  reconcileActiveConsoleRun,
  type RunRecord,
  type RunResult,
} from "../runs";
import { isProcessAlive } from "../supervisor";
import { refreshProjectRuntimeState, type ProjectRuntimeState } from "../state";

import {
  abortPersistentStewardTurn,
  isPersistentStewardTurnActive,
  readPendingRunNotifications,
  runDirectStewardTurn,
  runPersistentStewardTurn,
} from "./turn";
import { sanitizeStewardOutput } from "./sanitize";

type SessionTurnRoutingDetails = NonNullable<SessionTurnDetails["routing"]>;

export type DirectConsoleResponse = {
  content: string;
  source: "system" | "model";
  details: SessionTurnDetails;
};

export type BuildSessionTurnRoutingInput = {
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
};

export type BuildSessionTurnDetailsInput = {
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
};

export type StewardWorkflowCallbacks = {
  appendSessionTurnAndBroadcast: (input: {
    sessionId: string;
    project: string;
    role: "assistant";
    content: string;
    source?: "system" | "model" | null;
    details?: SessionTurnDetails | null;
  }) => Promise<void>;
  broadcastSessionStream: (input: {
    sessionId: string;
    project: string;
    content: string;
    statusText?: string | null;
    stage?: string | null;
  }) => void;
  buildCurrentActivitySummary: (input: {
    project: string;
    lead?: string;
  }) => Promise<{ summary: string; state: ProjectRuntimeState }>;
  buildSessionTurnDetails: (input: BuildSessionTurnDetailsInput) => SessionTurnDetails;
  buildSessionTurnRouting: (input: BuildSessionTurnRoutingInput) => SessionTurnRoutingDetails;
  resolveDirectConsoleResponse: (input: {
    project: string;
    message: string;
    globalConfig: string;
    sessionRuntime: string;
    sessionModel: string | null;
    persistentStewardEnabled: boolean;
  }) => Promise<DirectConsoleResponse | null>;
  ensureSupervisorRunning: (project: string) => Promise<string>;
  schedulePendingSessionTurnDrain: () => void;
  sendGoalToProject: (input: {
    projectId: string;
    message: string;
  }) => Promise<string>;
};

export type ContinueConsoleWorkflowInput = {
  hivePaths: HivePaths;
  callbacks: StewardWorkflowCallbacks;
  sessionId: string;
  project: string;
  message: string;
  origin?: "human" | "queued-follow-up" | "system-wake";
};

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

function joinNaturalList(items: string[]): string {
  if (items.length === 0) {
    return "(none)";
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

async function readGlobalConfig(hivePaths: HivePaths): Promise<string> {
  return Bun.file(hivePaths.config).text().catch(() => "");
}

async function continueQueuedWorkflow(input: ContinueConsoleWorkflowInput & {
  statusNotes?: string[];
}): Promise<void> {
  const firedAt = new Date().toISOString();
  const globalConfig = await readGlobalConfig(input.hivePaths);
  const statusNotes = [...(input.statusNotes ?? [])];

  try {
    const sayResult = await input.callbacks.sendGoalToProject({
      projectId: input.project,
      message: input.message,
    });
    const supervisorLine =
      sayResult.split("\n").find((line) => /Supervisor/i.test(line)) ??
      "Supervisor state updated.";
    pushStatusNote(statusNotes, supervisorLine);
    pushStatusNote(statusNotes, "Turn routed through background coordination.");
    input.callbacks.broadcastSessionStream({
      sessionId: input.sessionId,
      project: input.project,
      content: "Background coordination is assessing the project.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await input.callbacks.appendSessionTurnAndBroadcast({
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

  const projectPaths = getProjectPaths(input.hivePaths, input.project);
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
      hivePaths: input.hivePaths,
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
      input.callbacks.broadcastSessionStream({
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
      input.callbacks.broadcastSessionStream({
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
      input.callbacks.broadcastSessionStream({
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
      const finalOutput = sanitizeStewardOutput(finalResult.finalVisibleOutput).trim();
      const finalRun = await readRunRecordForResult(finalResult);
      const finalState = await refreshProjectRuntimeState({
        hivePaths: input.hivePaths,
        projectId: input.project,
        projectPaths,
      });
      lastKnownState = finalState;

      if (!finalOutput) {
        await input.callbacks.appendSessionTurnAndBroadcast({
          sessionId: input.sessionId,
          project: input.project,
          role: "assistant",
          content: "Background coordination finished without a visible reply.",
          source: "system",
          details: input.callbacks.buildSessionTurnDetails({
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
            routing: input.callbacks.buildSessionTurnRouting({
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

      await input.callbacks.appendSessionTurnAndBroadcast({
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: finalOutput,
        source: "model",
        details: input.callbacks.buildSessionTurnDetails({
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
          routing: input.callbacks.buildSessionTurnRouting({
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
      hivePaths: input.hivePaths,
      projectId: input.project,
      projectPaths,
    });
  }

  await input.callbacks.appendSessionTurnAndBroadcast({
    sessionId: input.sessionId,
    project: input.project,
    role: "assistant",
    content: "This is still in motion. I’ll keep the board moving, and the next background coordination result will land here when it’s ready.",
    source: "system",
    details: input.callbacks.buildSessionTurnDetails({
      project: input.project,
      state: lastKnownState,
      routing: input.callbacks.buildSessionTurnRouting({
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

export async function continueConsoleWorkflow(
  input: ContinueConsoleWorkflowInput,
): Promise<void> {
  // Gate: when the steward is woken by the supervisor (not by a human),
  // skip the turn entirely if there is nothing new to report.  This
  // prevents the chatty "Nothing new. Same batch." output every ~120s.
  if (input.origin === "system-wake") {
    const pendingNotifications = await readPendingRunNotifications(input.hivePaths.home, input.project);
    const sessionState = await getSessionState(
      input.hivePaths.sessionsDir,
      input.sessionId,
    );
    const projectSessionState = getProjectSessionState(sessionState, input.project);
    const projectPaths = getProjectPaths(input.hivePaths, input.project);
    const runtimeState = await refreshProjectRuntimeState({
      hivePaths: input.hivePaths,
      projectId: input.project,
      projectPaths,
    });
    const currentRevision = runtimeState.revision.revision;
    const lastSeenRevision = projectSessionState.lastRevisionSeen;
    const hasNewNotifications = pendingNotifications.length > 0;
    const hasStateChange = currentRevision > lastSeenRevision;

    if (!hasNewNotifications && !hasStateChange) {
      return;
    }

    // Gate passed — there's content to deliver.  Now persist the
    // synthetic [system] turn that the /api/steward/wake route
    // deferred so we don't pollute session history with empty wakes.
    await appendTurn({
      sessionsDir: input.hivePaths.sessionsDir,
      sessionId: input.sessionId,
      role: "human",
      content: input.message,
      source: "system",
    });
  }

  const globalConfig = await readGlobalConfig(input.hivePaths);
  const sessionMeta = await getSession(input.hivePaths.sessionsDir, input.sessionId);
  const sessionRuntime = sessionMeta?.runtime ?? "claude";
  const sessionModel = sessionMeta?.model ?? null;
  const persistentStewardEnabled = process.env.HIVE_ENABLE_PERSISTENT_STEWARD !== "0";
  const directResponse = await input.callbacks.resolveDirectConsoleResponse({
    project: input.project,
    message: input.message,
    globalConfig,
    sessionRuntime,
    sessionModel,
    persistentStewardEnabled,
  });

  if (directResponse) {
    await input.callbacks.appendSessionTurnAndBroadcast({
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: directResponse.content,
      source: directResponse.source,
      details: directResponse.details,
    });
    input.callbacks.schedulePendingSessionTurnDrain();
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
    supervisorLine = await input.callbacks.ensureSupervisorRunning(input.project);
    pushStatusNote(statusNotes, supervisorLine);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await input.callbacks.appendSessionTurnAndBroadcast({
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: `I couldn't prepare the runtime infrastructure: ${errorMessage}`,
    });
    clearPlaceholderTimer();
    return;
  }

  const projectPaths = getProjectPaths(input.hivePaths, input.project);
  await reconcileActiveConsoleRun(projectPaths);
  const existingConsoleRun = await readActiveRun(projectPaths, "console");

  if (existingConsoleRun) {
    clearPlaceholderTimer();
    if (input.origin === "queued-follow-up" || input.origin === "system-wake") {
      await enqueuePendingSessionTurn({
        sessionsDir: input.hivePaths.sessionsDir,
        sessionId: input.sessionId,
        projectId: input.project,
        content: input.message,
      });
      input.callbacks.schedulePendingSessionTurnDrain();
      return;
    }

    const queuedState = await enqueuePendingSessionTurn({
      sessionsDir: input.hivePaths.sessionsDir,
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

          return input.callbacks.buildCurrentActivitySummary({
            project: input.project,
            lead: buildInterruptedFollowUpLead(queuedCount),
          });
        })()
      : await (async () => {
          pushStatusNote(statusNotes, `Queued ${queuedCount} follow-up message(s) for the live steward.`);

          return input.callbacks.buildCurrentActivitySummary({
            project: input.project,
            lead: buildQueuedFollowUpLead(queuedCount),
          });
        })();

    await input.callbacks.appendSessionTurnAndBroadcast({
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: currentActivity.summary,
      source: "system",
      details: input.callbacks.buildSessionTurnDetails({
        project: input.project,
        state: currentActivity.state,
        runId: existingConsoleRun.runId,
        runtime: existingConsoleRun.runtime,
        model: existingConsoleRun.model,
        routing: input.callbacks.buildSessionTurnRouting({
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
    input.callbacks.schedulePendingSessionTurnDrain();
    return;
  }

  let streamedReply = "";

  if (persistentStewardEnabled) {
    if (isPersistentStewardTurnActive({
      hivePaths: input.hivePaths,
      sessionId: input.sessionId,
    })) {
      clearPlaceholderTimer();
      if (input.origin === "queued-follow-up" || input.origin === "system-wake") {
        await enqueuePendingSessionTurn({
          sessionsDir: input.hivePaths.sessionsDir,
          sessionId: input.sessionId,
          projectId: input.project,
          content: input.message,
        });
        input.callbacks.schedulePendingSessionTurnDrain();
        return;
      }

      const queuedState = await enqueuePendingSessionTurn({
        sessionsDir: input.hivePaths.sessionsDir,
        sessionId: input.sessionId,
        projectId: input.project,
        content: input.message,
      });
      const queuedCount = getPendingSessionTurns(queuedState, input.project).length;
      const aborted = await abortPersistentStewardTurn({
        hivePaths: input.hivePaths,
        sessionId: input.sessionId,
      });

      pushStatusNote(statusNotes, "Live persistent steward turn already active via Pi.");

      if (aborted) {
        pushStatusNote(statusNotes, "Requested abort for the live persistent steward turn.");
        pushStatusNote(statusNotes, `Queued ${queuedCount} follow-up message(s) behind the restart.`);
      } else {
        pushStatusNote(statusNotes, `Queued ${queuedCount} follow-up message(s) for the live steward.`);
      }

      const currentActivity = await input.callbacks.buildCurrentActivitySummary({
        project: input.project,
        lead: aborted
          ? buildInterruptedFollowUpLead(queuedCount)
          : buildQueuedFollowUpLead(queuedCount),
      });

      await input.callbacks.appendSessionTurnAndBroadcast({
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: currentActivity.summary,
        source: "system",
        details: input.callbacks.buildSessionTurnDetails({
          project: input.project,
          state: currentActivity.state,
          runtime: "pi",
          model: sessionModel,
          routing: input.callbacks.buildSessionTurnRouting({
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
      input.callbacks.schedulePendingSessionTurnDrain();
      return;
    }

    input.callbacks.broadcastSessionStream({
      sessionId: input.sessionId,
      project: input.project,
      content: "",
      statusText: "Starting steward session...",
      stage: "starting-session",
    });
    const persistent = await runPersistentStewardTurn({
      hivePaths: input.hivePaths,
      projectId: input.project,
      sessionId: input.sessionId,
      humanMessage: input.message,
      onStatus: (status) => {
        clearPlaceholderTimer();
        input.callbacks.broadcastSessionStream({
          sessionId: input.sessionId,
          project: input.project,
          content: "",
          statusText: status.label,
          stage: status.stage,
        });
      },
      onOutput: (chunk) => {
        const sanitized = sanitizeStewardOutput(chunk);
        if (!sanitized.trim()) {
          return;
        }

        clearPlaceholderTimer();
        streamedReply += sanitized;
        input.callbacks.broadcastSessionStream({
          sessionId: input.sessionId,
          project: input.project,
          content: sanitizeStewardOutput(streamedReply).trimEnd(),
        });
      },
    });

    if (persistent.mode === "persistent") {
      clearPlaceholderTimer();

      if (persistent.status === "cancelled") {
        pushStatusNote(statusNotes, "Persistent steward turn interrupted before it produced a final reply.");
        input.callbacks.schedulePendingSessionTurnDrain();
        return;
      }

      const persistentVisibleOutput = sanitizeStewardOutput(persistent.finalVisibleOutput).trim();
      if (persistentVisibleOutput) {
        pushStatusNote(statusNotes, "Persistent steward turn completed via Pi.");
        const finalState = await refreshProjectRuntimeState({
          hivePaths: input.hivePaths,
          projectId: input.project,
          projectPaths,
        });

        await input.callbacks.appendSessionTurnAndBroadcast({
          sessionId: input.sessionId,
          project: input.project,
          role: "assistant",
          content: persistentVisibleOutput,
          source: "model",
          details: input.callbacks.buildSessionTurnDetails({
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
            routing: input.callbacks.buildSessionTurnRouting({
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
          hivePaths: input.hivePaths,
          projectId: input.project,
          projectPaths,
        });
        await updateSessionProjectState({
          sessionsDir: input.hivePaths.sessionsDir,
          sessionId: input.sessionId,
          projectId: input.project,
          lastRevisionSeen: syncedState.revision.revision,
        });
        input.callbacks.schedulePendingSessionTurnDrain();
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
      hivePaths: input.hivePaths,
      projectId: input.project,
      sessionId: input.sessionId,
      humanMessage: input.message,
      onOutput: (chunk) => {
        const sanitized = sanitizeStewardOutput(chunk);
        if (!sanitized.trim()) {
          return;
        }

        clearPlaceholderTimer();
        streamedReply += sanitized;
        input.callbacks.broadcastSessionStream({
          sessionId: input.sessionId,
          project: input.project,
          content: sanitizeStewardOutput(streamedReply).trimEnd(),
        });
      },
    });

    if (direct.mode === "fallback") {
      clearPlaceholderTimer();
      pushStatusNote(statusNotes, `Direct steward unavailable: ${direct.reason}`);

      if (/console run already active/i.test(direct.reason)) {
        if (input.origin === "queued-follow-up" || input.origin === "system-wake") {
          await enqueuePendingSessionTurn({
            sessionsDir: input.hivePaths.sessionsDir,
            sessionId: input.sessionId,
            projectId: input.project,
            content: input.message,
          });
          input.callbacks.schedulePendingSessionTurnDrain();
          return;
        }

        const queuedState = await enqueuePendingSessionTurn({
          sessionsDir: input.hivePaths.sessionsDir,
          sessionId: input.sessionId,
          projectId: input.project,
          content: input.message,
        });
        const queuedCount = getPendingSessionTurns(queuedState, input.project).length;
        pushStatusNote(statusNotes, `Queued ${queuedCount} follow-up message(s) for the live steward.`);
        const currentActivity = await input.callbacks.buildCurrentActivitySummary({
          project: input.project,
          lead: buildQueuedFollowUpLead(queuedCount),
        });

        await input.callbacks.appendSessionTurnAndBroadcast({
          sessionId: input.sessionId,
          project: input.project,
          role: "assistant",
          content: currentActivity.summary,
          source: "system",
          details: input.callbacks.buildSessionTurnDetails({
            project: input.project,
            state: currentActivity.state,
            routing: input.callbacks.buildSessionTurnRouting({
              tier: "tier3",
              mode: null,
              handledBy: "live-direct-steward",
              globalConfig,
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
        input.callbacks.schedulePendingSessionTurnDrain();
        return;
      }

      input.callbacks.broadcastSessionStream({
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
      input.callbacks.schedulePendingSessionTurnDrain();
      return;
    }

    pushStatusNote(statusNotes, `Direct steward run completed: ${direct.finalRun.runId}.`);
    const finalState = await refreshProjectRuntimeState({
      hivePaths: input.hivePaths,
      projectId: input.project,
      projectPaths,
    });

    const directVisibleOutput = sanitizeStewardOutput(direct.finalVisibleOutput).trim();
    if (directVisibleOutput) {
      await input.callbacks.appendSessionTurnAndBroadcast({
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: directVisibleOutput,
        source: "model",
        details: input.callbacks.buildSessionTurnDetails({
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
          routing: input.callbacks.buildSessionTurnRouting({
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
      input.callbacks.schedulePendingSessionTurnDrain();
      return;
    }

    await input.callbacks.appendSessionTurnAndBroadcast({
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: "The direct turn finished without a visible reply.",
      source: "system",
      details: input.callbacks.buildSessionTurnDetails({
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
        routing: input.callbacks.buildSessionTurnRouting({
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
    input.callbacks.schedulePendingSessionTurnDrain();
  } catch (error) {
    clearPlaceholderTimer();
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    pushStatusNote(statusNotes, `Direct steward failed: ${errorMessage}`);
    input.callbacks.broadcastSessionStream({
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
