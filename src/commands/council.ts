import { extractConfigValue } from "../lib/config";
import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import {
  conveneCouncil,
  formatCouncilResultsForSteward,
  resolveCouncilMembers,
} from "../lib/council";
import { parseModelPool } from "../lib/project";

export async function councilCommand(args: string[]): Promise<void> {
  const usage = 'Usage: hive council [--models opus,sonnet,gpt54] [--persona analyst] [--format json] "<question>"';

  let modelNames: string[] | null = null;
  let persona: string | null = null;
  let format: "markdown" | "json" = "markdown";
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--models" || arg === "-m") {
      const value = args[++i];
      if (!value) throw new UsageError(`--models requires a comma-separated list\n${usage}`);
      modelNames = value.split(",").map((m) => m.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--persona") {
      persona = args[++i] ?? null;
      continue;
    }
    if (arg === "--format") {
      const value = args[++i];
      if (value === "json") format = "json";
      continue;
    }
    positional.push(arg);
  }

  const question = positional.join(" ").trim();
  if (!question) throw new UsageError(`No question provided\n${usage}`);

  const paths = await ensureHiveScaffold();
  const globalConfig = await Bun.file(paths.config).text().catch(() => "");

  // Resolve models — use explicit --models, or council-default config, or full pool
  const pool = parseModelPool(globalConfig);
  const defaultModels = extractConfigValue(globalConfig, "council-default");
  const names = modelNames
    ?? (defaultModels ? defaultModels.split(",").map((m) => m.trim()).filter(Boolean) : null)
    ?? pool.map((e) => e.name);
  const { members, errors } = resolveCouncilMembers(globalConfig, names);

  if (members.length < 2) {
    throw new UsageError(
      `Need at least 2 council members, got ${members.length}. ${errors.join(" ")} Available: ${pool.map((e) => e.name).join(", ")}`,
    );
  }

  console.log(`Convening council with ${members.length} members: ${members.map((m) => m.model.name).join(", ")}`);
  console.log();

  const result = await conveneCouncil({
    question,
    members,
    globalConfig,
    persona,
  });

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const output = formatCouncilResultsForSteward(result);
  console.log(output);

  const failed = result.positions.filter((p) => p.error);
  if (failed.length > 0) {
    console.log();
    console.log(`Failed: ${failed.map((p) => `${p.modelName}: ${p.error}`).join("; ")}`);
  }
}
