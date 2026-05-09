import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import { resolveProjectFromCwd } from "../lib/project";
import { gatherDecomposeContext } from "../lib/decompose-prompt";
import { runDecomposeLoop } from "../lib/decompose-loop";
import { liveClaudeCaller } from "../lib/decompose-run";
import {
  renderWriteResult,
  writeProposal,
  type WriteResult,
} from "../lib/decompose-write";
import { resolvePriority } from "../lib/decompose";
import { formatUsd } from "../lib/pricing";

const USAGE = `Usage:
  hive goal "<rough goal>" [options]

Options:
  --dry-run                Show proposal without creating tickets
  --project <name>         Override cwd-based project resolution
  --priority <P1|P2|P3>    Priority for the epic (children inherit). Default P2.
  --max-attempts <N>       Override default attempt cap (default 8)
  --max-cost <USD>         Override default spend cap (default 5)`;

export async function goalCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    console.log(USAGE);
    return;
  }

  // Parse: positional goal text + flags. Goal accumulates positional words
  // until the first flag.
  let projectOverride: string | null = null;
  let dryRun = false;
  let priorityRaw: string | undefined;
  let maxAttempts: number | undefined;
  let maxCostUsd: number | undefined;
  const goalParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--project" || a === "-p") {
      projectOverride = args[++i] ?? null;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--priority") {
      priorityRaw = args[++i];
    } else if (a === "--max-attempts") {
      maxAttempts = Number(args[++i]);
    } else if (a === "--max-cost") {
      maxCostUsd = Number(args[++i]);
    } else if (a.startsWith("--")) {
      throw new UsageError(`Unknown flag: ${a}\n\n${USAGE}`);
    } else {
      goalParts.push(a);
    }
  }

  const goal = goalParts.join(" ").trim();
  if (!goal) {
    throw new UsageError("Goal text is required.\n\n" + USAGE);
  }

  const paths = await ensureHiveScaffold();
  const projectId = projectOverride ?? resolveProjectFromCwd();
  if (!projectId) {
    throw new UsageError(
      "No project found. Register one with: hive project add <name> <path>",
    );
  }

  const priority = resolvePriority(priorityRaw);

  console.log(`Decomposing goal in project: ${projectId}`);
  console.log(`Goal: ${goal}`);
  if (dryRun) console.log("(dry-run — no tickets will be created)");
  console.log("");

  // Gather context — index, principles, search hits, open tickets.
  const context = await gatherDecomposeContext(paths, projectId, goal);

  // Run the OODA loop. Live claude on each LLM call.
  const result = await runDecomposeLoop({
    context,
    llm: liveClaudeCaller,
    maxAttempts,
    maxCostUsd,
    onAttempt: (a) => {
      const tag = a.orient
        ? `→ ${a.orient.decision}`
        : "→ valid";
      console.error(
        `  attempt ${a.attempt}: ${a.failures.length} failure(s) ${tag}  (${formatUsd(a.decomposeCostUsd + a.orientCostUsd)})`,
      );
    },
  });

  if (!result.ok) {
    console.error("");
    console.error(`Decomposition aborted: ${result.reason}`);
    console.error(`Attempts: ${result.attempts.length}`);
    console.error(`Spent: ${formatUsd(result.totalCostUsd)}`);
    if (result.lastOutput) {
      console.error("");
      console.error("Last decomposer output (first 1000 chars):");
      console.error(result.lastOutput.slice(0, 1000));
    }
    throw new UsageError(`Goal decomposition failed.`);
  }

  // Success — write or dry-run.
  let written: WriteResult;
  try {
    written = await writeProposal(paths, projectId, result.proposal, {
      priority,
      dryRun,
    });
  } catch (err) {
    throw new UsageError(
      `Writer failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log("");
  if (dryRun) {
    console.log("PROPOSED TICKETS (dry-run, no writes):");
  } else {
    console.log("CREATED:");
  }
  console.log(renderWriteResult(written));

  if (result.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  console.log("");
  console.log(
    `Done. ${result.attempts.length} attempt(s), ${formatUsd(result.totalCostUsd)}.`,
  );
}
