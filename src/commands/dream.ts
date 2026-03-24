import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { createMessage } from "../lib/messages";
import { ensureHiveScaffold, getActiveProject, getProjectPaths } from "../lib/paths";
import { planGoal, type DreamPlan, type PlannedTask } from "../lib/dream-planner";
import { extractRepoPath } from "../lib/project";

type DreamOptions = {
  goal: string;
  dryRun: boolean;
  go: boolean;
};

function parseOptions(args: string[]): DreamOptions {
  const usage =
    'Usage: hive dream [--from <spec>] [--dry-run] [--go] "<goal>"';

  let goal: string | null = null;
  let dryRun = false;
  let go = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--go") {
      go = true;
      continue;
    }

    if (arg === "--from") {
      const filePath = args[i + 1];
      i++;

      if (!filePath) {
        throw new UsageError(`--from requires a file path\n${usage}`);
      }

      try {
        goal = Bun.file(filePath).text() as unknown as string;
        // Bun.file().text() is async; handle below after parse
        // Mark it as a special sentinel to resolve async
        goal = `__FROM_FILE__:${filePath}`;
      } catch {
        throw new UsageError(`Cannot read goal file: ${filePath}`);
      }

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

  return { goal, dryRun, go };
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

function formatPlan(plan: DreamPlan): string {
  const lines: string[] = [];

  lines.push("━━━ DREAM PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("");
  lines.push(`  Goal: ${plan.goal}`);
  lines.push("");
  lines.push(`  ${plan.summary}`);
  lines.push("");
  lines.push(`  Tasks: ${plan.tasks.length}  |  Cost estimate: $${plan.costEstimateUsd.toFixed(2)}`);
  lines.push("");

  plan.tasks.forEach((task: PlannedTask, i: number) => {
    lines.push(`  ${i + 1}. [${task.agentId}] ${task.title}`);

    if (task.scope.length > 0) {
      lines.push(`     scope: ${task.scope.join(", ")}`);
    }

    lines.push(`     done: ${task.doneCondition}`);
    lines.push("");
  });

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return lines.join("\n");
}

async function askConfirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function writeGoalFile(goalsDir: string, goal: string): Promise<void> {
  if (!existsSync(goalsDir)) {
    return; // HIVE-019 not yet in place — skip gracefully
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const goalPath = join(goalsDir, `${ts}-dream.md`);

  await Bun.write(goalPath, `# Dream Goal\n\n${goal.trim()}\n`);
}

async function launchSupervisor(binaryPath: string): Promise<void> {
  // Best-effort: start detached supervisor. Ignore if already running.
  const proc = Bun.spawn(
    [binaryPath, "supervise", "--detach"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  // Give it a moment to start; don't wait for it to finish (it's detached)
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  proc.unref?.();
}

export async function dreamCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const goal = await resolveGoal(options.goal);

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const projectConfig = await Bun.file(projectPaths.config).text().catch(() => "");
  const repoPath = extractRepoPath(projectConfig) ?? undefined;

  // ── Phase 1: Plan ────────────────────────────────────────────────────────────

  console.log("[dream] planning...");

  const plan = await planGoal(goal, {
    hivePaths: paths,
    projectId: activeProject,
    projectPaths,
    repoPath,
  });

  console.log(formatPlan(plan));

  if (options.dryRun) {
    return "Dry run complete. No messages sent, no supervisor started.";
  }

  // ── Confirmation ────────────────────────────────────────────────────────────

  if (!options.go) {
    const confirmed = await askConfirm("Launch this plan?");

    if (!confirmed) {
      return "Aborted.";
    }
  }

  // ── Phase 2: Execute ─────────────────────────────────────────────────────────

  // Write goal file if HIVE-019 goals dir exists
  await writeGoalFile(projectPaths.goalsDir, goal);

  // Write assignment messages for each planned task
  for (const task of plan.tasks) {
    const scopeAttr = task.scope.length > 0 ? task.scope.join(",") : undefined;

    await createMessage(paths.msgDir, {
      from: "steward",
      to: task.agentId,
      type: "assign",
      project: activeProject,
      body: `# ${task.title}

${task.assignment}

## Done Condition

${task.doneCondition}`,
      attributes: scopeAttr ? { scope: scopeAttr, launch: "auto" } : { launch: "auto" },
    });
  }

  // Start supervisor (detached, idempotent)
  const hiveBinary = join(import.meta.dir, "..", "..", "hive");
  const binaryExists = existsSync(hiveBinary);

  if (binaryExists) {
    await launchSupervisor(hiveBinary);
  } else {
    console.log("[dream] note: local hive binary not found — start supervisor manually with `hive supervise --detach`");
  }

  // Phase 3: synthesis pass — see docs/OVERNIGHT-LAUNCH.md
  // TODO: When all tasks complete, run a synthesis pass that reads all results
  // and produces a morning handoff briefing. This requires the supervisor to
  // detect board completion and invoke a synthesis agent. Not yet implemented.

  return [
    `Launched. ${plan.tasks.length} assignment${plan.tasks.length === 1 ? "" : "s"} queued for ${activeProject}.`,
    "Workers are running. Come back later.",
    binaryExists ? "" : "Start supervisor: hive supervise --detach",
  ]
    .filter(Boolean)
    .join("\n");
}
