import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { listOpenProjectMessages } from "../lib/messages";
import {
  buildOrchestratorPrompt,
  enqueueGoalForOrchestrator,
  OrchestrateMode,
} from "../lib/orchestrator";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { extractRepoPath } from "../lib/project";

type ParsedOptions = {
  mode: OrchestrateMode;
  intervalSeconds: number;
  goal: string | null;
};

async function readIfExists(path: string): Promise<string> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return "";
  }

  return (await file.text()).trim();
}

function parseOptions(args: string[]): ParsedOptions {
  let mode: OrchestrateMode = "interactive";
  let intervalSeconds = 45;
  const goalParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--mode") {
      const value = args[index + 1];

      if (value !== "interactive" && value !== "loop") {
        throw new UsageError("Usage: hive orchestrate [--mode interactive|loop] [--interval <seconds>] [goal]");
      }

      mode = value;
      index += 1;
      continue;
    }

    if (arg === "--interval") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError("`--interval` must be a positive integer number of seconds.");
      }

      intervalSeconds = value;
      index += 1;
      continue;
    }

    goalParts.push(arg);
  }

  return {
    mode,
    intervalSeconds,
    goal: goalParts.join(" ").trim() || null,
  };
}

export async function orchestrateCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  if (options.goal) {
    await enqueueGoalForOrchestrator(paths, projectPaths, activeProject, options.goal);
  }

  const soul = await Bun.file(paths.soul).text();
  const self = await Bun.file(paths.self).text();
  const persona = await Bun.file(join(paths.personasDir, "steward.md")).text();
  const knowledge = await readIfExists(join(paths.memoryDir, "knowledge.md"));
  const projectMemory = await readIfExists(projectPaths.memory);
  const projectConfig = await Bun.file(projectPaths.config).text();
  const plan = await Bun.file(projectPaths.plan).text();
  const board = await Bun.file(projectPaths.board).text();
  const log = await Bun.file(projectPaths.log).text();
  const repoPath = extractRepoPath(projectConfig) ?? "(unknown)";
  const openMessages = await listOpenProjectMessages(paths.msgDir, activeProject);

  return buildOrchestratorPrompt({
    projectId: activeProject,
    pathsHome: paths.home,
    repoPath,
    pathsSoul: paths.soul,
    pathsSelf: paths.self,
    projectConfigPath: projectPaths.config,
    planPath: projectPaths.plan,
    boardPath: projectPaths.board,
    logPath: projectPaths.log,
    projectMemoryPath: projectPaths.memory,
    messagesDir: paths.msgDir,
    soul,
    self,
    persona,
    knowledge,
    projectMemory,
    projectConfig,
    plan,
    board,
    log,
    openMessages,
    options,
  });
}
