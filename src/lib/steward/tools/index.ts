import type { Tool } from "@mariozechner/pi-ai";
import type { HivePaths } from "../../paths";

import { createBashTool } from "./bash";
import { createDelegationTools } from "./delegate";
import { createElicitationTools } from "./elicit";
import { createFileTools, createStewardExecutionContext } from "./files";
import { createInspectionTools } from "./inspect";
import { createPlanTools } from "./plan";
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
  hivePaths?: HivePaths;
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
    ...createElicitationTools({
      msgDir: input.msgDir,
      projectId: input.projectId,
    }),
    ...(input.hivePaths
      ? [
          ...createInspectionTools({
            hivePaths: input.hivePaths,
            projectId: input.projectId,
          }),
          ...createPlanTools({
            hivePaths: input.hivePaths,
            projectId: input.projectId,
          }),
        ]
      : []),
    ...pluginTools,
  ] as PersistentStewardTool[];
}
