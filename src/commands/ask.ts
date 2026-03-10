import { UsageError } from "../lib/errors";
import { reconcileDetachedSupervisorState } from "../lib/detached-supervisor";
import { digestBoard, digestMessages, digestRuns } from "../lib/digest";
import { formatFeed } from "../lib/feed";
import { section } from "../lib/format";
import { listOpenProjectMessages } from "../lib/messages";
import { listActiveRuns } from "../lib/runs";
import { isProcessAlive } from "../lib/supervisor";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";

export async function askCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  const [supervisorState, boardText, openMessages, activeRuns, feedText] = await Promise.all([
    reconcileDetachedSupervisorState(projectPaths),
    Bun.file(projectPaths.board).text().catch(() => ""),
    listOpenProjectMessages(paths.msgDir, activeProject),
    listActiveRuns(projectPaths),
    Bun.file(paths.feed).text().catch(() => ""),
  ]);

  const supervisorRunning =
    supervisorState?.status === "active" && isProcessAlive(supervisorState.pid);
  const supervisorSection = supervisorRunning
    ? `running (pid ${supervisorState.pid}, interval ${supervisorState.intervalSeconds}s, last-pass: ${supervisorState.lastPassAt ?? "none yet"})`
    : "not running";

  const nonAssignMessages = openMessages.filter(
    (m) => m.attributes.type !== "assign",
  );

  const feedSection = formatFeed(feedText, 5);
  const feedBody = feedSection
    .split("\n")
    .filter((line) => !line.startsWith("# "))
    .join("\n")
    .trim() || "(none yet)";

  const parts = [
    `Project: ${activeProject}`,
    section("Supervisor", supervisorSection),
    section("Board", boardText.trim() ? digestBoard(boardText) : "(no board yet)"),
    section("Active Runs", digestRuns(activeRuns)),
    section("Open Messages", digestMessages(nonAssignMessages)),
    section("Recent Feed", feedBody),
  ];

  return parts.join("\n\n");
}
