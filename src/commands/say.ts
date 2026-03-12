import { UsageError } from "../lib/errors";
import {
  reconcileDetachedSupervisorState,
  startDetachedSupervisor,
} from "../lib/detached-supervisor";
import { appendLogEntry } from "../lib/log";
import { enqueueGoalForOrchestrator } from "../lib/orchestrator";
import { isProcessAlive, DEFAULT_MAX_PARALLEL, DEFAULT_SUPERVISOR_INTERVAL_SECONDS } from "../lib/supervisor";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
  type HivePaths,
} from "../lib/paths";
import { refreshProjectRuntimeState } from "../lib/state";

export async function sendGoalToProject(input: {
  projectId: string;
  message: string;
  paths?: HivePaths;
}): Promise<string> {
  const message = input.message.trim();

  if (!message) {
    throw new UsageError('Usage: hive say <message>\nExample: hive say "build the auth system"');
  }

  const paths = input.paths ?? await ensureHiveScaffold();
  const projectPaths = getProjectPaths(paths, input.projectId);

  await enqueueGoalForOrchestrator(paths, projectPaths, input.projectId, message);

  const existing = await reconcileDetachedSupervisorState(projectPaths);
  let supervisorNote: string;

  if (existing?.status === "active" && isProcessAlive(existing.pid)) {
    supervisorNote = `Supervisor active (pid ${existing.pid})`;
  } else {
    try {
      const state = await startDetachedSupervisor({
        projectPaths,
        projectId: input.projectId,
        intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
        maxParallel: DEFAULT_MAX_PARALLEL,
      });

      supervisorNote = `Supervisor started (pid ${state.pid ?? "unknown"})`;
      await appendLogEntry(
        projectPaths.log,
        "human -> hive say",
        `Auto-started supervision pid ${state.pid ?? "unknown"}`,
      );
    } catch {
      supervisorNote = "Supervisor not started (start manually with `hive run`)";
    }
  }

  await refreshProjectRuntimeState({
    hivePaths: paths,
    projectId: input.projectId,
    projectPaths,
  });

  return [
    `Sent: ${message}`,
    supervisorNote,
  ].join("\n");
}

export async function sayCommand(args: string[]): Promise<string> {
  const message = args.join(" ").trim();

  if (!message) {
    throw new UsageError('Usage: hive say <message>\nExample: hive say "build the auth system"');
  }

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  return sendGoalToProject({
    projectId: activeProject,
    message,
    paths,
  });
}
