import { join } from "node:path";

import {
  formatDetachedSupervisorState,
  markDetachedSupervisorStopRequested,
  markDetachedSupervisorStopped,
  noteDetachedSupervisorPass,
  readDetachedSupervisorState,
  reconcileDetachedSupervisorState,
  startDetachedSupervisor,
  writeDetachedSupervisorState,
} from "../lib/detached-supervisor";
import { appendFeedEntry } from "../lib/feed";
import { UsageError } from "../lib/errors";
import { section } from "../lib/format";
import { appendLogEntry } from "../lib/log";
import { readGatewayState } from "../lib/gateway-state";
import { findMessage, listOpenProjectMessages } from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import {
  finalizeRun,
  listActiveRuns,
  listAllRuns,
  listRecentRunResults,
  listRecentRuns,
  markRunStopRequested,
  readRunRecord,
  RunRecord,
  RunResult,
  writeRunResult,
} from "../lib/runs";
import {
  assessPulse,
  assessRecoveredRuns,
  assessStewardLaunch,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_PULSE_INTERVAL_TICKS,
  DEFAULT_STEWARD_REASSESS_SECONDS,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
  formatPulse,
  isProcessAlive,
  RecoveredRun,
} from "../lib/supervisor";
import { toIsoTimestamp } from "../lib/time";
import { refreshProjectRuntimeState, type ProjectRuntimeState } from "../lib/state";
import { compileIdleProjectCognition, triageRunDiffsForSteward } from "../lib/cognition";
import { hasPersistentStewardSession, notifyStewardRunCompleted } from "../lib/persistent-steward";
import { launchAgentPass } from "./launch";
import { dispatchWorkerLaunchPass } from "./worker-launch-dispatch";

type SuperviseOptions = {
  intervalSeconds: number;
  maxParallel: number;
  once: boolean;
  detach: boolean;
  child: boolean;
  managed: boolean;
  parentPid: number | null;
  action: "run" | "status" | "stop" | "logs";
};

type ProjectState = {
  runtimeState: ProjectRuntimeState;
  projectConfig: string;
  plan: string;
  boardText: string;
  openMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
  activeRuns: Awaited<ReturnType<typeof listActiveRuns>>;
  recentRuns: Awaited<ReturnType<typeof listRecentRuns>>;
  allRuns: Awaited<ReturnType<typeof listAllRuns>>;
  recentRunResults: Awaited<ReturnType<typeof listRecentRunResults>>;
};

type StewardDiffTriageEntry = {
  runId: string;
  agentId: string;
  stewardWorthy: boolean;
  reason: string;
  handledBy: "deterministic" | "tier1";
  provider: string;
  model: string;
};

type PersistentStewardWakeState = {
  fingerprint: string;
  requestedAt: string;
  runIds: string[];
  sessionId: string | null;
};

type PersistentStewardWakeDispatch =
  | {
      status: "triggered";
      detail: string;
      sessionId: string | null;
    }
  | {
      status: "failed";
      detail: string;
    };

function persistentStewardWakeStatePath(
  projectPaths: ReturnType<typeof getProjectPaths>,
): string {
  return join(projectPaths.supervisorDir, "persistent-steward-wake.json");
}

async function readPersistentStewardWakeState(
  projectPaths: ReturnType<typeof getProjectPaths>,
): Promise<PersistentStewardWakeState | null> {
  const file = Bun.file(persistentStewardWakeStatePath(projectPaths));

  if (!(await file.exists())) {
    return null;
  }

  try {
    const parsed = JSON.parse(await file.text()) as Partial<PersistentStewardWakeState>;

    if (
      typeof parsed.fingerprint !== "string" ||
      typeof parsed.requestedAt !== "string" ||
      !Array.isArray(parsed.runIds)
    ) {
      return null;
    }

    return {
      fingerprint: parsed.fingerprint,
      requestedAt: parsed.requestedAt,
      runIds: parsed.runIds.filter((value): value is string => typeof value === "string"),
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
    };
  } catch {
    return null;
  }
}

async function writePersistentStewardWakeState(
  projectPaths: ReturnType<typeof getProjectPaths>,
  state: PersistentStewardWakeState,
): Promise<void> {
  await Bun.write(
    persistentStewardWakeStatePath(projectPaths),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function formatNaturalList(items: string[]): string {
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

function buildPersistentStewardWakeFingerprint(results: RunResult[]): string {
  return [...new Set(results.map((result) => result.runId))].sort().join("|");
}

function buildPersistentStewardWakeMessage(input: {
  results: RunResult[];
  triageEntriesByRunId: Map<string, StewardDiffTriageEntry>;
}): string {
  const agentIds = [...new Set(input.results.map((result) => result.agentId))].sort();
  const lines = [
    agentIds.length === 1
      ? `Your delegated worker ${agentIds[0]} has completed.`
      : `Your delegated workers ${formatNaturalList(agentIds)} have completed.`,
    "",
    "Review the new worker run results that landed since your last steward pass, synthesize their findings, and report the answer to the human.",
    "",
    "Completed worker results:",
  ];

  const sortedResults = [...input.results].sort((left, right) => left.ended.localeCompare(right.ended));

  for (const result of sortedResults) {
    const triage = input.triageEntriesByRunId.get(result.runId);
    const details = [
      `${result.agentId} | run ${result.runId}`,
      `ended ${result.ended}`,
      triage ? `triage: ${triage.reason}` : null,
      result.assignmentMessage ? `assignment: ${result.assignmentMessage}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    lines.push(`- ${details}`);
  }

  return lines.join("\n");
}

function resolveGatewayBaseUrl(input: {
  url: string;
  port: number | null;
}): string | null {
  const trimmedUrl = input.url.trim();

  if (trimmedUrl) {
    return trimmedUrl.replace(/\/+$/, "");
  }

  if (input.port !== null) {
    return `http://localhost:${input.port}`;
  }

  return null;
}

async function requestPersistentStewardWake(input: {
  paths: Awaited<ReturnType<typeof ensureHiveScaffold>>;
  projectId: string;
  message: string;
}): Promise<PersistentStewardWakeDispatch> {
  const gatewayState = await readGatewayState(input.paths.home);

  if (!gatewayState || gatewayState.status !== "active") {
    return {
      status: "failed",
      detail: "gateway is not active",
    };
  }

  const baseUrl = resolveGatewayBaseUrl({
    url: gatewayState.url,
    port: gatewayState.port,
  });

  if (!baseUrl) {
    return {
      status: "failed",
      detail: "gateway URL is unavailable",
    };
  }

  let response: Response;

  try {
    response = await fetch(`${baseUrl}/api/steward/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: input.projectId,
        message: input.message,
      }),
    });
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let payload: Record<string, unknown> | null = null;

  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      status: "failed",
      detail:
        typeof payload?.error === "string"
          ? payload.error
          : `gateway wake failed (${response.status})`,
    };
  }

  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : null;

  return {
    status: "triggered",
    detail: sessionId
      ? `wake requested via gateway session ${sessionId}`
      : "wake requested via gateway",
    sessionId,
  };
}

function parseOptions(args: string[]): SuperviseOptions {
  const usage =
    "Usage: hive supervise [--interval <seconds>] [--max-parallel <count>] [--once|--detach]\n       hive supervise status\n       hive supervise stop\n       hive supervise logs";
  const first = args[0]?.trim().toLowerCase();

  if (first === "status" || first === "stop" || first === "logs") {
    if (args.length !== 1) {
      throw new UsageError(usage);
    }

    return {
      intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
      maxParallel: DEFAULT_MAX_PARALLEL,
      once: false,
      detach: false,
      child: false,
      managed: false,
      parentPid: null,
      action: first,
    };
  }

  let intervalSeconds = DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
  let maxParallel = DEFAULT_MAX_PARALLEL;
  let once = false;
  let detach = false;
  let child = false;
  let managed = false;
  let parentPid: number | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--interval") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError(usage);
      }

      intervalSeconds = value;
      index += 1;
      continue;
    }

    if (arg === "--max-parallel") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError(usage);
      }

      maxParallel = value;
      index += 1;
      continue;
    }

    if (arg === "--once") {
      once = true;
      continue;
    }

    if (arg === "--detach") {
      detach = true;
      continue;
    }

    if (arg === "--supervisor-child") {
      child = true;
      continue;
    }

    if (arg === "--managed") {
      managed = true;
      continue;
    }

    if (arg === "--parent-pid") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError(usage);
      }

      parentPid = value;
      index += 1;
      continue;
    }

    throw new UsageError(usage);
  }

  if (once && detach) {
    throw new UsageError("`hive supervise` cannot combine `--once` with `--detach`.");
  }

  if (child && (once || detach)) {
    throw new UsageError("Internal supervisor child mode cannot be combined with `--once` or `--detach`.");
  }

  if (!child && (managed || parentPid !== null)) {
    throw new UsageError("Supervisor parent flags are only valid in child mode.");
  }

  return { intervalSeconds, maxParallel, once, detach, child, managed, parentPid, action: "run" };
}

async function readProjectState(input: {
  activeProject: string;
  paths: Awaited<ReturnType<typeof ensureHiveScaffold>>;
}): Promise<ProjectState> {
  const projectPaths = getProjectPaths(input.paths, input.activeProject);
  const runtimeState = await refreshProjectRuntimeState({
    hivePaths: input.paths,
    projectId: input.activeProject,
    projectPaths,
  });

  return {
    runtimeState,
    projectConfig: await Bun.file(projectPaths.config).text(),
    plan: await Bun.file(projectPaths.plan).text(),
    boardText: runtimeState.boardText,
    openMessages: runtimeState.openMessages,
    activeRuns: runtimeState.activeRuns,
    recentRuns: await listRecentRuns(projectPaths, 10),
    allRuns: await listAllRuns(projectPaths),
    recentRunResults: runtimeState.recentResults,
  };
}

function endedAfter(value: string, reference: string | null): boolean {
  if (!reference) {
    return true;
  }

  return new Date(value).getTime() > new Date(reference).getTime();
}

function formatStewardDiffTriage(entries: StewardDiffTriageEntry[]): string {
  if (entries.length === 0) {
    return "- none";
  }

  return entries
    .map((entry) =>
      [
        `- ${entry.agentId} | ${entry.stewardWorthy ? "wake" : "routine"} | ${entry.reason}`,
        `  via: ${entry.handledBy}${entry.handledBy === "tier1" ? ` (${entry.provider} ${entry.model})` : ""}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function formatLaunchSettledResult(input: {
  agentId: string;
  messageFilename?: string | null;
  result: PromiseSettledResult<string>;
}): string {
  if (input.result.status === "fulfilled") {
    return `- ${input.agentId}: ${input.result.value}`;
  }

  const message =
    input.result.reason instanceof Error
      ? input.result.reason.message
      : String(input.result.reason);

  if (input.messageFilename) {
    return `- ${input.agentId}: failed to launch (${message}) [${input.messageFilename}]`;
  }

  return `- ${input.agentId}: failed to launch (${message})`;
}

function formatRecoveredRuns(recovered: RecoveredRun[]): string {
  if (recovered.length === 0) {
    return "- none";
  }

  return recovered
    .map(
      (entry) =>
        `- ${entry.run.agentId} | ${entry.status} | ${entry.run.runId}\n  ${entry.reason}`,
    )
    .join("\n\n");
}

function formatIdleCompileSection(input: {
  status: "skipped" | "compiled";
  reason?: string;
  updatedCount?: number;
  packetKinds?: string[];
}): string {
  if (input.status === "skipped") {
    return [
      "Decision: skipped",
      `Reason: ${input.reason ?? "project is not idle enough"}`,
    ].join("\n");
  }

  return [
    "Decision: compiled",
    `Updated packets: ${input.updatedCount ?? 0}`,
    `Kinds: ${input.packetKinds?.join(", ") || "(none)"}`,
  ].join("\n");
}

async function reconcileRecoveredRuns(input: {
  paths: Awaited<ReturnType<typeof ensureHiveScaffold>>;
  activeProject: string;
  projectPaths: ReturnType<typeof getProjectPaths>;
  recovered: RecoveredRun[];
}): Promise<void> {
  for (const entry of input.recovered) {
    const persistedRun = (await readRunRecord(entry.run.path)) ?? entry.run;
    const finalizedRun = await finalizeRun({
      projectPaths: input.projectPaths,
      run: persistedRun,
      status: entry.status,
      exitCode: persistedRun.exitCode,
    });
    const assignmentAfterExit = finalizedRun.sourceMessage
      ? await findMessage(input.paths.msgDir, finalizedRun.sourceMessage, input.activeProject)
      : null;

    const runResult = await writeRunResult(finalizedRun, {
      assignmentStatusAfterExit: assignmentAfterExit?.attributes.status ?? null,
      assignmentResolvedByWorker: assignmentAfterExit?.attributes.status === "resolved",
      changedFiles: [],
      gitSummaryLines: [entry.reason],
      finalVisibleOutput:
        entry.status === "cancelled"
          ? "Supervisor recovered a cancelled run after the process exited before the owning launcher finalized it."
          : "Supervisor recovered a stale active run whose process was no longer alive.",
    });
    await notifyStewardRunCompleted(input.paths.home, input.activeProject, runResult);
    await appendFeedEntry(input.paths, {
      project: input.activeProject,
      headline: `Recovered ${finalizedRun.agentId} ${entry.status}`,
      details: [`run: ${finalizedRun.runId}`, entry.reason],
    });
    await appendLogEntry(
      input.projectPaths.log,
      "hive supervise",
      `Recovered ${finalizedRun.agentId} ${entry.status}: ${entry.reason}`,
    );
  }
}

let supervisorTickCount = 0;

async function terminateSupervisorOwnedRuns(projectPaths: ReturnType<typeof getProjectPaths>): Promise<void> {
  const activeRuns = await listActiveRuns(projectPaths);

  for (const run of activeRuns) {
    if (!run.pid || run.source === "console" || run.pid === process.pid) {
      continue;
    }

    try {
      await markRunStopRequested(run, "supervisor");
      process.kill(run.pid, "SIGTERM");
    } catch {
      // process already gone
    }
  }
}

async function runSupervisorPass(options: SuperviseOptions): Promise<string> {
  supervisorTickCount++;
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  let state = await readProjectState({ activeProject, paths });
  const globalConfig = await Bun.file(paths.config).text().catch(() => "");
  const recoveredRuns = assessRecoveredRuns(state.activeRuns);

  if (recoveredRuns.length > 0) {
    await reconcileRecoveredRuns({
      paths,
      activeProject,
      projectPaths,
      recovered: recoveredRuns,
    });
    state = await readProjectState({ activeProject, paths });
  }

  const initialActiveOrchestratorRun =
    state.activeRuns.find((run) => run.agentId === "steward") ?? null;
  const lastStewardRun =
    state.recentRuns.find((run) => run.agentId === "steward" && Boolean(run.ended)) ?? null;
  const resultsSinceLastSteward = state.recentRunResults.filter(
    (result) => result.agentId !== "steward" && endedAfter(result.ended, lastStewardRun?.ended ?? null),
  );
  const diffTriageEntries: StewardDiffTriageEntry[] = [];
  const triagedRunResults: typeof state.recentRunResults = [];
  const triageInputs = resultsSinceLastSteward.map((result) => ({
    globalConfig,
    result,
  }));
  const triageDecisions = triageInputs.length > 0
    ? await triageRunDiffsForSteward(triageInputs)
    : [];
  const triageDecisionByRunId = new Map(
    triageInputs.map((input, index) => [input.result.runId, triageDecisions[index]!]),
  );

  for (const result of state.recentRunResults) {
    const decision = triageDecisionByRunId.get(result.runId);

    if (!decision) {
      triagedRunResults.push(result);
      continue;
    }

    diffTriageEntries.push({
      runId: result.runId,
      agentId: result.agentId,
      stewardWorthy: decision.stewardWorthy,
      reason: decision.reason,
      handledBy: decision.handledBy,
      provider: decision.provider,
      model: decision.model,
    });

    if (decision.stewardWorthy) {
      triagedRunResults.push(result);
    }
  }

  const diffTriageEntryByRunId = new Map(
    diffTriageEntries.map((entry) => [entry.runId, entry]),
  );
  const persistentWakeCandidates = resultsSinceLastSteward.filter((result) =>
    diffTriageEntryByRunId.get(result.runId)?.stewardWorthy,
  );

  const assessment = assessStewardLaunch({
    boardText: state.boardText,
    openMessages: state.openMessages,
    activeRuns: state.activeRuns,
    recentRuns: state.recentRuns,
    recentRunResults: triagedRunResults,
    reassessSeconds: DEFAULT_STEWARD_REASSESS_SECONDS,
  });

  let stewardSection = [
    `Decision: ${assessment.shouldLaunch ? "launch requested" : "no action"}`,
    section(
      "Reasons",
      assessment.reasons.length > 0
        ? assessment.reasons.map((reason) => `- ${reason}`).join("\n")
        : "- none",
    ),
    section("Diff Triage", formatStewardDiffTriage(diffTriageEntries)),
  ].join("\n\n");

  const persistentStewardActive = hasPersistentStewardSession(paths.home);
  let persistentWakeReason: string | null = null;

  if (persistentStewardActive) {
    if (persistentWakeCandidates.length > 0) {
      const fingerprint = buildPersistentStewardWakeFingerprint(persistentWakeCandidates);
      const previousWake = await readPersistentStewardWakeState(projectPaths);

      if (previousWake?.fingerprint === fingerprint) {
        persistentWakeReason = `Wake already requested for ${persistentWakeCandidates.length} steward-worthy worker result(s).`;
      } else {
        const wakeDispatch = await requestPersistentStewardWake({
          paths,
          projectId: activeProject,
          message: buildPersistentStewardWakeMessage({
            results: persistentWakeCandidates,
            triageEntriesByRunId: diffTriageEntryByRunId,
          }),
        });

        if (wakeDispatch.status === "triggered") {
          await writePersistentStewardWakeState(projectPaths, {
            fingerprint,
            requestedAt: toIsoTimestamp(),
            runIds: persistentWakeCandidates.map((result) => result.runId),
            sessionId: wakeDispatch.sessionId,
          });
          persistentWakeReason = wakeDispatch.sessionId
            ? `Wake requested immediately for ${persistentWakeCandidates.length} steward-worthy worker result(s) via gateway session ${wakeDispatch.sessionId}.`
            : `Wake requested immediately for ${persistentWakeCandidates.length} steward-worthy worker result(s) via the gateway.`;
        } else {
          persistentWakeReason = `Wake request failed: ${wakeDispatch.detail}`;
        }
      }
    } else {
      persistentWakeReason = "No steward-worthy worker completions required an automatic persistent wake this pass.";
    }

    stewardSection = [
      "Decision: deferred to persistent steward",
      section(
        "Reasons",
        [
          "A persistent steward session is active in the gateway.",
          "The persistent steward is the singleton coordinator — the supervisor does not launch a competing process.",
          ...(persistentWakeReason ? [persistentWakeReason] : []),
          ...assessment.reasons.map((reason) => `- ${reason}`),
        ].join("\n"),
      ),
      section("Diff Triage", formatStewardDiffTriage(diffTriageEntries)),
    ].join("\n\n");
  } else if (initialActiveOrchestratorRun) {
    stewardSection = [
      "Decision: skipped",
      section("Reasons", assessment.reasons.map((reason) => `- ${reason}`).join("\n") || "- none"),
      section("Diff Triage", formatStewardDiffTriage(diffTriageEntries)),
      section(
        "Active Orchestrator Run",
        [
          `run: ${initialActiveOrchestratorRun.runId}`,
          `started: ${initialActiveOrchestratorRun.started}`,
          `pid: ${initialActiveOrchestratorRun.pid ?? "unknown"}`,
        ].join("\n"),
      ),
    ].join("\n\n");
  } else if (assessment.shouldLaunch) {
    const launchSummary = await launchAgentPass({
      activeProject,
      paths,
      agentId: "steward",
      goal: null,
      runtimeOverride: null,
      modelOverride: null,
      dryRun: false,
      source: "hive supervise",
      logActor: "hive supervise",
    });

    stewardSection = [
      "Decision: launched steward",
      section("Reasons", assessment.reasons.map((reason) => `- ${reason}`).join("\n")),
      section("Diff Triage", formatStewardDiffTriage(diffTriageEntries)),
      section("Launch", launchSummary),
    ].join("\n\n");

    state = await readProjectState({ activeProject, paths });
  }

  let workerSection = "No worker launches this pass.";
  const workerDispatch = await dispatchWorkerLaunchPass({
    hivePaths: paths,
    projectId: activeProject,
    maxParallel: options.maxParallel,
    source: "hive supervise",
    actor: "hive supervise",
    logActor: "hive supervise",
  });

  if (workerDispatch.outcomes.length > 0) {
    workerSection = workerDispatch.outcomes
      .map((outcome) => formatLaunchSettledResult(outcome))
      .join("\n");
  } else if (workerDispatch.status === "busy") {
    workerSection = "Worker launch dispatch already in progress.";
  }

  const skippedSection =
    workerDispatch.skipped.length > 0
      ? workerDispatch.skipped.map((reason) => `- ${reason}`).join("\n")
      : "- none";
  const nonConsoleActiveRuns = state.activeRuns.filter((run) => run.agentId !== "console");
  let idleCompileSection = formatIdleCompileSection({
    status: "skipped",
    reason: "project is not idle enough",
  });

  const stewardLaunchedThisPass = !persistentStewardActive && !initialActiveOrchestratorRun && assessment.shouldLaunch;

  if (
    recoveredRuns.length === 0 &&
    !stewardLaunchedThisPass &&
    workerDispatch.outcomes.length === 0 &&
    nonConsoleActiveRuns.length === 0
  ) {
    const idleResult = await compileIdleProjectCognition({
      hivePaths: paths,
      projectId: activeProject,
      projectPaths,
      plan: state.plan,
      runtimeState: state.runtimeState,
    });

    idleCompileSection = formatIdleCompileSection({
      status: "compiled",
      updatedCount: idleResult.updatedCount,
      packetKinds: idleResult.packets.map((packet) => packet.kind),
    });
  } else {
    const reasons: string[] = [];

    if (recoveredRuns.length > 0) {
      reasons.push("recovered runs still needed reconciliation");
    }

    if (stewardLaunchedThisPass) {
      reasons.push("steward launch took precedence");
    }

    if (workerDispatch.outcomes.length > 0) {
      reasons.push("worker launches took precedence");
    }

    if (workerDispatch.status === "busy") {
      reasons.push("worker launch dispatch was already in progress");
    }

    if (nonConsoleActiveRuns.length > 0) {
      reasons.push("runs are still active");
    }

    idleCompileSection = formatIdleCompileSection({
      status: "skipped",
      reason: reasons.join("; "),
    });
  }

  const isPulseTick = supervisorTickCount % DEFAULT_PULSE_INTERVAL_TICKS === 0;
  let pulseSection = "";

  if (isPulseTick) {
    const pulseSignals = assessPulse({
      activeRuns: state.activeRuns,
      openMessages: state.openMessages,
      boardText: state.boardText,
    });
    const workerRuns = state.activeRuns.filter(
      (r) => r.agentId !== "steward" && r.source !== "console",
    );
    const pulseText = formatPulse(pulseSignals, workerRuns.length);

    pulseSection = section("Health Pulse", pulseText);

    if (pulseSignals.length > 0) {
      await appendFeedEntry(paths, {
        project: activeProject,
        headline: pulseText.split("\n")[0]!,
        details: pulseSignals.map((s) => s.message),
      });
    }
  }

  return [
    `Project: ${activeProject}`,
    section("Recovered Runs", formatRecoveredRuns(recoveredRuns)),
    section("Steward", stewardSection),
    section("Worker Launches", workerSection),
    section("Skipped Assignments", skippedSection),
    section("Idle Compilation", idleCompileSection),
    ...(pulseSection ? [pulseSection] : []),
    section(
      "Supervisor",
      [
        `tick-interval: ${options.intervalSeconds}s`,
        `steward-reassess: ${DEFAULT_STEWARD_REASSESS_SECONDS}s`,
        `max-parallel: ${options.maxParallel}`,
        `tick: ${supervisorTickCount}${isPulseTick ? " (pulse)" : ""}`,
      ].join("\n"),
    ),
  ].join("\n\n");
}

export async function superviseCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  if (options.action === "logs") {
    const state = await readDetachedSupervisorState(projectPaths);

    if (!state?.logPath) {
      throw new UsageError("No detached supervisor log found.");
    }

    const file = Bun.file(state.logPath);

    if (!(await file.exists())) {
      return `Supervisor log: ${state.logPath}\n\n(empty)`;
    }

    const content = await file.text();
    const lines = content.split("\n");
    const tail = lines.slice(-50).join("\n");

    return `Supervisor log: ${state.logPath}\n\n${tail}`;
  }

  if (options.action === "status") {
    const state = await reconcileDetachedSupervisorState(projectPaths);
    return formatDetachedSupervisorState(state, activeProject);
  }

  if (options.action === "stop") {
    const state = await markDetachedSupervisorStopRequested(projectPaths, "human");

    if (!state || !state.pid) {
      throw new UsageError("No detached supervisor is currently active.");
    }

    process.kill(state.pid, "SIGTERM");
    await appendFeedEntry(paths, {
      project: activeProject,
      headline: "Detached supervisor stop requested",
      details: [`pid: ${state.pid}`, `state: ${state.path}`],
    });
    await appendLogEntry(
      projectPaths.log,
      "human → hive supervise stop",
      `Requested detached supervisor stop pid ${state.pid}`,
    );

    return `Signaled detached supervisor pid ${state.pid}`;
  }

  if (options.detach) {
    const state = await startDetachedSupervisor({
      projectPaths,
      projectId: activeProject,
      intervalSeconds: options.intervalSeconds,
      maxParallel: options.maxParallel,
    });

    await appendFeedEntry(paths, {
      project: activeProject,
      headline: "Detached supervisor started",
      details: [`pid: ${state.pid ?? "unknown"}`, `interval: ${state.intervalSeconds}s`],
    });
    await appendLogEntry(
      projectPaths.log,
      "human → hive supervise --detach",
      `Started detached supervisor pid ${state.pid ?? "unknown"} interval ${state.intervalSeconds}s max-parallel ${state.maxParallel}`,
    );

    return [
      `Started detached supervisor for ${activeProject}`,
      `pid: ${state.pid ?? "unknown"}`,
      `interval: ${state.intervalSeconds}s`,
      `max-parallel: ${state.maxParallel}`,
      `state: ${state.path}`,
      `log: ${state.logPath}`,
    ].join("\n");
  }

  if (options.child) {
    const existingState = await reconcileDetachedSupervisorState(projectPaths);
    const startedAt = existingState?.startedAt ?? toIsoTimestamp();

    await writeDetachedSupervisorState(projectPaths, {
      projectId: activeProject,
      pid: process.pid,
      status: "active",
      mode: options.managed ? "managed" : "detached",
      intervalSeconds: options.intervalSeconds,
      maxParallel: options.maxParallel,
      startedAt,
      updatedAt: toIsoTimestamp(),
      lastPassAt: existingState?.lastPassAt ?? null,
      stoppedAt: null,
      stopRequestedAt: null,
      stopRequestedBy: null,
      logPath: join(projectPaths.supervisorDir, "detached.log"),
    });

    const stopChild = async (status: "stopped" | "exited") => {
      await terminateSupervisorOwnedRuns(projectPaths);
      await markDetachedSupervisorStopped(projectPaths, status);
      process.exit(status === "stopped" ? 0 : 1);
    };

    process.on("SIGTERM", () => {
      void stopChild("stopped");
    });
    process.on("SIGINT", () => {
      void stopChild("stopped");
    });
    process.on("uncaughtException", (error) => {
      console.error(error);
      void stopChild("exited");
    });

    for (;;) {
      if (options.parentPid && !isProcessAlive(options.parentPid)) {
        await stopChild("stopped");
      }

      try {
        const output = await runSupervisorPass(options);

        console.log(output);
        console.log("");
        await noteDetachedSupervisorPass(projectPaths);

        const sleepUntil = Date.now() + options.intervalSeconds * 1000;
        while (Date.now() < sleepUntil) {
          if (options.parentPid && !isProcessAlive(options.parentPid)) {
            await stopChild("stopped");
          }

          await Bun.sleep(250);
        }
      } catch (error) {
        console.error(error);
        await stopChild("exited");
      }
    }
  }

  if (options.once) {
    return runSupervisorPass(options);
  }

  for (;;) {
    const output = await runSupervisorPass(options);

    console.log(output);
    console.log("");
    await Bun.sleep(options.intervalSeconds * 1000);
  }
}
