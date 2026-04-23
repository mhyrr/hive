/**
 * Routes agent-spawning operations between Pi and Claude Code during
 * the hive-on-pi migration. See docs/specs/2026-04-22-hive-on-pi-design.md §5.
 *
 * Only paths that actually spawn an agent (interactive launch, dispatch,
 * heartbeat, campaign) consult this module. Local HIVE commands
 * (doctor, memory, ticket, etc.) are harness-agnostic.
 *
 * Selection priority:
 *   1. HIVE_HARNESS env var (set by -c flag or explicit export)
 *   2. Default: "pi"
 *
 * The CLI's -c / --claude-code flag sets HIVE_HARNESS=claude-code so
 * that deeply nested modules can consult resolveHarness() without
 * threading the flag through every function signature.
 */

export type Harness = "pi" | "claude-code";

export class HarnessNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `Pi harness not yet implemented for: ${operation}.\n` +
        `Use 'hive -c <cmd>' to route this invocation through Claude Code, ` +
        `or set HIVE_HARNESS=claude-code to route everything.`,
    );
    this.name = "HarnessNotImplementedError";
  }
}

export function resolveHarness(): Harness {
  const env = process.env.HIVE_HARNESS;
  if (env === "claude-code") return "claude-code";
  if (env === "pi") return "pi";
  return "pi";
}

/**
 * Pre-parse CLI args for the global harness flag.
 * Strips -c / --claude-code from the args list regardless of position
 * and returns the flag state plus the remaining args.
 */
export function extractHarnessFlag(args: string[]): {
  forceClaudeCode: boolean;
  remaining: string[];
} {
  const remaining: string[] = [];
  let forceClaudeCode = false;
  for (const a of args) {
    if (a === "-c" || a === "--claude-code") {
      forceClaudeCode = true;
    } else {
      remaining.push(a);
    }
  }
  return { forceClaudeCode, remaining };
}
