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
} from "../lib/paths";

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

  const projectPaths = getProjectPaths(paths, activeProject);

  await enqueueGoalForOrchestrator(paths, projectPaths, activeProject, message);

  const existing = await reconcileDetachedSupervisorState(projectPaths);
  let supervisorNote: string;

  if (existing?.status === "active" && isProcessAlive(existing.pid)) {
    supervisorNote = `Supervisor active (pid ${existing.pid})`;
  } else {
    try {
      const state = await startDetachedSupervisor({
        projectPaths,
        projectId: activeProject,
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

  return [
    `Sent: ${message}`,
    supervisorNote,
  ].join("\n");
}
