// Live LLM wiring for decompose-loop. Adapts completeClaudeText (subscription
// OAuth via the Claude Code CLI) into the LLMCaller interface used by the
// OODA loop. Kept separate from the loop so tests don't spawn claude.

import { completeClaudeText } from "./claude";
import type { LLMCaller, LLMCallInput, LLMCallOutput } from "./decompose-loop";

export const liveClaudeCaller: LLMCaller = async (
  input: LLMCallInput,
): Promise<LLMCallOutput> => {
  const result = await completeClaudeText({
    modelId: input.modelId,
    systemPrompt: input.systemPrompt,
    userContent: input.userMessage,
  });
  return {
    text: result.text,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
  };
};
