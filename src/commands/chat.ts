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
  buildLaunchSpec,
  renderLaunchPreview,
  resolveRuntimeHints,
  runLaunchSpec,
} from "../lib/runtime";
import { UsageError } from "../lib/errors";
import { appendFeedEntry } from "../lib/feed";
import { toCompactTimestamp } from "../lib/time";

type ChatOptions = {
  runtimeOverride: string | null;
  modelOverride: string | null;
  dryRun: boolean;
  message: string;
};

function parseOptions(args: string[]): ChatOptions {
  let runtimeOverride: string | null = null;
  let modelOverride: string | null = null;
  let dryRun = false;
  const messageParts: string[] = [];

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

    messageParts.push(arg);
  }

  const message = messageParts.join(" ").trim();

  if (!message) {
    throw new UsageError("Usage: hive chat [--runtime <runtime>] [--model <model>] [--dry-run] <message>");
  }

  return {
    runtimeOverride,
    modelOverride,
    dryRun,
    message,
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

function buildChatPrompt(input: {
  projectId: string;
  repoPath: string;
  hiveHome: string;
  pathsSoul: string;
  pathsIdentity: string;
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
  messagesDir: string;
  skillsDir: string;
  availableSkillNames: string[];
  soul: string;
  board: string;
  openMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
  message: string;
}): string {
  const essentialSkills = ["state-efficient-ops", "autonomous-ops"];
  const essentialSkillPaths = essentialSkills
    .filter((name) => input.availableSkillNames.includes(name))
    .map((name) => `${input.skillsDir}/${name}.md`);

  return `# HIVE Chat Prompt

You are HIVE itself for project ${input.projectId}. You are the human-facing interface over the hive's files.

## Shared Soul
${input.soul}

Read agent identity: ${input.pathsIdentity}
Read user preferences: ${input.pathsSelf}
Read operational doctrine: ${input.pathsAgents}

## Operating Rules
- Read essential skills before acting: ${essentialSkillPaths.join(", ") || "(none)"}
- Answer the human directly and concretely.
- When the human changes priorities, scope, or team behavior, update the relevant files instead of only describing the change.
- Use msg/ for work handoffs or nudges to agents.
- Keep BOARD.md as steward-owned. If you are acting as the human-facing layer, send direction through the proper files rather than inventing side channels.
- Keep feed.md high-signal. If you make a meaningful change, append a concise feed entry.
- Keep LOG.md durable. Record important decisions or redirections there.
- The authoritative hive files are not in the repo root. Use the absolute paths below.

## Human Message
${input.message}

## Hive Identity
project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.hiveHome}

## Files
SOUL.md: ${input.pathsSoul}
IDENTITY.md: ${input.pathsIdentity}
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

## Open Project Messages
${digestMessages(input.openMessages)}`;
}

export async function chatCommand(args: string[]): Promise<string> {
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

  const prompt = buildChatPrompt({
    projectId: activeProject,
    repoPath,
    hiveHome: paths.home,
    pathsSoul: paths.soul,
    pathsIdentity: paths.identity,
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
    messagesDir: paths.msgDir,
    skillsDir: paths.skillsDir,
    availableSkillNames,
    soul: soul.trim(),
    board: board.trim(),
    openMessages,
    message: options.message,
  });
  const hints = resolveRuntimeHints({
    globalConfig,
    runtimeOverride: options.runtimeOverride,
    modelOverride: options.modelOverride,
  });
  const spec = buildLaunchSpec({
    runtime: hints.runtime,
    model: hints.model,
    repoPath,
    hiveHome: paths.home,
    prompt,
  });
  const promptPath = join(
    projectPaths.runsDir,
    `${toCompactTimestamp()}-chat.prompt.md`,
  );

  await Bun.write(promptPath, `${prompt.trim()}\n`);

  if (options.dryRun) {
    return `Chat dry run
Project: ${activeProject}
Runtime: ${spec.runtime}
Model: ${spec.model ?? "(default)"}
Prompt: ${promptPath}
Command: ${renderLaunchPreview(spec)}`;
  }

  await appendLogEntry(projectPaths.log, "human → hive chat", options.message);
  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Human chat: ${options.message.split("\n")[0]}`,
    details: [`runtime: ${spec.runtime}`, `model: ${spec.model ?? "(default)"}`],
  });

  const result = await runLaunchSpec(spec, repoPath);

  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Hive chat completed`,
    details: [
      `runtime: ${spec.runtime}`,
      `exit: ${result.code ?? "unknown"}${result.signal ? ` | signal: ${result.signal}` : ""}`,
    ],
  });

  if (result.signal) {
    throw new UsageError(`Chat runtime exited due to ${result.signal}`);
  }

  if (result.code !== null && result.code !== 0) {
    throw new UsageError(`Chat runtime exited with status ${result.code}`);
  }

  return `Hive chat completed via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""}`;
}
