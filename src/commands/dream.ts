import { existsSync } from "node:fs";
import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { ensureHiveScaffold, getActiveProject, getProjectPaths } from "../lib/paths";
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
 * `hive dream "<goal>"` — send a goal to the steward.
 *
 * The steward uses its plan_goal tool to decompose the goal into tasks,
 * then delegates each task to workers using the delegate tool.
 * No more separate Sonnet planning pipeline.
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

  // Send goal to the steward as a nudge message.
  // The steward will plan_goal → delegate on its next turn.
  const goalMessage = `Plan and execute this goal:\n\n${goal}\n\nUse plan_goal to decompose it, then delegate each task to workers.`;
  const filename = await enqueueGoalForOrchestrator(
    paths,
    projectPaths,
    activeProject,
    goalMessage,
  );

  // Write goal file if HIVE-019 goals dir exists
  if (existsSync(projectPaths.goalsDir)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const goalPath = join(projectPaths.goalsDir, `${ts}-dream.md`);
    await Bun.write(goalPath, `# Dream Goal\n\n${goal.trim()}\n`);
  }

  // Start supervisor (detached, idempotent)
  const hiveBinary = join(import.meta.dir, "..", "..", "hive");
  const binaryExists = existsSync(hiveBinary);

  if (binaryExists) {
    await launchSupervisor(hiveBinary);
  }

  return [
    `Goal queued for steward (${filename}).`,
    "The steward will plan and delegate on its next turn.",
    !binaryExists ? "Start supervisor: hive supervise --detach" : "",
  ]
    .filter(Boolean)
    .join("\n");
}
