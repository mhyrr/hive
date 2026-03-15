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
import {
  findMessage,
  closeMessage,
  listOpenProjectMessages,
  HiveMessage,
  createMessageRaw,
} from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
  HivePaths,
  ProjectPaths,
} from "../lib/paths";
import { extractRepoPath } from "../lib/project";
import {
  finalizeRun,
  listActiveRuns,
  listAllRuns,
  listRecentRunResults,
  listRecentRuns,
  readRunRecord,
  RunRecord,
  writeRunResult,
} from "../lib/runs";
import {
  assessRecoveredRuns,
  assessStewardLaunch,
  countPriorAttempts,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_STEWARD_REASSESS_SECONDS,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
  extractVerificationSpec,
  RecoveredRun,
  runVerification,
  selectWorkerLaunches,
  VerificationOutcome,
} from "../lib/supervisor";
import { toIsoTimestamp } from "../lib/time";
import { refreshProjectRuntimeState } from "../lib/state";
import { launchAgentPass } from "./launch";

type SuperviseOptions = {
  intervalSeconds: number;
  maxParallel: number;
  once: boolean;
  detach: boolean;
  child: boolean;
  action: "run" | "status" | "stop" | "logs";
};

type ProjectState = {
  projectConfig: string;
  plan: string;
  boardText: string;
  openMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
  activeRuns: Awaited<ReturnType<typeof listActiveRuns>>;
  recentRuns: Awaited<ReturnType<typeof listRecentRuns>>;
  allRuns: Awaited<ReturnType<typeof listAllRuns>>;
  recentRunResults: Awaited<ReturnType<typeof listRecentRunResults>>;
};

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
      action: first,
    };
  }

  let intervalSeconds = DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
  let maxParallel = DEFAULT_MAX_PARALLEL;
  let once = false;
  let detach = false;
  let child = false;

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

    throw new UsageError(usage);
  }

  if (once && detach) {
    throw new UsageError("`hive supervise` cannot combine `--once` with `--detach`.");
  }

  if (child && (once || detach)) {
    throw new UsageError("Internal supervisor child mode cannot be combined with `--once` or `--detach`.");
  }

  return { intervalSeconds, maxParallel, once, detach, child, action: "run" };
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

function formatLaunchSettledResult(
  agentId: string,
  result: PromiseSettledResult<string>,
): string {
  if (result.status === "fulfilled") {
    return `- ${agentId}: ${result.value}`;
  }

  const message = result.reason instanceof Error ? result.reason.message : String(result.reason);

  return `- ${agentId}: failed to launch (${message})`;
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

    await writeRunResult(finalizedRun, {
      assignmentStatusAfterExit: assignmentAfterExit?.attributes.status ?? null,
      assignmentResolvedByWorker: assignmentAfterExit?.attributes.status === "resolved",
      changedFiles: [],
      gitSummaryLines: [entry.reason],
      finalVisibleOutput:
        entry.status === "cancelled"
          ? "Supervisor recovered a cancelled run after the process exited before the owning launcher finalized it."
          : "Supervisor recovered a stale active run whose process was no longer alive.",
    });
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

async function verifyCompletedWorker(input: {
  paths: HivePaths;
  projectPaths: ProjectPaths;
  activeProject: string;
  agentId: string;
  sourceMessage: HiveMessage;
  allRuns: RunRecord[];
}): Promise<{ outcome: VerificationOutcome; summary: string } | null> {
  const spec = extractVerificationSpec(input.sourceMessage);

  if (!spec) {
    return null;
  }

  const projectConfig = await Bun.file(input.projectPaths.config).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    return null;
  }

  const attempt = countPriorAttempts(input.sourceMessage.filename, input.allRuns);
  const outcome = runVerification({ spec, repoPath, attempt });

  if (outcome.action === "keep") {
    const summary = `verify PASS: ${spec.command} (attempt ${attempt}/${spec.maxAttempts})`;

    await appendLogEntry(
      input.projectPaths.log,
      "hive supervise verify",
      `${input.agentId}: ${summary}`,
    );
    await appendFeedEntry(input.paths, {
      project: input.activeProject,
      headline: `${input.agentId} verified`,
      details: [
        `command: ${spec.command}`,
        `result: PASS`,
        `attempt: ${attempt}/${spec.maxAttempts}`,
      ],
    });

    return { outcome, summary };
  }

  if (outcome.action === "retry") {
    const summary = `verify FAIL: ${spec.command} (attempt ${outcome.attempt}/${outcome.maxAttempts}, will retry)`;

    // Close the old assignment
    await closeMessage(
      input.paths.msgDir,
      input.sourceMessage.filename,
      "supervisor",
      `Verification failed (attempt ${outcome.attempt}/${outcome.maxAttempts}). Retrying.`,
      input.activeProject,
    );

    // Create a new assignment with failure context appended
    const retryBody = [
      input.sourceMessage.body,
      "",
      `## Verification Failure (attempt ${outcome.attempt}/${outcome.maxAttempts})`,
      `Command: ${spec.command}`,
      `Exit code: ${outcome.verifyResult.exitCode}`,
      "Output:",
      "```",
      outcome.verifyResult.output.slice(0, 1000),
      "```",
      "",
      "Fix the issue and try again. The previous changes have been reverted.",
    ].join("\n");

    // Preserve original assignment attributes (verify, max-attempts, auto-revert, task, launch, scope)
    const retryAttrs: Record<string, string> = {};
    const preserveKeys = ["from", "to", "type", "project", "task", "launch", "scope", "verify", "max-attempts", "auto-revert"];

    for (const key of preserveKeys) {
      const value = input.sourceMessage.attributes[key];

      if (value) {
        retryAttrs[key] = value;
      }
    }

    await createMessageRaw(input.paths.msgDir, retryAttrs, retryBody);

    await appendLogEntry(
      input.projectPaths.log,
      "hive supervise verify",
      `${input.agentId}: ${summary}\nReverted: ${outcome.revertSummary}`,
    );
    await appendFeedEntry(input.paths, {
      project: input.activeProject,
      headline: `${input.agentId} verify failed, retrying`,
      details: [
        `command: ${spec.command}`,
        `attempt: ${outcome.attempt}/${outcome.maxAttempts}`,
        `revert: ${outcome.revertSummary}`,
      ],
    });

    return { outcome, summary };
  }

  // action === "block"
  const summary = `verify FAIL: ${spec.command} (attempt ${outcome.attempt}/${outcome.maxAttempts}, exhausted)`;

  await closeMessage(
    input.paths.msgDir,
    input.sourceMessage.filename,
    "supervisor",
    `Verification failed after ${outcome.maxAttempts} attempt(s). Blocked for steward review.\nCommand: ${spec.command}\nExit: ${outcome.verifyResult.exitCode}`,
    input.activeProject,
  );

  await appendLogEntry(
    input.projectPaths.log,
    "hive supervise verify",
    `${input.agentId}: ${summary}\nReverted: ${outcome.revertSummary}`,
  );
  await appendFeedEntry(input.paths, {
    project: input.activeProject,
    headline: `${input.agentId} verify exhausted, blocked`,
    details: [
      `command: ${spec.command}`,
      `attempts: ${outcome.maxAttempts}`,
      `revert: ${outcome.revertSummary}`,
    ],
  });

  return { outcome, summary };
}

function formatVerificationResults(
  results: { agentId: string; summary: string }[],
): string {
  if (results.length === 0) {
    return "- none";
  }

  return results.map((r) => `- ${r.agentId}: ${r.summary}`).join("\n");
}

async function runSupervisorPass(options: SuperviseOptions): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  let state = await readProjectState({ activeProject, paths });
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
    state.activeRuns.find((run) => run.agentId === "orchestrator") ?? null;
  const assessment = assessStewardLaunch({
    boardText: state.boardText,
    openMessages: state.openMessages,
    activeRuns: state.activeRuns,
    recentRuns: state.recentRuns,
    recentRunResults: state.recentRunResults,
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
  ].join("\n\n");

  if (initialActiveOrchestratorRun) {
    stewardSection = [
      "Decision: skipped",
      section("Reasons", assessment.reasons.map((reason) => `- ${reason}`).join("\n") || "- none"),
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
      agentId: "orchestrator",
      goal: null,
      runtimeOverride: null,
      modelOverride: null,
      dryRun: false,
      source: "hive supervise",
      logActor: "hive supervise",
    });

    stewardSection = [
      "Decision: launched orchestrator",
      section("Reasons", assessment.reasons.map((reason) => `- ${reason}`).join("\n")),
      section("Launch", launchSummary),
    ].join("\n\n");

    state = await readProjectState({ activeProject, paths });
  }

  const dispatch = selectWorkerLaunches({
    projectConfig: state.projectConfig,
    plan: state.plan,
    openMessages: state.openMessages,
    activeRuns: state.activeRuns,
    historicalRuns: state.allRuns,
    maxParallel: options.maxParallel,
  });

  let workerSection = "No worker launches this pass.";
  const verificationResults: { agentId: string; summary: string }[] = [];

  if (dispatch.launches.length > 0) {
    const settled = await Promise.allSettled(
      dispatch.launches.map((launch) =>
        launchAgentPass({
          activeProject,
          paths,
          agentId: launch.agentId,
          goal: null,
          runtimeOverride: null,
          modelOverride: null,
          dryRun: false,
          source: "hive supervise",
          logActor: "hive supervise",
        }),
      ),
    );

    workerSection = settled
      .map((result, index) => formatLaunchSettledResult(dispatch.launches[index]!.agentId, result))
      .join("\n");

    // Post-launch verification: check completed workers for verify: specs
    state = await readProjectState({ activeProject, paths });

    for (const launch of dispatch.launches) {
      if (!launch.message.attributes.verify) {
        continue;
      }

      const result = await verifyCompletedWorker({
        paths,
        projectPaths,
        activeProject,
        agentId: launch.agentId,
        sourceMessage: launch.message,
        allRuns: state.allRuns,
      });

      if (result) {
        verificationResults.push({ agentId: launch.agentId, summary: result.summary });
      }
    }
  }

  const skippedSection =
    dispatch.skipped.length > 0
      ? dispatch.skipped.map((reason) => `- ${reason}`).join("\n")
      : "- none";

  const sections = [
    `Project: ${activeProject}`,
    section("Recovered Runs", formatRecoveredRuns(recoveredRuns)),
    section("Steward", stewardSection),
    section("Worker Launches", workerSection),
  ];

  if (verificationResults.length > 0) {
    sections.push(section("Verification", formatVerificationResults(verificationResults)));
  }

  sections.push(
    section("Skipped Assignments", skippedSection),
    section(
      "Supervisor",
      [
        `tick-interval: ${options.intervalSeconds}s`,
        `steward-reassess: ${DEFAULT_STEWARD_REASSESS_SECONDS}s`,
        `max-parallel: ${options.maxParallel}`,
      ].join("\n"),
    ),
  );

  return sections.join("\n\n");
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
      mode: "detached",
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
      try {
        const output = await runSupervisorPass(options);

        console.log(output);
        console.log("");
        await noteDetachedSupervisorPass(projectPaths);
        await Bun.sleep(options.intervalSeconds * 1000);
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
