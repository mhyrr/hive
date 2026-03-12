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
import {
  buildLaunchSpec,
  resolveRuntimeHints,
  runLaunchSpec,
} from "../lib/runtime";
import { extractRepoPath } from "../lib/project";
import { refreshProjectRuntimeState } from "../lib/state";

function buildStatusDigest(input: {
  activeProject: string;
  supervisorSection: string;
  boardText: string;
  activeRuns: Awaited<ReturnType<typeof listActiveRuns>>;
  nonAssignMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
  feedBody: string;
}): string {
  return [
    `Project: ${input.activeProject}`,
    section("Supervisor", input.supervisorSection),
    section("Board", input.boardText.trim() ? digestBoard(input.boardText) : "(no board yet)"),
    section("Active Runs", digestRuns(input.activeRuns)),
    section("Open Messages", digestMessages(input.nonAssignMessages)),
    section("Recent Feed", input.feedBody),
  ].join("\n\n");
}

function buildAskPrompt(stateDigest: string, question: string): string {
  return `You are the hive mind — the intelligence managing a team of coding agents. A human operator is asking you a question. Answer based on the system state below.

Be direct and concise. Focus on actionable information. If the state doesn't contain enough information to answer, say so.

## Current System State

${stateDigest}

## Question

${question}`;
}

export async function askCommand(args: string[]): Promise<string> {
  const question = args.join(" ").trim();
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  const [supervisorState, state, feedText] = await Promise.all([
    reconcileDetachedSupervisorState(projectPaths),
    refreshProjectRuntimeState({
      hivePaths: paths,
      projectId: activeProject,
      projectPaths,
    }),
    Bun.file(paths.feed).text().catch(() => ""),
  ]);

  const supervisorRunning =
    supervisorState?.status === "active" && isProcessAlive(supervisorState.pid);
  const supervisorSection = supervisorRunning
    ? `running (pid ${supervisorState.pid}, interval ${supervisorState.intervalSeconds}s, last-pass: ${supervisorState.lastPassAt ?? "none yet"})`
    : "not running";

  const nonAssignMessages = state.openMessages.filter(
    (m) => m.attributes.type !== "assign",
  );

  const feedSection = formatFeed(feedText, 5);
  const feedBody = feedSection
    .split("\n")
    .filter((line) => !line.startsWith("# "))
    .join("\n")
    .trim() || "(none yet)";

  const digest = buildStatusDigest({
    activeProject,
    supervisorSection,
    boardText: state.boardText,
    activeRuns: state.activeRuns,
    nonAssignMessages,
    feedBody,
  });

  // No question: return fast synthesized status
  if (!question) {
    return digest;
  }

  // With question: make a single-turn LLM call
  const projectConfig = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const globalConfig = await Bun.file(paths.config).text().catch(() => "");
  const hints = resolveRuntimeHints({ globalConfig });
  const prompt = buildAskPrompt(digest, question);
  const spec = buildLaunchSpec({
    runtime: hints.runtime,
    model: hints.model,
    repoPath,
    hiveHome: paths.home,
    prompt,
  });

  const result = await runLaunchSpec(spec, repoPath, { quiet: true });

  if (result.code !== null && result.code !== 0) {
    throw new UsageError(`Ask runtime exited with status ${result.code}`);
  }

  return result.visibleOutput || digest;
}
