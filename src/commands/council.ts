import { extractConfigValue } from "../lib/config";
import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import {
  conveneCouncil,
  conveneDialectic,
  formatCouncilResultsForSteward,
  formatDialecticResultsForSteward,
  resolveCouncilMembers,
  clampRounds,
  type Camp,
} from "../lib/council";
import { parseModelPool } from "../lib/project";

export async function councilCommand(args: string[]): Promise<void> {
  const usage = [
    'Usage: hive council [options] "<question>"',
    "",
    "Options:",
    "  --models opus,sonnet,gpt54   Models to consult (default: all)",
    "  --persona analyst             Analytical framing (standard mode)",
    "  --mode dialectic              Adversarial multi-round debate",
    '  --camps \'[{"name":"..","position":".."},..]\'  Camps for dialectic (JSON)',
    "  --rounds 3                    Dialectic rounds (1-5, default 3)",
    "  --format json                 Machine-readable output",
  ].join("\n");

  let modelNames: string[] | null = null;
  let persona: string | null = null;
  let mode: "standard" | "analyst" | "dialectic" = "standard";
  let campsJson: string | null = null;
  let rounds: number | null = null;
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
    if (arg === "--mode") {
      const value = args[++i];
      if (value === "dialectic") mode = "dialectic";
      else if (value === "analyst") mode = "analyst";
      else if (value === "standard") mode = "standard";
      else throw new UsageError(`Unknown mode '${value}'. Use standard, analyst, or dialectic.\n${usage}`);
      continue;
    }
    if (arg === "--camps") {
      campsJson = args[++i] ?? null;
      continue;
    }
    if (arg === "--rounds") {
      const value = args[++i];
      if (value) rounds = parseInt(value, 10);
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

  // Parse camps for dialectic mode
  let camps: Camp[] | null = null;
  if (mode === "dialectic") {
    if (!campsJson) throw new UsageError(`Dialectic mode requires --camps\n${usage}`);
    try {
      camps = JSON.parse(campsJson) as Camp[];
    } catch {
      // intentional: JSON.parse failure means bad user input — rethrow as UsageError
      throw new UsageError(`Invalid --camps JSON: ${campsJson}\n${usage}`);
    }
    if (!Array.isArray(camps) || camps.length < 2) {
      throw new UsageError(`Dialectic mode requires at least 2 camps.\n${usage}`);
    }
  }

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

  // Dialectic mode
  if (mode === "dialectic" && camps) {
    const numRounds = clampRounds(rounds);
    console.log(`Convening dialectic with ${members.length} members, ${camps.length} camps, ${numRounds} rounds`);
    console.log(`Camps: ${camps.map((c) => `${c.name} ("${c.position}")`).join(" vs. ")}`);
    console.log();

    const result = await conveneDialectic({
      question,
      camps,
      members,
      globalConfig,
      rounds: numRounds,
    });

    if (format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const output = formatDialecticResultsForSteward(result);
    console.log(output);

    const allPositions = result.rounds.flatMap((r) => r.positions);
    const failed = allPositions.filter((p) => p.error);
    if (failed.length > 0) {
      console.log();
      console.log(`Failed: ${failed.map((p) => `${p.modelName} (round ${p.roundNumber}): ${p.error}`).join("; ")}`);
    }
    return;
  }

  // Standard / analyst mode
  const resolvedPersona = mode === "analyst" ? "analyst" : persona;
  console.log(`Convening council with ${members.length} members: ${members.map((m) => m.model.name).join(", ")}`);
  console.log();

  const result = await conveneCouncil({
    question,
    members,
    globalConfig,
    persona: resolvedPersona,
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
