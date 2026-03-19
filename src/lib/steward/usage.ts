import type { AssistantMessage } from "@mariozechner/pi-ai";

import type { LaunchResult } from "../runtime";
import { formatRuntimeTokenSummary, inferRuntimeAuthMode } from "../runtime";

export type PersistentUsageSummary = {
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  totalTokens: number | null;
};

export function buildUsageDetails(
  runtime: string,
  metadata: LaunchResult["metadata"],
): string[] {
  const details: string[] = [];
  const authMode = metadata?.authMode ?? inferRuntimeAuthMode(runtime);
  const tokenSummary = formatRuntimeTokenSummary(metadata);

  details.push(`auth: ${authMode}`);

  if (metadata?.durationMs) {
    details.push(`duration: ${(metadata.durationMs / 1000).toFixed(1)}s`);
  }

  if (metadata?.numTurns) {
    details.push(`turns: ${metadata.numTurns}`);
  }

  if (tokenSummary) {
    details.push(`tokens: ${tokenSummary}`);
  }

  if (metadata?.costUsd != null) {
    details.push(`cost: $${metadata.costUsd.toFixed(4)}`);
  }

  return details;
}

export function summarizePersistentUsage(input: {
  generatedMessages: unknown[];
  durationMs: number;
}): PersistentUsageSummary {
  const assistants = input.generatedMessages.filter(
    (message): message is AssistantMessage =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { role?: string }).role === "assistant",
  );
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let totalTokens = 0;
  let sawCost = false;
  let sawInput = false;
  let sawOutput = false;
  let sawCacheCreation = false;
  let sawCacheRead = false;
  let sawTotal = false;

  for (const message of assistants) {
    if (typeof message.usage?.cost?.total === "number") {
      costUsd += message.usage.cost.total;
      sawCost = true;
    }

    if (typeof message.usage?.input === "number") {
      inputTokens += message.usage.input;
      sawInput = true;
    }

    if (typeof message.usage?.output === "number") {
      outputTokens += message.usage.output;
      sawOutput = true;
    }

    if (typeof message.usage?.cacheWrite === "number") {
      cacheCreationInputTokens += message.usage.cacheWrite;
      sawCacheCreation = true;
    }

    if (typeof message.usage?.cacheRead === "number") {
      cacheReadInputTokens += message.usage.cacheRead;
      sawCacheRead = true;
    }

    if (typeof message.usage?.totalTokens === "number") {
      totalTokens += message.usage.totalTokens;
      sawTotal = true;
    }
  }

  return {
    durationMs: input.durationMs,
    numTurns: assistants.length > 0 ? assistants.length : null,
    costUsd: sawCost ? costUsd : null,
    inputTokens: sawInput ? inputTokens : null,
    outputTokens: sawOutput ? outputTokens : null,
    cacheCreationInputTokens: sawCacheCreation ? cacheCreationInputTokens : null,
    cacheReadInputTokens: sawCacheRead ? cacheReadInputTokens : null,
    totalTokens: sawTotal ? totalTokens : null,
  };
}
