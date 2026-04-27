import { UsageError } from "../lib/errors";
import { assembleIdentity } from "../lib/identity";

export async function identityCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive identity emit
      Print the canonical identity prefix to stdout. Used by the SessionStart
      hook so that interactive, dispatch, and heartbeat all share one source
      of truth.`;

  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(usage);
    return;
  }

  if (subcommand !== "emit") {
    throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }

  if (args.length > 1) {
    throw new UsageError(`Unknown flags: ${args.slice(1).join(" ")}\n\n${usage}`);
  }

  const content = await assembleIdentity();
  process.stdout.write(content);
}
