import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { appendLogEntry } from "../lib/log";
import { digestBoard, digestMessages, listSkills } from "../lib/digest";
import { listOpenProjectMessages } from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { extractRepoPath } from "../lib/project";
import {
  buildInteractiveLaunchSpec,
  renderLaunchPreview,
  resolveRuntimeHints,
  startInteractiveSession,
} from "../lib/runtime";
import { UsageError } from "../lib/errors";
import { appendFeedEntry } from "../lib/feed";
import { toCompactTimestamp } from "../lib/time";

type ConsoleOptions = {
  runtimeOverride: string | null;
  modelOverride: string | null;
  dryRun: boolean;
};

function parseOptions(args: string[]): ConsoleOptions {
  let runtimeOverride: string | null = null;
  let modelOverride: string | null = null;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--runtime") {
      runtimeOverride = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--model") {
      modelOverride = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new UsageError("Usage: hive console [--runtime <runtime>] [--model <model>] [--dry-run]");
  }

  return {
    runtimeOverride,
    modelOverride,
    dryRun,
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

function buildConsolePrompt(input: {
  projectId: string;
  repoPath: string;
  hiveHome: string;
  pathsSoul: string;
  pathsSelf: string;
  pathsAgents: string;
  pathsConfig: string;
  pathsFeed: string;
  knowledgePath: string;
  decisionsPath: string;
  projectConfigPath: string;
  planPath: string;
  boardPath: string;
  logPath: string;
  projectMemoryPath: string;
  projectMemory: string;
  messagesDir: string;
  skillsDir: string;
  availableSkillNames: string[];
  soul: string;
  board: string;
  openMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
}): string {
  const essentialSkills = ["state-efficient-ops"];
  const essentialSkillPaths = essentialSkills
    .filter((name) => input.availableSkillNames.includes(name))
    .map((name) => `${input.skillsDir}/${name}.md`);

  return `# HIVE Console Session

You are HIVE itself for project ${input.projectId}. You are in a persistent interactive conversation with the human about this project.

## Identity
${input.soul}

## Essential Skills
Read these before acting: ${essentialSkillPaths.join(", ") || "(none)"}

## Interactive Operating Rules
- You are in a persistent conversation with the human about project ${input.projectId}. This is not a one-shot query — maintain context across turns.
- Use the hive CLI to manage agents: \`hive msg\`, \`hive log\`, \`hive inbox\`, \`hive launch\`, \`hive nudge\`, \`hive status\`, \`hive feed\`, etc.
- Re-read state files between turns — agents may have changed things in the background. Surface status from live files, not stale context.
- When the human changes direction, update PLAN.md and BOARD.md, then send assignment messages to affected agents via \`hive msg\`.
- When the human asks about agent progress, read their LOG.md entries and recent run results from the runs/ directory.
- Keep feed.md updated with significant actions you take using \`hive log\` or by writing directly.
- Answer the human directly and concretely. You are the steering interface for the entire hive.
- When the human changes priorities, scope, or team behavior, update the relevant files instead of only describing the change.
- Use msg/ for work handoffs or nudges to agents.
- Keep BOARD.md as steward-owned. Update it when the human redirects work.
- Keep feed.md high-signal. If you make a meaningful change, append a concise feed entry.
- Keep LOG.md durable. Record important decisions or redirections there.
- The authoritative hive files are not in the repo root. Use the absolute paths below.

## Hive Identity
project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.hiveHome}

## Files
SOUL.md: ${input.pathsSoul}
SELF.md: ${input.pathsSelf}
AGENTS.md: ${input.pathsAgents}
config: ${input.pathsConfig}
feed: ${input.pathsFeed}
knowledge: ${input.knowledgePath}
decisions: ${input.decisionsPath}
project-config: ${input.projectConfigPath}
PLAN.md: ${input.planPath}
BOARD.md: ${input.boardPath}
LOG.md: ${input.logPath}
project-memory: ${input.projectMemoryPath}
messages-dir: ${input.messagesDir}

## Available Skills
${listSkills(input.skillsDir, input.availableSkillNames)}

## Board Summary
${digestBoard(input.board)}

## Project Memory
${input.projectMemory}

## Open Project Messages
${digestMessages(input.openMessages)}`;
}

export async function consoleCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const soul = await Bun.file(paths.soul).text();
  const globalConfig = await Bun.file(paths.config).text();
  const projectConfig = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const board = await Bun.file(projectPaths.board).text();
  const openMessages = await listOpenProjectMessages(paths.msgDir, activeProject);
  const availableSkillNames = await listAvailableSkills(paths.skillsDir);

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

  const prompt = buildConsolePrompt({
    projectId: activeProject,
    repoPath,
    hiveHome: paths.home,
    pathsSoul: paths.soul,
    pathsSelf: paths.self,
    pathsAgents: paths.agents,
    pathsConfig: paths.config,
    pathsFeed: paths.feed,
    knowledgePath: join(paths.memoryDir, "knowledge.md"),
    decisionsPath: join(paths.memoryDir, "decisions.md"),
    projectConfigPath: projectPaths.config,
    planPath: projectPaths.plan,
    boardPath: projectPaths.board,
    logPath: projectPaths.log,
    projectMemoryPath: projectPaths.memory,
    projectMemory,
    messagesDir: paths.msgDir,
    skillsDir: paths.skillsDir,
    availableSkillNames,
    soul: soul.trim(),
    board: board.trim(),
    openMessages,
  });

  const hints = resolveRuntimeHints({
    globalConfig,
    runtimeOverride: options.runtimeOverride,
    modelOverride: options.modelOverride,
  });

  const spec = buildInteractiveLaunchSpec({
    runtime: hints.runtime,
    model: hints.model,
    repoPath,
    hiveHome: paths.home,
    systemPrompt: prompt,
  });

  const promptPath = join(
    projectPaths.runsDir,
    `${toCompactTimestamp()}-console.prompt.md`,
  );

  await Bun.write(promptPath, `${prompt.trim()}\n`);

  if (options.dryRun) {
    return `Console dry run
Project: ${activeProject}
Runtime: ${spec.runtime}
Model: ${spec.model ?? "(default)"}
Prompt: ${promptPath}
Command: ${renderLaunchPreview(spec)}`;
  }

  await appendLogEntry(projectPaths.log, "human → hive console", "Interactive session started");
  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Console session started`,
    details: [`runtime: ${spec.runtime}`, `model: ${spec.model ?? "(default)"}`],
  });

  const handle = startInteractiveSession(spec, repoPath);
  const result = await handle.wait();

  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Console session ended`,
    details: [
      `runtime: ${spec.runtime}`,
      `exit: ${result.code ?? "unknown"}${result.signal ? ` | signal: ${result.signal}` : ""}`,
    ],
  });

  if (result.signal) {
    throw new UsageError(`Console runtime exited due to ${result.signal}`);
  }

  if (result.code !== null && result.code !== 0) {
    throw new UsageError(`Console runtime exited with status ${result.code}`);
  }

  return `Hive console session completed via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""}`;
}
