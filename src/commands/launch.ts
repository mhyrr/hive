import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { appendFeedEntry } from "../lib/feed";
import { appendLogEntry } from "../lib/log";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import {
  extractRepoPath,
  findPlanAgent,
  parseDefaultTeam,
} from "../lib/project";
import {
  buildLaunchSpec,
  renderLaunchPreview,
  resolveRuntimeHints,
  runLaunchSpec,
} from "../lib/runtime";
import { toCompactTimestamp } from "../lib/time";
import { orchestrateCommand } from "./orchestrate";
import { promptCommand } from "./prompt";

type LaunchOptions = {
  runtimeOverride: string | null;
  modelOverride: string | null;
  dryRun: boolean;
  agentId: string;
  goal: string | null;
};

function parseOptions(args: string[]): LaunchOptions {
  let runtimeOverride: string | null = null;
  let modelOverride: string | null = null;
  let dryRun = false;
  const positional: string[] = [];

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

    positional.push(arg);
  }

  const [agentId, ...goalParts] = positional;

  if (!agentId) {
    throw new UsageError("Usage: hive launch [--runtime <runtime>] [--model <model>] [--dry-run] <agent-id> [goal]");
  }

  return {
    runtimeOverride,
    modelOverride,
    dryRun,
    agentId,
    goal: goalParts.join(" ").trim() || null,
  };
}

export async function launchCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  if (options.agentId !== "orchestrator" && options.goal) {
    throw new UsageError("Goals can only be passed when launching `orchestrator`.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const projectConfig = await Bun.file(projectPaths.config).text();
  const plan = await Bun.file(projectPaths.plan).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const planAgent = findPlanAgent(plan, options.agentId);
  const teamAgent = parseDefaultTeam(projectConfig).find((agent) => agent.id === options.agentId);

  if (options.agentId !== "orchestrator" && !planAgent && !teamAgent) {
    throw new UsageError(`Unknown agent: ${options.agentId}`);
  }

  const prompt =
    options.agentId === "orchestrator"
      ? await orchestrateCommand(options.goal ? [options.goal] : [])
      : await promptCommand([options.agentId]);
  const hints = resolveRuntimeHints({
    globalConfig: await Bun.file(paths.config).text(),
    teamAgent,
    planAgent,
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
    `${toCompactTimestamp()}-${options.agentId}.prompt.md`,
  );

  await Bun.write(promptPath, `${prompt.trim()}\n`);

  if (options.dryRun) {
    return `Launch dry run
Project: ${activeProject}
Agent: ${options.agentId}
Runtime: ${spec.runtime}
Model: ${spec.model ?? "(default)"}
Prompt: ${promptPath}
Command: ${renderLaunchPreview(spec)}`;
  }

  await appendLogEntry(
    projectPaths.log,
    "hive launch",
    `${options.agentId} via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""}`,
  );
  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Launching ${options.agentId}`,
    details: [`runtime: ${spec.runtime}`, `model: ${spec.model ?? "(default)"}`],
  });

  const result = await runLaunchSpec(spec, repoPath);

  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `${options.agentId} completed`,
    details: [`runtime: ${spec.runtime}`, `exit: ${result.code ?? "unknown"}`],
  });

  if (result.code && result.code !== 0) {
    throw new UsageError(`Launch runtime exited with status ${result.code}`);
  }

  return `Launched ${options.agentId} via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""}`;
}
