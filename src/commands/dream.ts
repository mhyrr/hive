import { existsSync } from "node:fs";
import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { createGoal, writeGoalRecord } from "../lib/goals";
import { planGoalToGraph } from "../lib/orchestrator";
import { ensureHiveScaffold, getActiveProject, getProjectPaths, goalWorkGraphPath } from "../lib/paths";
import { enqueueGoalForOrchestrator } from "../lib/steward/prompts";

type DreamOptions = {
  goal: string;
};

function parseOptions(args: string[]): DreamOptions {
  const usage =
    'Usage: hive dream [--from <spec>] "<goal>"';

  let goal: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--from") {
      const filePath = args[i + 1];
      i++;

      if (!filePath) {
        throw new UsageError(`--from requires a file path\n${usage}`);
      }

      goal = `__FROM_FILE__:${filePath}`;
      continue;
    }

    // Preserve backward compat: ignore removed flags
    if (arg === "--dry-run" || arg === "--go") {
      continue;
    }

    positional.push(arg);
  }

  const positionalGoal = positional.join(" ").trim();

  if (positionalGoal) {
    goal = positionalGoal;
  }

  if (!goal) {
    throw new UsageError(`No goal provided\n${usage}`);
  }

  return { goal };
}

async function resolveGoal(raw: string): Promise<string> {
  if (raw.startsWith("__FROM_FILE__:")) {
    const filePath = raw.slice("__FROM_FILE__:".length);

    try {
      const text = await Bun.file(filePath).text();
      const resolved = text.trim();

      if (!resolved) {
        throw new UsageError(`Goal file is empty: ${filePath}`);
      }

      return resolved;
    } catch (err) {
      if (err instanceof UsageError) throw err;
      throw new UsageError(`Cannot read goal file: ${filePath}`);
    }
  }

  return raw;
}

async function launchSupervisor(binaryPath: string): Promise<void> {
  const proc = Bun.spawn(
    [binaryPath, "supervise", "--detach"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  proc.unref?.();
}

/**
 * `hive dream "<goal>"` — create an autonomous goal execution graph.
 */
export async function dreamCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const goal = await resolveGoal(options.goal);

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  // Create a goal record
  const goalRecord = await createGoal(projectPaths.goalsDir, goal);

  // Decompose goal into a work graph via LLM
  let graphSummary = "";
  try {
    const projectConfig = await Bun.file(projectPaths.config).text().catch(() => "");
    const graph = await planGoalToGraph({
      goalId: goalRecord.id,
      goal,
      stateWorkGraph: goalWorkGraphPath(projectPaths, goalRecord.id),
      projectConfig,
    });
    goalRecord.plan = graph.tasks
      .map((t, i) => `${i + 1}. [${t.persona}/${t.model}] ${t.title}`)
      .join("\n");
    goalRecord.updatedAt = new Date().toISOString();
    await writeGoalRecord(projectPaths.goalsDir, goalRecord);
    graphSummary = `\nDecomposed into ${graph.tasks.length} task(s):\n${graph.tasks
      .map((t, i) => `  ${i + 1}. ${t.title} (${t.persona}/${t.model})`)
      .join("\n")}`;
  } catch (err) {
    graphSummary = `\n(Goal decomposition failed: ${String(err)} — steward will plan manually)`;
    await enqueueGoalForOrchestrator(
      paths,
      projectPaths,
      activeProject,
      `Plan and execute this goal:\n\n${goal}\n\nDecompose it into parallel tasks, then delegate each one to workers.`,
    );
  }

  // Start supervisor (detached, idempotent)
  const hiveBinary = join(import.meta.dir, "..", "..", "hive");
  const binaryExists = existsSync(hiveBinary);

  if (binaryExists) {
    await launchSupervisor(hiveBinary);
  }

  return [
    `Goal created: ${goalRecord.id}`,
    `Work graph built for autonomous execution.${graphSummary}`,
    !binaryExists ? "Start supervisor: hive supervise --detach" : "",
    "The supervisor will advance the work graph on its next tick.",
  ]
    .filter(Boolean)
    .join("\n");
}
