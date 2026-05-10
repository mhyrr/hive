// Live LLM wiring for the campaign judge. Adapts completeClaudeText
// (subscription OAuth via the Claude Code CLI) into the JudgeCaller
// interface. Kept separate from judge.ts so tests don't spawn Claude.

import { completeClaudeText } from "../claude";
import type { JudgeCaller, JudgeCallInput, JudgeCallOutput } from "./judge";

export const liveJudgeCaller: JudgeCaller = async (
  input: JudgeCallInput,
): Promise<JudgeCallOutput> => {
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
