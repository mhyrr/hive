import { UsageError } from "../lib/errors";
import { assembleIdentity } from "../lib/identity";
import type { Harness } from "../lib/stack";

const VALID_HARNESSES: ReadonlySet<Harness> = new Set(["claude", "codex", "pi"]);

export async function identityCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive identity emit [--harness claude|codex|pi] [--persona <name>]
      Print the canonical identity prefix to stdout. Used by the SessionStart
      hook so that interactive, dispatch, and heartbeat all share one source
      of truth. --harness only affects stack-hint wording (Codex has no Skill
      tool, so it gets a direct "read the file" variant). Defaults to claude.
      --persona selects the swappable register from ~/.hive/personas/<name>.md
      (falls back to HIVE_PERSONA env, then greg-dry). emit is an interactive
      path, so it always includes the persona slot.`;

  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(usage);
    return;
  }

  if (subcommand !== "emit") {
    throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }

  let harness: Harness | undefined;
  let persona: string | undefined;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--harness" && rest[i + 1]) {
      const value = rest[++i]!;
      if (!VALID_HARNESSES.has(value as Harness)) {
        throw new UsageError(`Unknown harness '${value}'. Valid: claude, codex, pi.`);
      }
      harness = value as Harness;
    } else if (arg === "--persona" && rest[i + 1]) {
      persona = rest[++i]!;
    } else if (arg.startsWith("--persona=")) {
      persona = arg.slice("--persona=".length);
    } else {
      throw new UsageError(`Unknown flag: ${arg}\n\n${usage}`);
    }
  }

  const content = await assembleIdentity({ harness, includePersona: true, persona });
  process.stdout.write(content);
}
