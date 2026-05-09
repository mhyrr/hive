// OODA loop for goal decomposition (TK-036 step 3).
//
// Drives one decompose attempt, validates, runs orient on failure,
// applies the chosen lever (retry-with-reframe / accept-with-warn / abort),
// and bounds the work by attempt count + spend cap.
//
// LLM calls are abstracted via the LLMCaller interface so this module is
// testable without spawning real claude. The live wiring lives in a
// separate file (decompose-run.ts).

import {
  parseOrientResponse,
  parseProposal,
  type Proposal,
  type ProposalFailure,
  type OrientDecision,
} from "./decompose";
import {
  DECOMPOSE_SYSTEM_PROMPT,
  ORIENT_SYSTEM_PROMPT,
  buildDecomposeUserMessage,
  buildOrientUserMessage,
  type DecomposeContext,
} from "./decompose-prompt";
import { estimateCost } from "./pricing";

// ---------------------------------------------------------------------------
// LLM caller interface
// ---------------------------------------------------------------------------

export type LLMCallInput = {
  systemPrompt: string;
  userMessage: string;
  modelId: string;
};

export type LLMCallOutput = {
  text: string;
  inputTokens: number;
  outputTokens: number;
};

export type LLMCaller = (input: LLMCallInput) => Promise<LLMCallOutput>;

// ---------------------------------------------------------------------------
// Defaults — Opus on both decompose and orient (Greg: orient is design-shaped)
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_MAX_COST_USD = 5;
export const DEFAULT_DECOMPOSE_MODEL = "claude-opus-4-7";
export const DEFAULT_ORIENT_MODEL = "claude-opus-4-7";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type DecomposeAttempt = {
  attempt: number;
  decomposeOutput: string;
  failures: ProposalFailure[];
  orient: OrientDecision | null;  // null if validation succeeded
  decomposeCostUsd: number;
  orientCostUsd: number;
};

export type DecomposeRunOk = {
  ok: true;
  proposal: Proposal;
  attempts: DecomposeAttempt[];
  totalCostUsd: number;
  warnings: string[];
  reframes: string[];
};

export type DecomposeRunErr = {
  ok: false;
  reason: string;
  attempts: DecomposeAttempt[];
  totalCostUsd: number;
  warnings: string[];
  reframes: string[];
  lastFailures: ProposalFailure[];
  lastOutput: string;
};

export type DecomposeRunResult = DecomposeRunOk | DecomposeRunErr;

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type RunDecomposeInput = {
  context: DecomposeContext;
  llm: LLMCaller;
  maxAttempts?: number;
  maxCostUsd?: number;
  decomposeModel?: string;
  orientModel?: string;
  onAttempt?: (a: DecomposeAttempt) => void;
};

export async function runDecomposeLoop(
  input: RunDecomposeInput,
): Promise<DecomposeRunResult> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxCostUsd = input.maxCostUsd ?? DEFAULT_MAX_COST_USD;
  const decomposeModel = input.decomposeModel ?? DEFAULT_DECOMPOSE_MODEL;
  const orientModel = input.orientModel ?? DEFAULT_ORIENT_MODEL;

  const baseUserMessage = buildDecomposeUserMessage(input.context);

  const attempts: DecomposeAttempt[] = [];
  const reframes: string[] = [];
  const warnings: string[] = [];
  let totalCostUsd = 0;
  let userMessage = baseUserMessage;

  for (let i = 1; i <= maxAttempts; i++) {
    if (totalCostUsd > maxCostUsd) {
      return budgetExhausted(attempts, totalCostUsd, warnings, reframes);
    }

    // Observe — call decompose
    const decomposeOutput = await input.llm({
      systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
      userMessage,
      modelId: decomposeModel,
    });
    const decomposeCost = costOf(decomposeModel, decomposeOutput);
    totalCostUsd += decomposeCost;

    // Validate
    const validation = parseProposal(decomposeOutput.text);

    if (validation.ok) {
      const attempt: DecomposeAttempt = {
        attempt: i,
        decomposeOutput: decomposeOutput.text,
        failures: [],
        orient: null,
        decomposeCostUsd: decomposeCost,
        orientCostUsd: 0,
      };
      attempts.push(attempt);
      input.onAttempt?.(attempt);

      return {
        ok: true,
        proposal: validation.proposal,
        attempts,
        totalCostUsd,
        warnings,
        reframes,
      };
    }

    // Orient — read failure, choose lever
    const orientUserMessage = buildOrientUserMessage({
      goal: input.context.goal,
      attempt: i,
      maxAttempts,
      failures: validation.failures,
      rawOutput: decomposeOutput.text,
      priorReframes: reframes,
    });
    const orientOutput = await input.llm({
      systemPrompt: ORIENT_SYSTEM_PROMPT,
      userMessage: orientUserMessage,
      modelId: orientModel,
    });
    const orientCost = costOf(orientModel, orientOutput);
    totalCostUsd += orientCost;

    const decision = parseOrientResponse(orientOutput.text);

    const attempt: DecomposeAttempt = {
      attempt: i,
      decomposeOutput: decomposeOutput.text,
      failures: validation.failures,
      orient: decision,
      decomposeCostUsd: decomposeCost,
      orientCostUsd: orientCost,
    };
    attempts.push(attempt);
    input.onAttempt?.(attempt);

    if (!decision) {
      // Orient itself returned unparseable JSON — structural problem.
      return {
        ok: false,
        reason:
          "Orient returned unparseable response — cannot recover. " +
          `Last orient output: ${orientOutput.text.slice(0, 200)}`,
        attempts,
        totalCostUsd,
        warnings,
        reframes,
        lastFailures: validation.failures,
        lastOutput: decomposeOutput.text,
      };
    }

    if (decision.decision === "abort") {
      return {
        ok: false,
        reason: decision.reason,
        attempts,
        totalCostUsd,
        warnings,
        reframes,
        lastFailures: validation.failures,
        lastOutput: decomposeOutput.text,
      };
    }

    if (decision.decision === "accept-with-warn") {
      // Only honor if the partial proposal is usable (graph-shape failure,
      // not JSON / schema). Otherwise fall through to abort — orient picked
      // the wrong lever for the failure mode.
      if (validation.partial) {
        warnings.push(decision.warning);
        return {
          ok: true,
          proposal: validation.partial,
          attempts,
          totalCostUsd,
          warnings,
          reframes,
        };
      }
      return {
        ok: false,
        reason:
          `Orient picked accept-with-warn but no usable proposal exists ` +
          `(failures were JSON/schema-level). Warning was: ${decision.warning}`,
        attempts,
        totalCostUsd,
        warnings,
        reframes,
        lastFailures: validation.failures,
        lastOutput: decomposeOutput.text,
      };
    }

    // retry-with-reframe — append the reframe to the user message and loop.
    reframes.push(decision.reframe);
    userMessage =
      baseUserMessage +
      "\n\n# Targeted reframe (from prior attempt's orient)\n" +
      reframes
        .map((r, idx) => `${idx + 1}. ${r}`)
        .join("\n");
  }

  // Budget exhausted by attempt count, not by spend.
  return {
    ok: false,
    reason: `Exhausted ${maxAttempts} attempts without a valid proposal.`,
    attempts,
    totalCostUsd,
    warnings,
    reframes,
    lastFailures: attempts[attempts.length - 1]?.failures ?? [],
    lastOutput: attempts[attempts.length - 1]?.decomposeOutput ?? "",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function costOf(modelId: string, out: LLMCallOutput): number {
  const cost = estimateCost({
    provider: "anthropic",
    model: modelId,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
  });
  return cost.totalUsd;
}

function budgetExhausted(
  attempts: DecomposeAttempt[],
  totalCostUsd: number,
  warnings: string[],
  reframes: string[],
): DecomposeRunErr {
  return {
    ok: false,
    reason: `Spend cap exceeded ($${totalCostUsd.toFixed(2)}).`,
    attempts,
    totalCostUsd,
    warnings,
    reframes,
    lastFailures: attempts[attempts.length - 1]?.failures ?? [],
    lastOutput: attempts[attempts.length - 1]?.decomposeOutput ?? "",
  };
}
