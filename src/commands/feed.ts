import { UsageError } from "../lib/errors";
import { formatFeed } from "../lib/feed";
import { dim, section } from "../lib/format";
import { listOpenProjectMessages } from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import {
  listActiveRuns,
  listRecentRuns,
  readRunOutputTail,
  RunRecord,
} from "../lib/runs";
import {
  formatDetachedSupervisorState,
  reconcileDetachedSupervisorState,
} from "../lib/detached-supervisor";

type WatchOptions = {
  limit: number;
  intervalSeconds: number;
  once: boolean;
};

type WatchSnapshot = {
  projectId: string;
  supervisorStatus: string;
  activeRuns: Array<{
    run: RunRecord;
    outputTail: string[];
  }>;
  recentRuns: RunRecord[];
  assignmentCount: number;
  messageCount: number;
  recentFeed: string;
};

function parseLimit(arg: string | undefined, command: string): number {
  if (!arg) {
    return 10;
  }

  const value = Number(arg);

  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`Usage: hive ${command} [count]`);
  }

  return value;
}

function parseWatchOptions(args: string[]): WatchOptions {
  let limit = 10;
  let intervalSeconds = 2;
  let once = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--interval") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError("Usage: hive watch [count] [--interval <seconds>] [--once]");
      }

      intervalSeconds = value;
      index += 1;
      continue;
    }

    if (arg === "--once") {
      once = true;
      continue;
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new UsageError("Usage: hive watch [count] [--interval <seconds>] [--once]");
  }

  if (positional[0]) {
    limit = parseLimit(positional[0], "watch");
  }

  return { limit, intervalSeconds, once };
}

function formatSupervisorSection(statusText: string): string {
  return statusText
    .split("\n")
    .slice(4)
    .join("\n")
    .trim();
}

function formatActiveRun(run: RunRecord, outputTail: string[]): string {
  const summary = [
    `- ${run.agentId} | ${run.status} | ${run.runtime}${run.model ? ` (${run.model})` : ""}`,
    `  pid: ${run.pid ?? "unknown"} | started: ${run.started}`,
    `  task: ${run.taskId ?? "(none)"} | source: ${run.source}`,
    `  scope: ${run.scope?.join(", ") || "*"}`,
  ];

  if (outputTail.length > 0) {
    summary.push("  visible-output:");
    for (const line of outputTail) {
      summary.push(`    ${line}`);
    }
  } else {
    summary.push("  visible-output: (no visible output yet)");
  }

  return summary.join("\n");
}

function formatRecentRuns(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "No completed runs recorded yet.";
  }

  return runs
    .map((run) =>
      [
        `- ${run.agentId} | ${run.status} | ${run.runtime}${run.model ? ` (${run.model})` : ""}`,
        `  ended: ${run.ended ?? "unknown"} | exit: ${run.exitCode ?? "unknown"} | task: ${run.taskId ?? "(none)"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function renderWatchDashboard(input: WatchSnapshot): string {
  const activeSection =
    input.activeRuns.length > 0
      ? input.activeRuns.map(({ run, outputTail }) => formatActiveRun(run, outputTail)).join("\n\n")
      : "No active agent runs.";
  const recentFeed = input.recentFeed.trim() || "(none yet)";

  return [
    `HIVE Watch`,
    dim(`project: ${input.projectId}`),
    "",
    section("Supervisor", formatSupervisorSection(input.supervisorStatus)),
    section(
      "Queue",
      [
        `active-agents: ${input.activeRuns.length}`,
        `open-assignments: ${input.assignmentCount}`,
        `open-other-messages: ${input.messageCount}`,
      ].join("\n"),
    ),
    section("Active Runs", activeSection),
    section("Recent Runs", formatRecentRuns(input.recentRuns)),
    section("Recent Feed", recentFeed),
    "",
    dim("Ctrl-C to exit"),
  ].join("\n\n");
}

async function buildWatchSnapshot(limit: number): Promise<WatchSnapshot> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const [supervisorState, activeRuns, recentRuns, openMessages, feedText] = await Promise.all([
    reconcileDetachedSupervisorState(projectPaths),
    listActiveRuns(projectPaths),
    listRecentRuns(projectPaths, limit),
    listOpenProjectMessages(paths.msgDir, activeProject),
    Bun.file(paths.feed).text().catch(() => ""),
  ]);
  const activeRunOutput = await Promise.all(
    activeRuns.map(async (run) => ({
      run,
      outputTail: await readRunOutputTail(run, limit),
    })),
  );
  const assignmentCount = openMessages.filter((message) => message.attributes.type === "assign").length;
  const messageCount = openMessages.length - assignmentCount;
  const recentFeed = formatFeed(feedText, limit)
    .split("\n")
    .filter((line) => line.trim() !== "# HIVE Feed")
    .join("\n")
    .trim();

  return {
    projectId: activeProject,
    supervisorStatus: formatDetachedSupervisorState(supervisorState, activeProject),
    activeRuns: activeRunOutput,
    recentRuns,
    assignmentCount,
    messageCount,
    recentFeed,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function feedCommand(args: string[]): Promise<string> {
  const limit = parseLimit(args[0], "feed");
  const paths = await ensureHiveScaffold();
  const feedText = await Bun.file(paths.feed).text();

  return formatFeed(feedText, limit);
}

export async function watchCommand(args: string[]): Promise<string> {
  const options = parseWatchOptions(args);

  if (!process.stdout.isTTY || options.once) {
    return renderWatchDashboard(await buildWatchSnapshot(options.limit));
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    while (!stopped) {
      const snapshot = await buildWatchSnapshot(options.limit);
      process.stdout.write("\u001bc");
      process.stdout.write(`${renderWatchDashboard(snapshot)}\n`);
      await sleep(options.intervalSeconds * 1000);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }

  return "";
}
