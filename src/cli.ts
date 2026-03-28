import { archiveCommand } from "./commands/archive";
import { dreamCommand } from "./commands/dream";
import { goalCommand } from "./commands/goal";
import { approvalCommand } from "./commands/approval";
import { cognitionCommand } from "./commands/cognition";
import { councilCommand } from "./commands/council";
import { consoleCommand } from "./commands/console";
import { eventsCommand } from "./commands/events";
import { feedCommand, watchCommand } from "./commands/feed";
import { gatewayCommand, startCommand } from "./commands/gateway";
import { helpCommand } from "./commands/help";
import { inboxCommand } from "./commands/inbox";
import { initCommand } from "./commands/init";
import { launchCommand } from "./commands/launch";
import { logCommand } from "./commands/log";
import { memoryCommand } from "./commands/memory";
import { msgCommand } from "./commands/msg";
import { psCommand } from "./commands/ps";
import { projectCommand } from "./commands/project";
import { runtimesCommand } from "./commands/runtimes";
import { promptCommand } from "./commands/prompt";
import { runCommand } from "./commands/run";
import { sayCommand } from "./commands/say";
import { statusCommand } from "./commands/status";
import { stopCommand } from "./commands/stop";
import { superviseCommand } from "./commands/supervise";
import { syncCommand } from "./commands/sync";
import { thinkCommand } from "./commands/think";
import { workCommand } from "./commands/work";
import { UsageError } from "./lib/errors";
import { routePluginCommand } from "./lib/plugins";

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
    case "start":
      return startCommand(rest);
    case "init":
      return initCommand(rest);
    case "project":
      return projectCommand(rest);
    case "work":
      return workCommand(rest);
    case "cognition":
      return cognitionCommand();
    case "console":
      return consoleCommand(rest);
    case "feed":
      return feedCommand(rest);
    case "events":
      return eventsCommand(rest);
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
    case "memory":
      return memoryCommand(rest);
    case "approval":
      return approvalCommand(rest);
    case "msg":
      return msgCommand(rest);
    case "nudge":
      return msgCommand(["nudge", ...rest]);
    case "prompt":
      return promptCommand(rest);
    case "runtimes":
      return runtimesCommand();
    case "gateway":
      return gatewayCommand(rest);
    case "archive":
      return archiveCommand();
    case "sync":
      return syncCommand();
    case "think":
      return thinkCommand(rest);
    case "council":
      return councilCommand(rest);
    case "dream":
      return dreamCommand(rest);
    case "goal":
      return goalCommand(rest);
    default: {
      const pluginResult = await routePluginCommand(command ?? "", rest);

      if (pluginResult !== null) {
        return pluginResult;
      }

      throw new UsageError(`Unknown command: ${command}`);
    }
  }
}
