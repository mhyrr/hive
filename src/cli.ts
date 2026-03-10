import { archiveCommand } from "./commands/archive";
import { askCommand } from "./commands/ask";
import { chatCommand } from "./commands/chat";
import { feedCommand, watchCommand } from "./commands/feed";
import { helpCommand } from "./commands/help";
import { inboxCommand } from "./commands/inbox";
import { initCommand } from "./commands/init";
import { launchCommand } from "./commands/launch";
import { logCommand } from "./commands/log";
import { msgCommand, nudgeCommand } from "./commands/msg";
import { orchestrateCommand } from "./commands/orchestrate";
import { psCommand } from "./commands/ps";
import { projectCommand } from "./commands/project";
import { promptCommand } from "./commands/prompt";
import { runCommand } from "./commands/run";
import { sayCommand } from "./commands/say";
import { statusCommand } from "./commands/status";
import { stopCommand } from "./commands/stop";
import { superviseCommand } from "./commands/supervise";
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
    case "run":
      return runCommand(rest);
    case "say":
      return sayCommand(rest);
    case "ask":
      return askCommand(rest);
    case "init":
      return initCommand(rest);
    case "project":
      return projectCommand(rest);
    case "work":
      return workCommand(rest);
    case "orchestrate":
      return orchestrateCommand(rest);
    case "chat":
      return chatCommand(rest);
    case "feed":
      return feedCommand(rest);
    case "watch":
      return watchCommand(rest);
    case "supervise":
      return superviseCommand(rest);
    case "launch":
      return launchCommand(rest);
    case "ps":
      return psCommand();
    case "stop":
      return stopCommand(rest);
    case "inbox":
      return inboxCommand(rest);
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
