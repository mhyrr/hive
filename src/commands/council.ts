import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import {
  conveneCouncil,
  formatCouncilResultsForSteward,
  resolveCouncilMembers,
} from "../lib/council";
import { parseModelPool } from "../lib/project";

export async function councilCommand(args: string[]): Promise<void> {
  const usage = 'Usage: hive council [--models opus,sonnet,gpt54] "<question>"';

  let modelNames: string[] | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--models" || arg === "-m") {
      const value = args[++i];
      if (!value) throw new UsageError(`--models requires a comma-separated list\n${usage}`);
      modelNames = value.split(",").map((m) => m.trim()).filter(Boolean);
      continue;
    }
    positional.push(arg);
  }

  const question = positional.join(" ").trim();
  if (!question) throw new UsageError(`No question provided\n${usage}`);

  const paths = await ensureHiveScaffold();
  const globalConfig = await Bun.file(paths.config).text().catch(() => "");

  // Resolve models from pool
  const pool = parseModelPool(globalConfig);
  const names = modelNames ?? pool.map((e) => e.name);
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
    persona: null,
  });

  const output = formatCouncilResultsForSteward(result);
  console.log(output);

  const failed = result.positions.filter((p) => p.error);
  if (failed.length > 0) {
    console.log();
    console.log(`Failed: ${failed.map((p) => `${p.modelName}: ${p.error}`).join("; ")}`);
  }
}
