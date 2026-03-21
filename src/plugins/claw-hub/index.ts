import { join } from "node:path";

import type { HivePlugin, PluginCommand } from "../../lib/plugins/types";
import { createHubCommands } from "./commands";
import { createHubTools } from "./tool";
import { resolveHiveHome } from "../../lib/paths";

async function readGlobalConfig(hiveHome: string): Promise<string> {
  try {
    const file = Bun.file(join(hiveHome, "config.md"));

    return await file.text();
  } catch {
    return "";
  }
}

/**
 * Build commands that read config lazily (at execution time, not at import time).
 * Each command wraps the real command with a config read.
 */
function createLazyCommands(): PluginCommand[] {
  const subcommandNames = ["search", "install", "list", "info", "remove", "sync"];

  return subcommandNames.map((name) => ({
    name,
    description: "", // Description comes from the real command at routing time
    async execute(args: string[]) {
      const hiveHome = resolveHiveHome();
      const globalConfig = await readGlobalConfig(hiveHome);
      const realCommands = createHubCommands({
        skillsDir: join(hiveHome, "skills"),
        globalConfig,
      });
      const cmd = realCommands.find((c) => c.name === name);

      if (!cmd) {
        return `Unknown subcommand: ${name}`;
      }

      return cmd.execute(args);
    },
  }));
}

export const clawHubPlugin: HivePlugin = {
  name: "hub",
  version: "0.1.0",
  description: "Search, install, and manage skills from the Claw Hub",
  commands: createLazyCommands(),

  tools(ctx) {
    return createHubTools(ctx);
  },
};
