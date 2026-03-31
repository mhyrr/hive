import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { councilCommand } from "./commands/council";
import { dispatchCommand } from "./commands/dispatch";
import { initCommand } from "./commands/init";
import { memoryCommand } from "./commands/memory";
import { projectCommand } from "./commands/project";
import { psCommand } from "./commands/ps";
import { ticketCommand } from "./commands/ticket";
import { UsageError } from "./lib/errors";
import { writeIdentityTempFile, cleanupIdentityTempFile } from "./lib/identity";

const hiveCommands: Record<string, (args: string[]) => Promise<void>> = {
  init: initCommand,
  project: projectCommand,
  council: councilCommand,
  memory: memoryCommand,
  ticket: ticketCommand,
  dispatch: dispatchCommand,
  ps: psCommand,
};

const usage = `Usage: hive [command] [args]

When called with a HIVE command, runs that command directly.
When called with anything else (or no args), launches Claude as Maya.

HIVE Commands:
  init                       Set up ~/.hive and register MCP server
  project add <name> <path>  Register a project
  council "<question>"       Multi-model council deliberation
  memory [view|fact|...]     View or add project memory
  ticket [create|list|...]   Project ticket tracker
  dispatch "<goal>" [opts]   Dispatch autonomous goal execution
  ps                         Show active and recent dispatch runs

Maya (Claude with identity):
  hive                       Interactive Maya session
  hive "fix the auth bug"    Maya with a prompt
  hive --agent maya-coder    Maya with a specific agent
  hive [any claude flags]    Passed through to claude with identity`;

function findClaude(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not find claude CLI. Is it installed?");
  }
}

async function launchMaya(args: string[]): Promise<void> {
  const identityFile = await writeIdentityTempFile();

  // Clean up on exit
  process.on("exit", cleanupIdentityTempFile);
  process.on("SIGINT", () => { cleanupIdentityTempFile(); process.exit(130); });
  process.on("SIGTERM", () => { cleanupIdentityTempFile(); process.exit(143); });

  const claude = findClaude();

  // Build claude args: identity injection + user args
  const claudeArgs = [
    "--append-system-prompt-file", identityFile,
    "--add-dir", join(process.env.HOME || "", ".hive"),
    ...args,
  ];

  // Replace this process with claude
  const result = Bun.spawnSync([claude, ...claudeArgs], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: undefined, // force subscription
    },
  });

  cleanupIdentityTempFile();
  process.exit(result.exitCode ?? 0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // No args → interactive Maya session
  if (!command) {
    await launchMaya([]);
    return;
  }

  // Help
  if (command === "help" || command === "--help") {
    console.log(usage);
    return;
  }

  // Known HIVE command → handle directly
  const handler = hiveCommands[command];
  if (handler) {
    try {
      await handler(args.slice(1));
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  // Everything else → pass through to claude as Maya
  await launchMaya(args);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
