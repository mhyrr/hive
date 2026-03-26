/**
 * Tier-1 LLM helpers — lightweight Haiku calls for run compression
 * and human-message preprocessing.
 *
 * This is a self-contained module that calls the Anthropic API directly
 * via `callAnthropic` — no workbench, packets, or CompileTask abstraction.
 */

import type {
  RunCognitiveDigest,
  RunCognitiveDigestOutcome,
  RunRecord,
} from "./runs";
import { callAnthropic } from "./anthropic-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HAIKU_MODEL = "claude-haiku-4-20250414";
const MAX_VISIBLE_OUTPUT_CHARS = 8_000;
const MAX_LIST_ITEMS = 6;
const MAX_SUMMARY_CHARS = 220;

// ---------------------------------------------------------------------------
// Shared helpers (inlined from cognition/tasks/shared)
// ---------------------------------------------------------------------------

function normalizeText(value: string | null | undefined): string {
  return value?.replace(/\r\n/g, "\n").trim() ?? "";
}

function truncateInline(value: string, maxChars = MAX_SUMMARY_CHARS): string {
  const normalized = value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exported types (kept identical so callers don't change)
// ---------------------------------------------------------------------------

export type CompressCompletedRunOutputInput = {
  run: RunRecord;
  globalConfig: string;
  finalVisibleOutput: string;
  changedFiles: string[];
  gitSummaryLines: string[];
};

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
};

// ---------------------------------------------------------------------------
// compressCompletedRunOutput
// ---------------------------------------------------------------------------

function truncateForContext(
  value: string,
  maxChars = MAX_VISIBLE_OUTPUT_CHARS,
): string {
  const normalized = normalizeText(value);

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const headLength = Math.floor((maxChars - 32) / 2);
  const tailLength = maxChars - headLength - 32;

  return [
    normalized.slice(0, headLength).trimEnd(),
    "",
    "[... output truncated for tier-1 ...]",
    "",
    normalized.slice(-tailLength).trimStart(),
  ].join("\n");
}

function toStringArray(value: unknown, limit = MAX_LIST_ITEMS): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((entry) =>
          typeof entry === "string" ? truncateInline(entry, 140) : "",
        )
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

function defaultOutcomeForRun(run: RunRecord): RunCognitiveDigestOutcome {
  if (run.status === "failed") {
    return "failed";
  }

  if (run.status === "cancelled") {
    return "blocked";
  }

  return "success";
}

function buildCompressionPrompt(input: {
  run: RunRecord;
  visibleOutput: string;
  changedFiles: string[];
  gitSummaryLines: string[];
}): string {
  return [
    `agent: ${input.run.agentId}`,
    `status: ${input.run.status}`,
    `runtime: ${input.run.runtime}${input.run.model ? ` (${input.run.model})` : ""}`,
    `assignment-message: ${input.run.sourceMessage ?? "(none)"}`,
    `task: ${input.run.taskId ?? "(none)"}`,
    "",
    "git-summary:",
    input.gitSummaryLines.length > 0
      ? input.gitSummaryLines.join("\n")
      : "(none)",
    "",
    "changed-files:",
    input.changedFiles.length > 0 ? input.changedFiles.join("\n") : "(none)",
    "",
    "visible-output:",
    truncateForContext(input.visibleOutput),
  ].join("\n");
}

function createFallbackDigest(input: {
  run: RunRecord;
  visibleOutput: string;
  changedFiles: string[];
  gitSummaryLines: string[];
}): RunCognitiveDigest {
  const rawSummary =
    input.gitSummaryLines[0] ??
    input.visibleOutput.split("\n")[0] ??
    `${input.run.agentId} ${input.run.status}`;

  return {
    provider: "anthropic",
    model: HAIKU_MODEL,
    summary: truncateInline(
      rawSummary || `${input.run.agentId} ${input.run.status}`,
    ),
    outcome: defaultOutcomeForRun(input.run),
    keyDecisions: input.gitSummaryLines
      .slice(0, 3)
      .map((line) => truncateInline(line, 140)),
    filesChanged: input.changedFiles.slice(0, MAX_LIST_ITEMS),
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    durationMs: null,
  };
}

function parseDigestContent(raw: string): {
  summary: string;
  outcome: RunCognitiveDigestOutcome | null;
  keyDecisions: string[];
  filesChanged: string[];
} | null {
  const candidate = extractJsonObject(raw);

  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const summary = truncateInline(
      typeof parsed.summary === "string" ? parsed.summary : "",
    );

    return {
      summary,
      outcome:
        parsed.outcome === "success" ||
        parsed.outcome === "partial" ||
        parsed.outcome === "blocked" ||
        parsed.outcome === "failed"
          ? parsed.outcome
          : null,
      keyDecisions: toStringArray(parsed.key_decisions),
      filesChanged: toStringArray(parsed.files_changed),
    };
  } catch {
    return null;
  }
}

export async function compressCompletedRunOutput(
  input: CompressCompletedRunOutputInput,
): Promise<RunCognitiveDigest | null> {
  const visibleOutput = normalizeText(input.finalVisibleOutput);

  // Nothing meaningful to compress
  if (
    !visibleOutput &&
    input.changedFiles.length === 0 &&
    input.gitSummaryLines.length === 0
  ) {
    return null;
  }

  // Skip compression for console / steward agents
  if (input.run.agentId === "console" || input.run.agentId === "steward") {
    return null;
  }

  const systemPrompt =
    "You compress completed worker output for a steward. Return strict JSON with keys summary, outcome, key_decisions, files_changed. Keep summary under 160 characters. Use outcome success, partial, blocked, or failed. Do not invent facts.";

  const userContent = buildCompressionPrompt({
    run: input.run,
    visibleOutput,
    changedFiles: input.changedFiles,
    gitSummaryLines: input.gitSummaryLines,
  });

  const start = Date.now();

  let text: string;

  try {
    text = await callAnthropic({
      model: HAIKU_MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 400,
      timeoutMs: 15_000,
    });
  } catch {
    return createFallbackDigest({
      run: input.run,
      visibleOutput,
      changedFiles: input.changedFiles,
      gitSummaryLines: input.gitSummaryLines,
    });
  }

  const durationMs = Date.now() - start;

  const parsed = parseDigestContent(text);

  if (!parsed?.summary) {
    return createFallbackDigest({
      run: input.run,
      visibleOutput,
      changedFiles: input.changedFiles,
      gitSummaryLines: input.gitSummaryLines,
    });
  }

  return {
    provider: "anthropic",
    model: HAIKU_MODEL,
    summary: parsed.summary,
    outcome: parsed.outcome ?? defaultOutcomeForRun(input.run),
    keyDecisions: parsed.keyDecisions,
    filesChanged:
      parsed.filesChanged.length > 0
        ? parsed.filesChanged
        : input.changedFiles.slice(0, MAX_LIST_ITEMS),
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// preprocessHumanMessage
// ---------------------------------------------------------------------------

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

  if (
    /\b(implement|fix|refactor|write|change|debug|review|plan|design|investigate|research|compare|build|create)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }

  if (
    /[/\\][\w.-]+/.test(normalized) ||
    /\b[a-z0-9_-]+\.(ts|tsx|js|jsx|md|json|yaml|yml)\b/i.test(normalized)
  ) {
    return false;
  }

  return (
    /[?]$/.test(normalized) ||
    /^(what|which|who|when|where|why|how|is|are|can|do|does|did|should)\b/i.test(
      normalized,
    )
  );
}

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

    return { classification, answer, reason };
  } catch {
    return null;
  }
}

export async function preprocessHumanMessage(
  input: PreprocessHumanMessageInput,
): Promise<Tier1HumanMessagePreprocessResult | null> {
  if (!shouldAttemptHumanMessagePreprocess(input.message)) {
    return null;
  }

  const systemPrompt = [
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
  ].join(" ");

  const userContent = [
    `message: ${normalizeText(input.message)}`,
    "",
    "compact-context:",
    normalizeText(input.compactContext),
  ].join("\n");

  const start = Date.now();

  let text: string;

  try {
    text = await callAnthropic({
      model: HAIKU_MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 400,
      timeoutMs: 10_000,
    });
  } catch {
    return null;
  }

  const durationMs = Date.now() - start;

  const parsed = parseHumanMessagePreprocessContent(text);

  if (!parsed?.classification) {
    return null;
  }

  return {
    classification: parsed.classification,
    answer: parsed.answer,
    reason: parsed.reason,
    provider: "anthropic",
    model: HAIKU_MODEL,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    durationMs,
  };
}
