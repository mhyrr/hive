import { archiveCommand } from "./commands/archive";
import { helpCommand } from "./commands/help";
import { initCommand } from "./commands/init";
import { logCommand } from "./commands/log";
import { msgCommand, nudgeCommand } from "./commands/msg";
import { promptCommand } from "./commands/prompt";
import { statusCommand } from "./commands/status";
import { syncCommand } from "./commands/sync";
import { workCommand } from "./commands/work";
import { UsageError } from "./lib/errors";

export async function runCli(args: string[]): Promise<string> {
  const [command, ...rest] = args;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return helpCommand();
    case "init":
      return initCommand(rest);
    case "work":
      return workCommand(rest);
    case "status":
      return statusCommand();
    case "log":
      return logCommand(rest);
    case "msg":
      return msgCommand(rest);
    case "nudge":
      return nudgeCommand(rest);
    case "prompt":
      return promptCommand(rest);
    case "archive":
      return archiveCommand();
    case "sync":
      return syncCommand();
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}
