import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { listOpenProjectMessages } from "../lib/messages";
import { loadPromptMemoryContext } from "../lib/memory";
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
import { listActiveRuns, listRecentRunResults } from "../lib/runs";

type ParsedOptions = {
  mode: OrchestrateMode;
  intervalSeconds: number;
  goal: string | null;
};

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

async function listAvailableSkills(skillsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir);
    return entries
      .filter((e) => e.endsWith(".md"))
      .map((e) => e.replace(/\.md$/, ""));
  } catch {
    return [];
  }
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
  const globalConfig = await Bun.file(paths.config).text().catch(() => "");
  const projectConfig = await Bun.file(projectPaths.config).text();
  const board = await Bun.file(projectPaths.board).text();
  const repoPath = extractRepoPath(projectConfig) ?? "(unknown)";
  const personaPath = join(paths.personasDir, "steward.md");
  const openMessages = await listOpenProjectMessages(paths.msgDir, activeProject);
  const activeRuns = await listActiveRuns(projectPaths);
  const recentRunResults = (await listRecentRunResults(projectPaths, 5)).filter(
    (result) => result.agentId !== "orchestrator",
  );
  const availableSkillNames = await listAvailableSkills(paths.skillsDir);
  const memoryContext = await loadPromptMemoryContext(paths, activeProject);

  let projectMemory = "(none yet)";

  try {
    const memoryFile = Bun.file(projectPaths.memory);

    if (await memoryFile.exists()) {
      const content = (await memoryFile.text()).trim();

      if (content) {
        projectMemory = content;
      }
    }
  } catch {
    // leave as default
  }

  return await buildOrchestratorPrompt({
    projectId: activeProject,
    pathsHome: paths.home,
    globalConfig,
    repoPath,
    pathsSoul: paths.soul,
    pathsIdentity: paths.identity,
    pathsSelf: paths.self,
    pathsAgents: paths.agents,
    pathsTrust: paths.trust,
    personaPath,
    projectConfigPath: projectPaths.config,
    planPath: projectPaths.plan,
    boardPath: projectPaths.board,
    logPath: projectPaths.log,
    projectMemoryPath: projectPaths.memory,
    projectMemory,
    memorySummaryPath: memoryContext.memorySummaryPath,
    memoryHeatPath: memoryContext.memoryHeatPath,
    recentDecisionsPath: memoryContext.recentDecisionsPath,
    projectEntitySummaryPath: memoryContext.projectEntitySummaryPath,
    journalPath: memoryContext.journalPath,
    messagesDir: paths.msgDir,
    skillsDir: paths.skillsDir,
    availableSkillNames,
    soul,
    board,
    activeRuns,
    recentRunResults,
    openMessages,
    knowledgeDigest: memoryContext.globalKnowledgeDigest,
    recentDecisionsDigest: memoryContext.recentDecisionsDigest,
    projectEntityDigest: memoryContext.projectEntityDigest,
    options,
  });
}
