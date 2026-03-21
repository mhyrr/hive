import type { PersistentStewardTool } from "../steward/tools/index";

export type PluginCommand = {
  name: string;
  description: string;
  execute: (args: string[]) => Promise<string>;
};

export type PluginToolContext = {
  hiveHome: string;
  skillsDir: string;
  globalConfig: string;
};

export type HivePlugin = {
  name: string;
  version: string;
  description: string;

  /** CLI subcommands registered under `hive <plugin.name> <subcommand>`. */
  commands?: PluginCommand[];

  /** Steward tools merged into the steward's tool set at session start. */
  tools?: (ctx: PluginToolContext) => PersistentStewardTool[];
};
