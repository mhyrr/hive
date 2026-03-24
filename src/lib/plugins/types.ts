import type { Tool } from "@mariozechner/pi-ai";

export type PluginTool = Tool & {
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<string>;
};

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
  tools?: (ctx: PluginToolContext) => PluginTool[];
};
