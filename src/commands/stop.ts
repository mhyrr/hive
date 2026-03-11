import { appendFeedEntry } from "../lib/feed";
import { UsageError } from "../lib/errors";
import { appendLogEntry } from "../lib/log";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { listActiveRuns, markRunStopRequested } from "../lib/runs";

function findTargetRun(
  target: string,
  runs: Awaited<ReturnType<typeof listActiveRuns>>,
) {
  const normalized = target.trim();

  if (!normalized) {
    return null;
  }

  const matches = runs.filter(
    (run) =>
      run.agentId === normalized ||
      run.runId === normalized ||
      run.runId.startsWith(normalized),
  );

  if (matches.length !== 1) {
    return null;
  }

  return matches[0] ?? null;
}

export async function stopCommand(args: string[]): Promise<string> {
  const target = args[0]?.trim();

  if (!target) {
    throw new UsageError("Usage: hive stop <agent-id|run-id>");
  }

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const activeRuns = await listActiveRuns(projectPaths);
  const run = findTargetRun(target, activeRuns);

  if (!run) {
    throw new UsageError(`No active run matched \`${target}\`.`);
  }

  if (!run.pid) {
    throw new UsageError(`Run ${run.runId} does not have a live pid to stop.`);
  }

  if (run.source === "console") {
    return `Console session is interactive — exit from within the session. (${run.runId}, pid ${run.pid})`;
  }

  await markRunStopRequested(run, "human");
  process.kill(run.pid, "SIGTERM");
  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Stop requested for ${run.agentId}`,
    details: [`run: ${run.runId}`, `pid: ${run.pid}`],
  });
  await appendLogEntry(
    projectPaths.log,
    "human → hive stop",
    `Requested stop for ${run.agentId} (${run.runId}) pid ${run.pid}`,
  );

  return `Signaled ${run.agentId} (${run.runId}) pid ${run.pid}`;
}
