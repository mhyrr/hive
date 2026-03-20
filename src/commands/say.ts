import { UsageError } from "../lib/errors";
import { appendLogEntry } from "../lib/log";
import { enqueueGoalForOrchestrator } from "../lib/orchestrator";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
  type HivePaths,
} from "../lib/paths";
import { refreshProjectRuntimeState } from "../lib/state";
import { ensureGatewayRunning } from "./gateway";

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

  let supervisorNote: string;

  try {
    const state = await ensureGatewayRunning();

    supervisorNote = `Gateway active (gateway pid ${state.pid ?? "unknown"}, supervisor pid ${state.supervisorPid ?? "unknown"})`;
    await appendLogEntry(
      projectPaths.log,
      "human -> hive say",
      `Ensured managed gateway pid ${state.pid ?? "unknown"} supervisor ${state.supervisorPid ?? "unknown"}`,
    );
  } catch {
    supervisorNote = "Gateway not started (start manually with `hive start`)";
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
