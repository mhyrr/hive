export type Harness = "claude-code" | "codex";

export interface HarnessSelection {
  harness: Harness;
  remainingArgs: string[];
}

export function resolveHarness(args: string[]): HarnessSelection {
  const remaining: string[] = [];
  let harness: Harness =
    process.env.HIVE_HARNESS === "codex" ? "codex" : "claude-code";

  for (const arg of args) {
    if (arg === "-x" || arg === "--codex") {
      harness = "codex";
      continue;
    }
    if (arg === "--claude" || arg === "--claude-code") {
      harness = "claude-code";
      continue;
    }
    remaining.push(arg);
  }

  return { harness, remainingArgs: remaining };
}
