import type { Tool } from "@mariozechner/pi-ai";

import { createBashTool } from "./bash";
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
}): PersistentStewardTool[] {
  const execution = createStewardExecutionContext(input);

  return [
    ...createFileTools(execution),
    ...createSearchTools(execution),
    createBashTool(execution),
  ] as PersistentStewardTool[];
}
