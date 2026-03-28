import { UsageError } from "../lib/errors";
import { ensureHiveScaffold, getActiveProject, getProjectPaths } from "../lib/paths";
import { enqueueGoalForOrchestrator } from "../lib/steward/prompts";

type CouncilOptions = {
  question: string;
  models: string[] | null;
};

function parseOptions(args: string[]): CouncilOptions {
  const usage =
    'Usage: hive council [--models opus,sonnet,gpt54] "<question>"';

  let models: string[] | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--models" || arg === "-m") {
      const value = args[i + 1];
      i++;

      if (!value) {
        throw new UsageError(`--models requires a comma-separated list\n${usage}`);
      }

      models = value.split(",").map((m) => m.trim()).filter(Boolean);
      continue;
    }

    positional.push(arg);
  }

  const question = positional.join(" ").trim();

  if (!question) {
    throw new UsageError(`No question provided\n${usage}`);
  }

  return { question, models };
}

/**
 * `hive council "<question>"` — convene a model council via the steward.
 *
 * Sends a nudge to the steward instructing it to use convene_council
 * for multi-model deliberation on the given question.
 */
export async function councilCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  const modelClause = options.models
    ? `Use these models: ${options.models.join(", ")}.`
    : "Use at least 3 diverse models from the pool.";

  const goalMessage = [
    `Convene a model council on this question:`,
    "",
    options.question,
    "",
    `${modelClause} Use the convene_council tool to get independent positions from each model, then synthesize a unified answer as chair. Surface agreement, disagreement, and why it matters.`,
  ].join("\n");

  const filename = await enqueueGoalForOrchestrator(
    paths,
    projectPaths,
    activeProject,
    goalMessage,
  );

  return [
    `Council request queued for steward (${filename}).`,
    `Question: ${options.question}`,
    options.models ? `Models: ${options.models.join(", ")}` : "Models: steward will choose from pool",
    "The steward will convene the council on its next turn.",
  ].join("\n");
}
