import { section } from "../lib/format";
import { UsageError } from "../lib/errors";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { listActiveRuns, listRecentRuns, RunRecord } from "../lib/runs";

function formatModel(run: RunRecord): string {
  return run.model ?? "(default)";
}

function formatActiveRuns(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "No active runs.";
  }

  return runs
    .map((run) =>
      [
        `- ${run.agentId} | ${run.status} | ${run.runId}`,
        `  runtime: ${run.runtime} | model: ${formatModel(run)} | pid: ${run.pid ?? "unknown"}`,
        `  started: ${run.started} | scope: ${run.scope?.join(", ") || "*"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function formatRecentRuns(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "No completed runs recorded yet.";
  }

  return runs
    .map((run) =>
      [
        `- ${run.agentId} | ${run.status} | ${run.runId}`,
        `  runtime: ${run.runtime} | model: ${formatModel(run)} | exit: ${run.exitCode ?? "unknown"}`,
        `  started: ${run.started}${run.ended ? ` | ended: ${run.ended}` : ""} | scope: ${run.scope?.join(", ") || "*"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export async function psCommand(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const activeRuns = await listActiveRuns(projectPaths);
  const recentRuns = await listRecentRuns(projectPaths, 5);

  return [
    `Project: ${activeProject}`,
    `Active runs: ${activeRuns.length}`,
    section("Active Runs", formatActiveRuns(activeRuns)),
    section("Recent Runs", formatRecentRuns(recentRuns)),
  ].join("\n\n");
}
