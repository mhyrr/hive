import type { CompileTask } from "../packets";
import { fingerprintParts } from "../packets";
import {
  DEFAULT_PACKET_FRESHNESS_MS,
  extractJsonObject,
  hasConfiguredTier1Route,
  normalizeText,
  resolveTier1Bucket,
  runTier1Task,
  truncateInline,
  type FetchLike,
  type Tier1CloudTextRunner,
} from "./shared";

export type Tier1HumanMessageClassification =
  | "simple_query"
  | "status_check"
  | "directive"
  | "complex";

export type Tier1HumanMessagePreprocessResult = {
  classification: Tier1HumanMessageClassification;
  answer: string;
  reason: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
};

export type PreprocessHumanMessageInput = {
  globalConfig: string;
  message: string;
  compactContext: string;
  preferLocal?: boolean;
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
};

function parseHumanMessagePreprocessContent(raw: string): {
  classification: Tier1HumanMessageClassification | null;
  answer: string;
  reason: string;
} | null {
  const candidate = extractJsonObject(raw);

  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const classification =
      parsed.classification === "simple_query" ||
      parsed.classification === "status_check" ||
      parsed.classification === "directive" ||
      parsed.classification === "complex"
        ? parsed.classification
        : null;
    const answer = truncateInline(
      typeof parsed.answer === "string" ? parsed.answer : "",
      360,
    );
    const reason = truncateInline(
      typeof parsed.reason === "string" ? parsed.reason : "",
      220,
    );

    return {
      classification,
      answer,
      reason,
    };
  } catch {
    return null;
  }
}

function shouldAttemptHumanMessagePreprocess(message: string): boolean {
  const normalized = normalizeText(message);

  if (!normalized || normalized.length > 280) {
    return false;
  }

  if (normalized.split("\n").length > 4) {
    return false;
  }

  if (/```|`/.test(normalized)) {
    return false;
  }

  if (/\b(implement|fix|refactor|write|change|debug|review|plan|design|investigate|research|compare|build|create)\b/i.test(normalized)) {
    return false;
  }

  if (
    /[/\\][\w.-]+/.test(normalized) ||
    /\b[a-z0-9_-]+\.(ts|tsx|js|jsx|md|json|yaml|yml)\b/i.test(normalized)
  ) {
    return false;
  }

  return /[?]$/.test(normalized) ||
    /^(what|which|who|when|where|why|how|is|are|can|do|does|did|should)\b/i.test(normalized);
}

export const preprocessHumanMessageTask: CompileTask<
  PreprocessHumanMessageInput,
  Tier1HumanMessagePreprocessResult
> = {
  id: "preprocess-human-message",
  kind: "human-request",
  trigger: "event",
  freshnessMs: DEFAULT_PACKET_FRESHNESS_MS,
  priority: "foreground",
  shouldRun(input) {
    return shouldAttemptHumanMessagePreprocess(input.message) && hasConfiguredTier1Route(input.globalConfig);
  },
  fingerprint(input) {
    return fingerprintParts(
      input.globalConfig,
      input.message,
      input.compactContext,
      input.preferLocal ?? true,
    );
  },
  classify(input) {
    return resolveTier1Bucket(input.globalConfig, input.preferLocal ?? true);
  },
  async run(input) {
    const result = await runTier1Task({
      globalConfig: input.globalConfig,
      systemPrompt: [
        "You are a conservative HIVE console preprocessor.",
        "Return strict JSON with keys classification, answer, reason.",
        "classification must be one of simple_query, status_check, directive, complex.",
        "Use status_check only when the user is clearly asking for current activity, current state, attention needed, or whether anything is blocked.",
        "Use simple_query only when the question can be answered directly from the provided compact context, with no repo inspection, planning, or judgment.",
        "Use directive for requests to act, change files, plan, review, research, or perform multi-step work.",
        "Use complex for anything ambiguous or requiring steward reasoning.",
        "When in doubt, choose complex.",
        "If classification is not simple_query, answer must be an empty string.",
        "If classification is simple_query, answer must be factual, under 90 words, and use only the provided context.",
      ].join(" "),
      userContent: [
        `message: ${normalizeText(input.message)}`,
        "",
        "compact-context:",
        normalizeText(input.compactContext),
      ].join("\n"),
      preferLocal: input.preferLocal ?? true,
      fetchImpl: input.fetchImpl,
      cloudRunner: input.cloudRunner,
    });

    if (!result) {
      return null;
    }

    const parsed = parseHumanMessagePreprocessContent(result.text);

    if (!parsed?.classification) {
      return null;
    }

    return {
      classification: parsed.classification,
      answer: parsed.answer,
      reason: parsed.reason,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      durationMs: result.durationMs,
    };
  },
};
