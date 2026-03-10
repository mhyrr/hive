import { UsageError } from "../lib/errors";
import {
  reconcileDetachedSupervisorState,
  startDetachedSupervisor,
} from "../lib/detached-supervisor";
import { appendFeedEntry } from "../lib/feed";
import { appendLogEntry } from "../lib/log";
import { isProcessAlive, DEFAULT_MAX_PARALLEL, DEFAULT_SUPERVISOR_INTERVAL_SECONDS } from "../lib/supervisor";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";

type RunOptions = {
  intervalSeconds: number;
  maxParallel: number;
};

function parseOptions(args: string[]): RunOptions {
  let intervalSeconds = DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
  let maxParallel = DEFAULT_MAX_PARALLEL;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--interval") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError("Usage: hive run [--interval <seconds>] [--max-parallel <count>]");
      }
      intervalSeconds = value;
      index += 1;
      continue;
    }

    if (arg === "--max-parallel") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError("Usage: hive run [--interval <seconds>] [--max-parallel <count>]");
      }
      maxParallel = value;
      index += 1;
      continue;
    }

    throw new UsageError("Usage: hive run [--interval <seconds>] [--max-parallel <count>]");
  }

  return { intervalSeconds, maxParallel };
}

export async function runCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const existing = await reconcileDetachedSupervisorState(projectPaths);

  if (existing?.status === "active" && isProcessAlive(existing.pid)) {
    return [
      `HIVE is already running for ${activeProject}`,
      `pid: ${existing.pid}`,
      `interval: ${existing.intervalSeconds}s`,
      `last-pass: ${existing.lastPassAt ?? "none yet"}`,
    ].join("\n");
  }

  try {
    const state = await startDetachedSupervisor({
      projectPaths,
      projectId: activeProject,
      intervalSeconds: options.intervalSeconds,
      maxParallel: options.maxParallel,
    });

    await appendFeedEntry(paths, {
      project: activeProject,
      headline: "HIVE started",
      details: [`pid: ${state.pid ?? "unknown"}`, `interval: ${state.intervalSeconds}s`],
    });
    await appendLogEntry(
      projectPaths.log,
      "human -> hive run",
      `Started supervision pid ${state.pid ?? "unknown"} interval ${state.intervalSeconds}s max-parallel ${state.maxParallel}`,
    );

    return [
      `HIVE is running for ${activeProject}`,
      `pid: ${state.pid ?? "unknown"}`,
      `interval: ${state.intervalSeconds}s`,
      `max-parallel: ${state.maxParallel}`,
    ].join("\n");
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }

    return [
      `HIVE supervision could not start for ${activeProject}`,
      `Use \`hive supervise --detach\` for more details.`,
    ].join("\n");
  }
}
