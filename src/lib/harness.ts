export type Harness = "claude-code" | "codex" | "pi";

/**
 * Claude Code prompt-injection mode.
 *
 * - "append": HIVE identity is appended after Claude Code's default system
 *   prompt (current default; uses --append-system-prompt-file).
 * - "owned": HIVE replaces the default system prompt entirely via
 *   --system-prompt-file. Hooks, skills, MCP, and subscription OAuth still work.
 * - "bare": Full --bare mode. Skips hooks/plugins/CLAUDE.md auto-discovery.
 *   Requires ANTHROPIC_API_KEY (OAuth and keychain are never read in --bare).
 *   HIVE MCP is wired explicitly via --mcp-config.
 *
 * Only meaningful for `harness: "claude-code"`.
 */
export type ClaudeMode = "append" | "owned" | "bare";

export interface HarnessSelection {
  harness: Harness;
  claudeMode: ClaudeMode;
  remainingArgs: string[];
}

export function resolveHarness(args: string[]): HarnessSelection {
  const remaining: string[] = [];
  let harness: Harness = "claude-code";
  let claudeMode: ClaudeMode = "append";
  if (process.env.HIVE_HARNESS === "codex") harness = "codex";
  if (process.env.HIVE_HARNESS === "pi") harness = "pi";
  if (process.env.HIVE_CLAUDE_MODE === "owned") claudeMode = "owned";
  if (process.env.HIVE_CLAUDE_MODE === "bare") claudeMode = "bare";

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
    if (arg === "--owned") {
      claudeMode = "owned";
      continue;
    }
    if (arg === "--bare") {
      claudeMode = "bare";
      continue;
    }
    remaining.push(arg);
  }

  return { harness, claudeMode, remainingArgs: remaining };
}
