import { join } from "node:path";

import type { HivePlugin, PluginTool, PluginToolContext } from "./types";
import { resolveHiveHome } from "../paths";

/**
 * Lazily load all registered plugins. Dynamic import breaks the circular
 * dependency between steward/tools → plugins/registry → claw-hub → pi-ai.
 */
async function loadPlugins(): Promise<HivePlugin[]> {
  const { clawHubPlugin } = await import("../../plugins/claw-hub/index");

  return [clawHubPlugin as HivePlugin];
}

/**
 * Check whether a plugin is enabled in the global config.
 * Plugins are disabled by default — the config must contain
 * `<plugin-name>: enabled` to activate one.
 */
function isPluginEnabled(pluginName: string, globalConfig: string): boolean {
  const pattern = new RegExp(`^${pluginName}:\\s*enabled\\s*$`, "m");

  return pattern.test(globalConfig);
}

async function readGlobalConfig(): Promise<string> {
  try {
    const file = Bun.file(join(resolveHiveHome(), "config.md"));

    if (!(await file.exists())) {
      return "";
    }

    return await file.text();
  } catch {
    return "";
  }
}

/**
 * Route a CLI command to a plugin. Returns the output string if handled,
 * or null if no plugin matched the command name.
 */
export async function routePluginCommand(
  command: string,
  args: string[],
): Promise<string | null> {
  const allPlugins = await loadPlugins();
  const plugin = allPlugins.find((p) => p.name === command);

  if (!plugin) {
    return null;
  }

  const globalConfig = await readGlobalConfig();

  if (!isPluginEnabled(plugin.name, globalConfig)) {
    return [
      `The "${plugin.name}" plugin is installed but not enabled.`,
      "",
      `To enable it, add this line to your hive config (~/.hive/config.md):`,
      "",
      `  ${plugin.name}: enabled`,
    ].join("\n");
  }

  if (!plugin.commands) {
    return `Plugin "${plugin.name}" has no CLI commands.`;
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

/**
 * Collect steward tools from enabled plugins only.
 */
export async function getPluginTools(ctx: PluginToolContext): Promise<PluginTool[]> {
  const allPlugins = await loadPlugins();
  const tools: PluginTool[] = [];

  for (const plugin of allPlugins) {
    if (isPluginEnabled(plugin.name, ctx.globalConfig) && plugin.tools) {
      tools.push(...plugin.tools(ctx));
    }
  }

  return tools;
}
