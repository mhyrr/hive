import { join } from "node:path";

import { appendLogEntry } from "../lib/log";
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
import { appendFeedEntry, formatFeed } from "../lib/feed";
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

async function readIfExists(path: string): Promise<string> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return "";
  }

  return (await file.text()).trim();
}

function renderMessages(
  messages: Awaited<ReturnType<typeof listOpenProjectMessages>>,
): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages.map((message) => `### ${message.filename}\n${message.raw}`).join("\n\n");
}

function buildChatPrompt(input: {
  projectId: string;
  repoPath: string;
  hiveHome: string;
  soul: string;
  self: string;
  globalConfig: string;
  knowledge: string;
  decisions: string;
  projectMemory: string;
  projectConfig: string;
  plan: string;
  board: string;
  log: string;
  feed: string;
  openMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
  message: string;
}): string {
  return `# HIVE Chat Prompt

You are HIVE itself for project ${input.projectId}. You are the human-facing interface over the hive's files.

## Operating Rules
- Answer the human directly and concretely.
- When the human changes priorities, scope, or team behavior, update the relevant files instead of only describing the change.
- Use msg/ for work handoffs or nudges to agents.
- Keep BOARD.md as steward-owned. If you are acting as the human-facing layer, send direction through the proper files rather than inventing side channels.
- Keep feed.md high-signal. If you make a meaningful change, append a concise feed entry.
- Keep LOG.md durable. Record important decisions or redirections there.

## Human Message
${input.message}

## Hive Identity
project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.hiveHome}

## HIVE File Paths
project files live under the hive home, not the repo root. Use the referenced hive paths directly when reading or updating state.

## SOUL.md
${input.soul}

## SELF.md
${input.self}

## Hive Config
${input.globalConfig}

## Hive Knowledge
${input.knowledge || "(none yet)"}

## Hive Decisions
${input.decisions || "(none yet)"}

## Project Memory
${input.projectMemory || "(none yet)"}

## Project Config
${input.projectConfig}

## Active PLAN.md
${input.plan}

## BOARD.md
${input.board}

## LOG.md
${input.log}

## Recent Feed
${input.feed}

## Open Project Messages
${renderMessages(input.openMessages)}`;
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
  const self = await Bun.file(paths.self).text();
  const globalConfig = await Bun.file(paths.config).text();
  const projectConfig = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const prompt = buildChatPrompt({
    projectId: activeProject,
    repoPath,
    hiveHome: paths.home,
    soul: soul.trim(),
    self: self.trim(),
    globalConfig: globalConfig.trim(),
    knowledge: await readIfExists(join(paths.memoryDir, "knowledge.md")),
    decisions: await readIfExists(join(paths.memoryDir, "decisions.md")),
    projectMemory: await readIfExists(projectPaths.memory),
    projectConfig: projectConfig.trim(),
    plan: (await Bun.file(projectPaths.plan).text()).trim(),
    board: (await Bun.file(projectPaths.board).text()).trim(),
    log: (await Bun.file(projectPaths.log).text()).trim(),
    feed: formatFeed(await Bun.file(paths.feed).text(), 10),
    openMessages: await listOpenProjectMessages(paths.msgDir, activeProject),
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
