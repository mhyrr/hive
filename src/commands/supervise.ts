import { appendFeedEntry } from "../lib/feed";
import { section } from "../lib/format";
import { UsageError } from "../lib/errors";
import { appendLogEntry } from "../lib/log";
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
  readRunRecord,
  RunRecord,
  writeRunResult,
} from "../lib/runs";
import {
  assessRecoveredRuns,
  assessStewardLaunch,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_STEWARD_REASSESS_SECONDS,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
  RecoveredRun,
  selectWorkerLaunches,
} from "../lib/supervisor";
import { launchAgentPass } from "./launch";

type SuperviseOptions = {
  intervalSeconds: number;
  maxParallel: number;
  once: boolean;
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
  let intervalSeconds = DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
  let maxParallel = DEFAULT_MAX_PARALLEL;
  let once = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--interval") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError(
          "Usage: hive supervise [--interval <seconds>] [--max-parallel <count>] [--once]",
        );
      }

      intervalSeconds = value;
      index += 1;
      continue;
    }

    if (arg === "--max-parallel") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError(
          "Usage: hive supervise [--interval <seconds>] [--max-parallel <count>] [--once]",
        );
      }

      maxParallel = value;
      index += 1;
      continue;
    }

    if (arg === "--once") {
      once = true;
      continue;
    }

    throw new UsageError(
      "Usage: hive supervise [--interval <seconds>] [--max-parallel <count>] [--once]",
    );
  }

  return { intervalSeconds, maxParallel, once };
}

async function readProjectState(input: {
  activeProject: string;
  paths: Awaited<ReturnType<typeof ensureHiveScaffold>>;
}): Promise<ProjectState> {
  const projectPaths = getProjectPaths(input.paths, input.activeProject);

  return {
    projectConfig: await Bun.file(projectPaths.config).text(),
    plan: await Bun.file(projectPaths.plan).text(),
    boardText: await Bun.file(projectPaths.board).text(),
    openMessages: await listOpenProjectMessages(input.paths.msgDir, input.activeProject),
    activeRuns: await listActiveRuns(projectPaths),
    recentRuns: await listRecentRuns(projectPaths, 10),
    allRuns: await listAllRuns(projectPaths),
    recentRunResults: await listRecentRunResults(projectPaths, 10),
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
  }

  const skippedSection =
    dispatch.skipped.length > 0
      ? dispatch.skipped.map((reason) => `- ${reason}`).join("\n")
      : "- none";

  return [
    `Project: ${activeProject}`,
    section("Recovered Runs", formatRecoveredRuns(recoveredRuns)),
    section("Steward", stewardSection),
    section("Worker Launches", workerSection),
    section("Skipped Assignments", skippedSection),
    section(
      "Supervisor",
      [
        `tick-interval: ${options.intervalSeconds}s`,
        `steward-reassess: ${DEFAULT_STEWARD_REASSESS_SECONDS}s`,
        `max-parallel: ${options.maxParallel}`,
      ].join("\n"),
    ),
  ].join("\n\n");
}

export async function superviseCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);

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
