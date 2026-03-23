import type { Tool } from "@mariozechner/pi-ai";

import { createBashTool } from "./bash";
import { createDelegationTools } from "./delegate";
import { createFileTools, createStewardExecutionContext } from "./files";
import { createSearchTools } from "./search";

export type PersistentStewardTool = Tool & {
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<string>;
};

export async function buildPersistentStewardTools(input: {
  hiveHome: string;
  repoPath: string;
  msgDir: string;
  projectId: string;
  globalConfig: string;
}): Promise<PersistentStewardTool[]> {
  const execution = createStewardExecutionContext(input);

  const { getPluginTools } = await import("../../plugins");
  const pluginTools = await getPluginTools({
    hiveHome: input.hiveHome,
    skillsDir: `${input.hiveHome}/skills`,
    globalConfig: input.globalConfig,
  });

  return [
    ...createFileTools(execution),
    ...createSearchTools(execution),
    createBashTool(execution),
    ...createDelegationTools({
      msgDir: input.msgDir,
      projectId: input.projectId,
      globalConfig: input.globalConfig,
    }),
    ...pluginTools,
  ] as PersistentStewardTool[];
}
