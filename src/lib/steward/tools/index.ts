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

export function buildPersistentStewardTools(input: {
  hiveHome: string;
  repoPath: string;
  msgDir: string;
  projectId: string;
  globalConfig: string;
}): PersistentStewardTool[] {
  const execution = createStewardExecutionContext(input);

  return [
    ...createFileTools(execution),
    ...createSearchTools(execution),
    createBashTool(execution),
    ...createDelegationTools({
      msgDir: input.msgDir,
      projectId: input.projectId,
      globalConfig: input.globalConfig,
    }),
  ] as PersistentStewardTool[];
}
