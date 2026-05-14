/**
 * Campaign judge — stateless LLM caller that evaluates iteration progress
 * and returns a structured verdict: continue | replan | done.
 *
 * Architecture:
 * - System prompt = frozen prefix (byte-stable across iterations for cache hits)
 * - User message = dynamic state (checkpoint, plan, last N scorecard rows)
 * - One retry on parse failure; second failure returns safe default
 * - No council escalation in V1; `second_opinion: yes` is recorded only
 *
 * The LLM call is abstracted behind JudgeCaller so tests can mock without
 * spawning Claude.
 */

import type { CampaignState, ScorecardRow } from "./state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JudgeDecision = "continue" | "replan" | "done";

export type JudgeVerdict = {
  decision: JudgeDecision;
  reasoning: string;
  second_opinion: "yes" | "no";
  plan_diff?: string;
};

// ---------------------------------------------------------------------------
// LLM caller interface (same shape as decompose-loop)
// ---------------------------------------------------------------------------

export type JudgeCallInput = {
  systemPrompt: string;
  userMessage: string;
  modelId: string;
};

export type JudgeCallOutput = {
  text: string;
  inputTokens: number;
  outputTokens: number;
};

export type JudgeCaller = (input: JudgeCallInput) => Promise<JudgeCallOutput>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_JUDGE_MODEL = "claude-opus-4-7";
export const SCORECARD_TAIL_COUNT = 5;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Legacy system prompt constant — kept for backward compatibility in tests
 * that reference it directly. New campaigns use state.frozenPrefix (from
 * buildFrozenPrefix) as the system prompt, which contains the prime directive,
 * scope fence, and scorecard schema in a single byte-stable document.
 *
 * @deprecated Use state.frozenPrefix from buildFrozenPrefix() instead.
 */
export const JUDGE_SYSTEM_PROMPT = `You are a campaign judge — a stateless evaluator that assesses iteration progress against a frozen prime directive.

Your job is to read the latest campaign state and emit a structured verdict.

## Verdict Schema

You MUST respond with ONLY a JSON object matching this exact schema:

\`\`\`json
{
  "decision": "continue" | "replan" | "done",
  "reasoning": "<1-3 sentences explaining your decision>",
  "second_opinion": "yes" | "no",
  "plan_diff": "<required when decision is 'replan': the proposed changes to the plan>"
}
\`\`\`

## Decision criteria

- **continue**: Progress is being made. The current plan is still valid. Next iteration should proceed with the current plan.
- **replan**: The current approach needs adjustment. You MUST include a \`plan_diff\` field describing what should change and why.
- **done**: The prime directive has been satisfied. All plan items are complete or the goal has been achieved.

## Rules

1. Respond with ONLY the JSON object. No markdown fences, no preamble, no explanation outside the JSON.
2. The \`reasoning\` field is your explanation — keep it concise.
3. \`second_opinion: "yes"\` means you believe this decision warrants review by a council. Record it honestly — it will NOT trigger any action in V1.
4. When \`decision\` is "replan", \`plan_diff\` is REQUIRED. If you cannot articulate the change, use "done" instead.
5. Base your assessment on evidence: commits, test results, checkpoint content. Not optimism.`;

/**
 * Resolve the system prompt for the judge call.
 *
 * If the campaign has a proper frozen prefix (from buildFrozenPrefix), use it.
 * This is the byte-stable document that enables prompt caching — it contains
 * the prime directive, scope fence, and scorecard schema all in one.
 *
 * Falls back to JUDGE_SYSTEM_PROMPT for campaigns created before this change.
 */
export function resolveJudgeSystemPrompt(state: CampaignState): string {
  // New-style: frozenPrefix contains structured content (starts with # Campaign Frozen Prefix)
  if (state.frozenPrefix && state.frozenPrefix.startsWith("# Campaign Frozen Prefix")) {
    return state.frozenPrefix;
  }
  // Legacy: frozenPrefix is just the raw goal text — use the old constant
  return JUDGE_SYSTEM_PROMPT;
}

/**
 * Build the user message from campaign state. This is the dynamic part that
 * changes each iteration.
 *
 * The goal text (not the full frozen prefix) goes here — the structural content
 * (prime directive role, scope fence, scorecard schema) lives in the system
 * prompt via the frozen prefix for cache reuse.
 */
export function buildJudgeUserMessage(
  state: CampaignState,
  iterationN: number,
): string {
  const sections: string[] = [];

  // Goal text (raw user-supplied, separate from structural frozen prefix)
  const goalText = state.goal ?? state.frozenPrefix;
  if (goalText) {
    sections.push(`## Goal\n\n${goalText}`);
  }

  // Current plan
  if (state.plan) {
    sections.push(`## Current Plan\n\n${state.plan}`);
  }

  // Latest checkpoint
  if (state.checkpoint) {
    sections.push(`## Latest Checkpoint (Iteration ${iterationN})\n\n${state.checkpoint}`);
  }

  // Last N scorecard rows
  const tail = state.scorecard.slice(-SCORECARD_TAIL_COUNT);
  if (tail.length > 0) {
    const scorecardText = tail
      .map((row: ScorecardRow) =>
        `- Iter ${row.iteration_n}: exit=${row.exit_reason}, judge=${row.judge_decision}, tokens=${row.tokens_used}, cost=$${row.cost_usd.toFixed(2)}`,
      )
      .join("\n");
    sections.push(`## Recent Scorecard (last ${tail.length} iterations)\n\n${scorecardText}`);
  }

  // Iteration context
  sections.push(`## Current Iteration: ${iterationN}`);

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a JudgeVerdict from raw LLM output.
 * Handles JSON wrapped in markdown fences or bare JSON.
 */
export function parseVerdict(raw: string): JudgeVerdict | null {
  // Strip markdown code fences if present
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // intentional: judge response isn't valid JSON — caller retries or bails
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Validate decision field
  const decision = obj.decision;
  if (decision !== "continue" && decision !== "replan" && decision !== "done") {
    return null;
  }

  // Validate reasoning field
  const reasoning = obj.reasoning;
  if (typeof reasoning !== "string" || reasoning.length === 0) {
    return null;
  }

  // Validate second_opinion field
  const secondOpinion = obj.second_opinion;
  if (secondOpinion !== "yes" && secondOpinion !== "no") {
    return null;
  }

  const verdict: JudgeVerdict = {
    decision,
    reasoning,
    second_opinion: secondOpinion,
  };

  // plan_diff is optional but required for replan
  if (typeof obj.plan_diff === "string" && obj.plan_diff.length > 0) {
    verdict.plan_diff = obj.plan_diff;
  }

  return verdict;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type RunJudgeOpts = {
  /** Campaign state (from readCampaignState). */
  state: CampaignState;
  /** Current iteration number. */
  iterationN: number;
  /** LLM caller — injected for testability. */
  caller: JudgeCaller;
  /** Override model (default: claude-opus-4-7). */
  modelId?: string;
};

/**
 * Run the judge: assemble prompt, call LLM, parse verdict.
 * Retries once on parse failure. On second failure, returns a safe default.
 *
 * The system prompt is the frozen prefix (byte-stable across iterations),
 * enabling prompt caching on the Anthropic side.
 */
export async function runJudge(opts: RunJudgeOpts): Promise<JudgeVerdict> {
  const { state, iterationN, caller, modelId } = opts;
  const model = modelId ?? DEFAULT_JUDGE_MODEL;
  const systemPrompt = resolveJudgeSystemPrompt(state);
  const userMessage = buildJudgeUserMessage(state, iterationN);

  // First attempt
  const firstResponse = await caller({
    systemPrompt,
    userMessage,
    modelId: model,
  });

  const firstVerdict = parseVerdict(firstResponse.text);
  if (firstVerdict) {
    return applyReplanGuard(firstVerdict);
  }

  // Retry once with explicit nudge
  const retryMessage = `${userMessage}\n\n---\n\n## IMPORTANT: Your previous response was not valid JSON matching the required schema. Respond with ONLY a JSON object: {"decision": "continue"|"replan"|"done", "reasoning": "...", "second_opinion": "yes"|"no", "plan_diff": "...if replan..."}`;

  const retryResponse = await caller({
    systemPrompt,
    userMessage: retryMessage,
    modelId: model,
  });

  const retryVerdict = parseVerdict(retryResponse.text);
  if (retryVerdict) {
    return applyReplanGuard(retryVerdict);
  }

  // Both attempts failed — safe default
  return {
    decision: "replan",
    reasoning: "judge parse failure",
    second_opinion: "no",
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * When decision is 'replan' but plan_diff is missing, downgrade to 'done'.
 * Per acceptance criteria: missing diff on replan → done with reasoning logged.
 */
function applyReplanGuard(verdict: JudgeVerdict): JudgeVerdict {
  if (verdict.decision === "replan" && !verdict.plan_diff) {
    return {
      decision: "done",
      reasoning: `Replan requested but no plan_diff provided. Original reasoning: ${verdict.reasoning}`,
      second_opinion: verdict.second_opinion,
    };
  }
  return verdict;
}
