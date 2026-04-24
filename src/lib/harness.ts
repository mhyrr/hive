/**
 * Routes agent-spawning operations between Claude Code and Pi.
 * See docs/specs/2026-04-22-hive-on-pi-design.md §5.
 *
 * Only paths that actually spawn an agent (interactive launch) consult
 * this module. Local HIVE commands (doctor, memory, ticket, etc.) and
 * dispatch/heartbeat are harness-agnostic.
 *
 * Selection priority:
 *   1. HIVE_HARNESS env var (set by -3 flag or explicit export)
 *   2. Default: "claude-code"
 *
 * The CLI's -3 / --pi flag sets HIVE_HARNESS=pi so that deeply nested
 * modules can consult resolveHarness() without threading the flag
 * through every function signature.
 */

export type Harness = "pi" | "claude-code";

export class HarnessNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `Pi harness not yet implemented for: ${operation}.\n` +
        `Drop the -3 flag (or unset HIVE_HARNESS) to route through Claude Code.`,
    );
    this.name = "HarnessNotImplementedError";
  }
}

export function resolveHarness(): Harness {
  const env = process.env.HIVE_HARNESS;
  if (env === "pi") return "pi";
  if (env === "claude-code") return "claude-code";
  return "claude-code";
}

/**
 * Pre-parse CLI args for the global harness flag.
 * Strips -3 / --pi from the args list regardless of position
 * and returns the flag state plus the remaining args.
 */
export function extractHarnessFlag(args: string[]): {
  forcePi: boolean;
  remaining: string[];
} {
  const remaining: string[] = [];
  let forcePi = false;
  for (const a of args) {
    if (a === "-3" || a === "--pi") {
      forcePi = true;
    } else {
      remaining.push(a);
    }
  }
  return { forcePi, remaining };
}
