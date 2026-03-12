import { UsageError } from "../lib/errors";
import { appendFeedEntry } from "../lib/feed";
import { captureGitStatusSnapshot, diffGitStatusSnapshots } from "../lib/git";
import { appendLogEntry } from "../lib/log";
import { findMessage, findOpenAssignmentMessage } from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
  HivePaths,
} from "../lib/paths";
import {
  extractRepoPath,
  findPlanAgent,
  parseDefaultTeam,
  resolveAgentScopeRoots,
} from "../lib/project";
import {
  buildLaunchSpec,
  LaunchResult,
  renderLaunchPreview,
  resolveRuntimeHints,
  startLaunchSpec,
  validateRuntimeInstalled,
} from "../lib/runtime";
import {
  createRunDraft,
  createRunPromptArtifact,
  finalizeRun,
  getRunOutputPath,
  markRunActive,
  readActiveRun,
  readRunRecord,
  writeRunResult,
} from "../lib/runs";
import { orchestrateCommand } from "./orchestrate";
import { promptCommand } from "./prompt";

type LaunchOptions = {
  runtimeOverride: string | null;
  modelOverride: string | null;
  dryRun: boolean;
  agentId: string;
  goal: string | null;
};

type LaunchAgentInput = {
  activeProject: string;
  paths: HivePaths;
  agentId: string;
  goal: string | null;
  runtimeOverride: string | null;
  modelOverride: string | null;
  dryRun: boolean;
  source: string;
  logActor?: string;
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

export async function launchAgentPass(input: LaunchAgentInput): Promise<string> {
  if (input.agentId !== "orchestrator" && input.goal) {
    throw new UsageError("Goals can only be passed when launching `orchestrator`.");
  }

  const projectPaths = getProjectPaths(input.paths, input.activeProject);
  const projectConfig = await Bun.file(projectPaths.config).text();
  const plan = await Bun.file(projectPaths.plan).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const planAgent = findPlanAgent(plan, input.agentId);
  const teamAgent = parseDefaultTeam(projectConfig).find((agent) => agent.id === input.agentId);

  if (input.agentId !== "orchestrator" && !planAgent && !teamAgent) {
    throw new UsageError(`Unknown agent: ${input.agentId}`);
  }

  const prompt =
    input.agentId === "orchestrator"
      ? await orchestrateCommand(input.goal ? [input.goal] : [])
      : await promptCommand([input.agentId]);
  const hints = resolveRuntimeHints({
    globalConfig: await Bun.file(input.paths.config).text(),
    teamAgent,
    planAgent,
    runtimeOverride: input.runtimeOverride,
    modelOverride: input.modelOverride,
  });
  if (!input.dryRun) {
    await validateRuntimeInstalled(hints.runtime);
  }

  const spec = buildLaunchSpec({
    runtime: hints.runtime,
    model: hints.model,
    repoPath,
    hiveHome: input.paths.home,
    prompt,
  });

  if (input.dryRun) {
    const artifact = await createRunPromptArtifact(projectPaths, input.agentId, prompt);

    return `Launch dry run
Project: ${input.activeProject}
Agent: ${input.agentId}
Runtime: ${spec.runtime}
Model: ${spec.model ?? "(default)"}
Prompt: ${artifact.promptPath}
Command: ${renderLaunchPreview(spec)}`;
  }

  const existingRun = await readActiveRun(projectPaths, input.agentId);

  if (existingRun) {
    throw new UsageError(
      `${input.agentId} already has an active run (${existingRun.runId}). Use \`hive ps\` to inspect it.`,
    );
  }

  const assignmentMessage =
    input.agentId === "orchestrator"
      ? null
      : await findOpenAssignmentMessage(input.paths.msgDir, input.activeProject, input.agentId);
  const scope =
    input.agentId === "orchestrator"
      ? null
      : resolveAgentScopeRoots({
          plan,
          projectConfig,
          agentId: input.agentId,
          assignmentScope: assignmentMessage?.attributes.scope ?? null,
        });
  const beforeGit = captureGitStatusSnapshot(repoPath);

  let run = await createRunDraft({
    projectId: input.activeProject,
    projectPaths,
    agentId: input.agentId,
    runtime: spec.runtime,
    model: spec.model,
    prompt,
    source: input.source,
    sourceMessage: assignmentMessage?.filename ?? null,
    taskId: assignmentMessage?.attributes.task ?? null,
    scope,
  });

  await appendLogEntry(
    projectPaths.log,
    input.logActor ?? input.source,
    `${input.agentId} via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""}`,
  );
  await appendFeedEntry(input.paths, {
    project: input.activeProject,
    headline: `Launching ${input.agentId}`,
    details: [`runtime: ${spec.runtime}`, `model: ${spec.model ?? "(default)"}`],
  });

  const handle = startLaunchSpec(spec, repoPath, {
    outputPath: getRunOutputPath(run),
  });

  run = await markRunActive(projectPaths, run, handle.pid);

  let result: LaunchResult;

  try {
    result = await handle.wait();
  } catch (error) {
    run = await finalizeRun({
      projectPaths,
      run,
      status: "failed",
      exitCode: null,
    });
    await writeRunResult(run, {
      assignmentStatusAfterExit: assignmentMessage?.attributes.status ?? null,
      assignmentResolvedByWorker: false,
      changedFiles: [],
      gitSummaryLines: ["runtime launch failed before exit"],
      finalVisibleOutput: "",
    });
    throw error;
  }

  const persistedRun = (await readRunRecord(run.path)) ?? run;
  const stopRequested = Boolean(persistedRun.stopRequestedAt);

  run = await finalizeRun({
    projectPaths,
    run: persistedRun,
    status: stopRequested
      ? "cancelled"
      : result.signal || (result.code !== null && result.code !== 0)
        ? "failed"
        : "exited",
    exitCode: result.code,
  });

  const afterGit = captureGitStatusSnapshot(repoPath);
  const gitDelta = diffGitStatusSnapshots(beforeGit, afterGit);
  const assignmentAfterExit = run.sourceMessage
    ? await findMessage(input.paths.msgDir, run.sourceMessage, input.activeProject)
    : null;

  await writeRunResult(run, {
    assignmentStatusAfterExit: assignmentAfterExit?.attributes.status ?? null,
    assignmentResolvedByWorker: assignmentAfterExit?.attributes.status === "resolved",
    changedFiles: gitDelta.changedFiles,
    gitSummaryLines: gitDelta.summaryLines,
    finalVisibleOutput: result.visibleOutput,
  });

  await appendFeedEntry(input.paths, {
    project: input.activeProject,
    headline: `${input.agentId} ${run.status}`,
    details: [
      `runtime: ${spec.runtime}`,
      `exit: ${result.code ?? "unknown"}${result.signal ? ` | signal: ${result.signal}` : ""}`,
    ],
  });

  if (run.status === "cancelled") {
    return `Cancelled ${input.agentId} via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""} [${run.runId}]`;
  }

  if (result.signal) {
    throw new UsageError(`Launch runtime exited due to ${result.signal}`);
  }

  if (result.code !== null && result.code !== 0) {
    throw new UsageError(`Launch runtime exited with status ${result.code}`);
  }

  return `Completed ${input.agentId} via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""} [${run.runId}]`;
}

export async function launchCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  return launchAgentPass({
    activeProject,
    paths,
    agentId: options.agentId,
    goal: options.goal,
    runtimeOverride: options.runtimeOverride,
    modelOverride: options.modelOverride,
    dryRun: options.dryRun,
    source: "hive launch",
  });
}
