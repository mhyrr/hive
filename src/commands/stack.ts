import { UsageError } from "../lib/errors";
import {
  initStack,
  listSourceSkills,
  listSourceStacks,
  listSyncedSkills,
  stackSourceDir,
  syncStack,
} from "../lib/stack";

const USAGE = `Usage:
  hive stack list              List available stacks and sync status
  hive stack init <name>       Scaffold a new stack source tree
  hive stack sync <name>       Copy stack skills into ~/.claude/skills/<name>-*`;

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function runList(): Promise<void> {
  const stacks = await listSourceStacks();
  if (stacks.length === 0) {
    console.log("No stacks found. Scaffold one with: hive stack init <name>");
    return;
  }

  for (const stack of stacks) {
    const source = await listSourceSkills(stack);
    const synced = await listSyncedSkills(stack);
    let status: string;
    if (source.length === 0) {
      status = "empty";
    } else if (synced.length === 0) {
      status = "not synced";
    } else if (arraysEqual(source, synced)) {
      status = "synced";
    } else {
      status = "drift";
    }

    console.log(`${stack}  (${source.length} skills, ${status})`);
    console.log(`  source: ${stackSourceDir(stack)}`);
    if (source.length > 0) {
      console.log(`  skills: ${source.join(", ")}`);
    }
  }
}

async function runInit(name: string | undefined): Promise<void> {
  if (!name) throw new UsageError("Usage: hive stack init <name>");
  const target = await initStack(name);
  console.log(`Initialized stack '${name}' at ${target}`);
  console.log(`Add skills under skills/<topic>/SKILL.md, then run: hive stack sync ${name}`);
}

async function runSync(name: string | undefined): Promise<void> {
  if (!name) throw new UsageError("Usage: hive stack sync <name>");
  const result = await syncStack(name);

  console.log(`Synced stack '${name}' → ${result.target}`);
  if (result.copied.length > 0) {
    console.log(`  copied: ${result.copied.join(", ")}`);
  }
  if (result.removed.length > 0) {
    console.log(`  removed (orphans): ${result.removed.join(", ")}`);
  }
  if (result.copied.length === 0 && result.removed.length === 0) {
    console.log("  (no skills in source)");
  }
  console.log("Skills take effect on next Claude Code session.");
}

export async function stackCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub) throw new UsageError(USAGE);

  switch (sub) {
    case "list":
      await runList();
      return;
    case "init":
      await runInit(args[1]);
      return;
    case "sync":
      await runSync(args[1]);
      return;
    default:
      throw new UsageError(`Unknown subcommand: ${sub}\n\n${USAGE}`);
  }
}
