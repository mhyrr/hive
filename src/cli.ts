import { councilCommand } from "./commands/council";
import { dispatchCommand } from "./commands/dispatch";
import { initCommand } from "./commands/init";
import { memoryCommand } from "./commands/memory";
import { projectCommand } from "./commands/project";
import { psCommand } from "./commands/ps";
import { ticketCommand } from "./commands/ticket";
import { UsageError } from "./lib/errors";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  init: initCommand,
  project: projectCommand,
  council: councilCommand,
  memory: memoryCommand,
  ticket: ticketCommand,
  dispatch: dispatchCommand,
  ps: psCommand,
};

const usage = `Usage: hive <command> [args]

Commands:
  init                       Set up ~/.hive and register MCP server
  project add <name> <path>  Register a project
  council "<question>"       Multi-model council deliberation
  memory [view|fact|convention|decision|question] [text]
                             View or add project memory
  ticket [create|list|show|start|close|reopen|note|ready|blocked]
                             Project ticket tracker
  dispatch "<goal>" [--project <name>] [--ticket <id>] [--plan <path>]
                             Dispatch autonomous goal execution
  ps                         Show active and recent dispatch runs`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    console.log(usage);
    return;
  }

  const handler = commands[command];

  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    console.log(usage);
    process.exit(1);
  }

  try {
    await handler(args.slice(1));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
