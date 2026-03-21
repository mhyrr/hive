import type { PersistentStewardTool } from "../steward/tools/index";
import type { HivePlugin, PluginToolContext } from "./types";
import { clawHubPlugin } from "../../plugins/claw-hub/index";

const plugins: HivePlugin[] = [clawHubPlugin];

export function getPlugins(): HivePlugin[] {
  return plugins;
}

/**
 * Route a CLI command to a plugin. Returns the output string if handled,
 * or null if no plugin matched the command name.
 */
export async function routePluginCommand(
  command: string,
  args: string[],
): Promise<string | null> {
  for (const plugin of plugins) {
    if (plugin.name !== command || !plugin.commands) {
      continue;
    }

    const [subcommand, ...rest] = args;

    if (!subcommand) {
      const lines = [
        `${plugin.name} — ${plugin.description}`,
        "",
        "Commands:",
        ...plugin.commands.map((cmd) => `  ${cmd.name}  ${cmd.description}`),
      ];

      return lines.join("\n");
    }

    const cmd = plugin.commands.find((c) => c.name === subcommand);

    if (!cmd) {
      return `Unknown ${plugin.name} subcommand: ${subcommand}\nAvailable: ${plugin.commands.map((c) => c.name).join(", ")}`;
    }

    return cmd.execute(rest);
  }

  return null;
}

/**
 * Collect steward tools from all plugins.
 */
export function getPluginTools(ctx: PluginToolContext): PersistentStewardTool[] {
  const tools: PersistentStewardTool[] = [];

  for (const plugin of plugins) {
    if (plugin.tools) {
      tools.push(...plugin.tools(ctx));
    }
  }

  return tools;
}
