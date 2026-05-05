export type Harness = "claude-code" | "codex" | "pi";

export interface HarnessSelection {
  harness: Harness;
  remainingArgs: string[];
}

export function resolveHarness(args: string[]): HarnessSelection {
  const remaining: string[] = [];
  let harness: Harness = "claude-code";
  if (process.env.HIVE_HARNESS === "codex") harness = "codex";
  if (process.env.HIVE_HARNESS === "pi") harness = "pi";

  for (const arg of args) {
    if (arg === "-x" || arg === "--codex") {
      harness = "codex";
      continue;
    }
    if (arg === "-3" || arg === "--pi") {
      harness = "pi";
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
