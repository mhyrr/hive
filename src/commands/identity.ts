import { UsageError } from "../lib/errors";
import { assembleIdentity } from "../lib/identity";
import { TASTE_DOMAIN_RE } from "../lib/taste";

export async function identityCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive identity emit [--taste <domain>]
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

  let tasteDomainHint: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--taste") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        throw new UsageError("--taste requires a domain (e.g. --taste prose)");
      }
      if (!TASTE_DOMAIN_RE.test(next)) {
        throw new UsageError(`Invalid taste domain '${next}'.`);
      }
      tasteDomainHint = next;
      i++;
      continue;
    }
    if (arg.startsWith("--taste=")) {
      const value = arg.slice("--taste=".length);
      if (!TASTE_DOMAIN_RE.test(value)) {
        throw new UsageError(`Invalid taste domain '${value}'.`);
      }
      tasteDomainHint = value;
      continue;
    }
    throw new UsageError(`Unknown flag: ${arg}\n\n${usage}`);
  }

  const content = await assembleIdentity({ tasteDomainHint });
  process.stdout.write(content);
}
