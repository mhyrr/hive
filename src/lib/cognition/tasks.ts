import {
  discoverLocalModels,
  readCognitiveTier1Config,
} from "../cognitive-routing";
import {
  completePiText,
  isPiModelSupported,
  isPiProviderSupported,
} from "../pi";
import type {
  RunCognitiveDigest,
  RunCognitiveDigestOutcome,
  RunRecord,
  RunResult,
} from "../runs";
import type { CognitionConcurrencyBucket, CompileTask } from "./packets";
import { fingerprintParts } from "./packets";

const DEFAULT_OLLAMA_TIMEOUT_MS = 20_000;
const DEFAULT_PACKET_FRESHNESS_MS = 5 * 60_000;
const MAX_VISIBLE_OUTPUT_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 220;
const MAX_LIST_ITEMS = 6;

type FetchLike = typeof globalThis.fetch;
export type Tier1CloudTextRunner = typeof completePiText;

type Tier1TaskResult = {
  provider: string;
  model: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
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

export type Tier1DiffTriageDecision = {
  stewardWorthy: boolean;
  reason: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  handledBy: "deterministic" | "tier1";
};

export type CompressCompletedRunOutputInput = {
  run: RunRecord;
  globalConfig: string;
  finalVisibleOutput: string;
  changedFiles: string[];
  gitSummaryLines: string[];
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
};

export type PreprocessHumanMessageInput = {
  globalConfig: string;
  message: string;
  compactContext: string;
  preferLocal?: boolean;
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
};

export type TriageRunDiffForStewardInput = {
  globalConfig: string;
  result: RunResult;
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
};

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
};

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

function truncateForContext(value: string, maxChars = MAX_VISIBLE_OUTPUT_CHARS): string {
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

  return [...new Set(
    value
      .map((entry) => (typeof entry === "string" ? truncateInline(entry, 140) : ""))
      .map((entry) => entry.trim())
      .filter(Boolean),
  )].slice(0, limit);
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

function parseDiffTriageContent(raw: string): {
  stewardWorthy: boolean | null;
  reason: string;
} | null {
  const candidate = extractJsonObject(raw);

  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;

    return {
      stewardWorthy:
        typeof parsed.steward_worthy === "boolean"
          ? parsed.steward_worthy
          : typeof parsed.stewardWorthy === "boolean"
            ? parsed.stewardWorthy
            : null,
      reason: truncateInline(
        typeof parsed.reason === "string" ? parsed.reason : "",
        220,
      ),
    };
  } catch {
    return null;
  }
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
    input.gitSummaryLines.length > 0 ? input.gitSummaryLines.join("\n") : "(none)",
    "",
    "changed-files:",
    input.changedFiles.length > 0 ? input.changedFiles.join("\n") : "(none)",
    "",
    "visible-output:",
    truncateForContext(input.visibleOutput),
  ].join("\n");
}

function hasConfiguredTier1Route(globalConfig: string): boolean {
  const tier1 = readCognitiveTier1Config(globalConfig);

  return tier1.localConfigured || tier1.cloudConfigured || tier1.fallbackConfigured;
}

function shouldUseTier1Compression(run: RunRecord, globalConfig: string): boolean {
  if (run.agentId === "console" || run.agentId === "steward") {
    return false;
  }

  return hasConfiguredTier1Route(globalConfig);
}

function createFallbackDigest(input: {
  run: RunRecord;
  visibleOutput: string;
  changedFiles: string[];
  gitSummaryLines: string[];
  provider?: string;
  model?: string;
}): RunCognitiveDigest {
  const rawSummary =
    input.gitSummaryLines[0] ??
    input.visibleOutput.split("\n")[0] ??
    `${input.run.agentId} ${input.run.status}`;

  return {
    provider: input.provider ?? "unknown",
    model: input.model ?? "unknown",
    summary: truncateInline(rawSummary || `${input.run.agentId} ${input.run.status}`),
    outcome: defaultOutcomeForRun(input.run),
    keyDecisions: input.gitSummaryLines.slice(0, 3).map((line) => truncateInline(line, 140)),
    filesChanged: input.changedFiles.slice(0, MAX_LIST_ITEMS),
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    durationMs: null,
  };
}

async function runLocalTier1Task(input: {
  ollamaBaseUrl: string;
  localModel: string;
  systemPrompt: string;
  userContent: string;
  fetchImpl?: FetchLike;
}): Promise<Tier1TaskResult | null> {
  const localModels = await discoverLocalModels({
    baseUrl: input.ollamaBaseUrl,
    configuredModel: input.localModel,
    fetchImpl: input.fetchImpl,
  });

  if (!localModels.available || localModels.configuredModelStatus !== "available") {
    return null;
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${localModels.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.localModel,
        stream: false,
        format: "json",
        messages: [
          {
            role: "system",
            content: input.systemPrompt,
          },
          {
            role: "user",
            content: input.userContent,
          },
        ],
        options: {
          temperature: 0.1,
        },
      }),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as OllamaChatResponse;

    return {
      provider: "ollama",
      model: input.localModel,
      text: payload.message?.content?.trim() ?? "",
      inputTokens:
        typeof payload.prompt_eval_count === "number" ? payload.prompt_eval_count : null,
      outputTokens:
        typeof payload.eval_count === "number" ? payload.eval_count : null,
      totalTokens:
        typeof payload.prompt_eval_count === "number" || typeof payload.eval_count === "number"
          ? (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0)
          : null,
      durationMs:
        typeof payload.total_duration === "number"
          ? Math.round(payload.total_duration / 1_000_000)
          : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function runCloudTier1Task(input: {
  provider: string | null;
  modelId: string | null;
  systemPrompt: string;
  userContent: string;
  cloudRunner?: Tier1CloudTextRunner;
}): Promise<Tier1TaskResult | null> {
  if (!input.provider || !input.modelId) {
    return null;
  }

  if (!isPiProviderSupported(input.provider) || !isPiModelSupported(input.provider, input.modelId)) {
    return null;
  }

  try {
    const result = await (input.cloudRunner ?? completePiText)({
      provider: input.provider,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
    });

    return {
      provider: result.provider,
      model: result.model,
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      durationMs: result.durationMs,
    };
  } catch {
    return null;
  }
}

async function runTier1Task(input: {
  globalConfig: string;
  systemPrompt: string;
  userContent: string;
  preferLocal: boolean;
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
}): Promise<Tier1TaskResult | null> {
  const tier1 = readCognitiveTier1Config(input.globalConfig);

  if (input.preferLocal && tier1.localConfigured) {
    const localResult = await runLocalTier1Task({
      ollamaBaseUrl: tier1.ollamaBaseUrl,
      localModel: tier1.localModel,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      fetchImpl: input.fetchImpl,
    });

    if (localResult) {
      return localResult;
    }
  }

  if (tier1.cloudConfigured) {
    const cloudResult = await runCloudTier1Task({
      provider: tier1.cloudProvider,
      modelId: tier1.cloudModelId,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      cloudRunner: input.cloudRunner,
    });

    if (cloudResult) {
      return cloudResult;
    }
  }

  if (tier1.fallbackConfigured) {
    const fallbackResult = await runCloudTier1Task({
      provider: tier1.fallbackProvider,
      modelId: tier1.fallbackModelId,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      cloudRunner: input.cloudRunner,
    });

    if (fallbackResult) {
      return fallbackResult;
    }
  }

  return null;
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

function isStewardKeyFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return (
    normalized.endsWith("/plan.md") ||
    normalized.endsWith("/board.md") ||
    normalized.endsWith("/log.md") ||
    normalized.endsWith("/memory.md") ||
    normalized.endsWith("/config.md") ||
    normalized === "plan.md" ||
    normalized === "board.md" ||
    normalized === "log.md" ||
    normalized === "memory.md" ||
    normalized === "config.md"
  );
}

function isRoutineSupportFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith("tests/") ||
    normalized.includes("/tests/") ||
    normalized.startsWith("docs/") ||
    normalized.includes("/docs/") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".snap") ||
    normalized.endsWith(".lock")
  );
}

function resolveTier1Bucket(
  globalConfig: string,
  preferLocal: boolean,
): CognitionConcurrencyBucket {
  const tier1 = readCognitiveTier1Config(globalConfig);

  if (preferLocal && tier1.localConfigured) {
    return "tier1-local";
  }

  if (tier1.cloudConfigured || tier1.fallbackConfigured) {
    return "tier1-cloud";
  }

  if (tier1.localConfigured) {
    return "tier1-local";
  }

  return "deterministic";
}

function getDeterministicDiffTriageDecision(
  input: TriageRunDiffForStewardInput,
): Tier1DiffTriageDecision | null {
  if (input.result.status === "failed" || input.result.status === "cancelled") {
    return {
      stewardWorthy: true,
      reason: "The worker did not complete cleanly, so the steward should review it.",
      provider: "deterministic",
      model: "deterministic",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      durationMs: null,
      handledBy: "deterministic",
    };
  }

  const digestOutcome = input.result.cognitiveDigest?.outcome ?? null;

  if (digestOutcome === "blocked" || digestOutcome === "failed" || digestOutcome === "partial") {
    return {
      stewardWorthy: true,
      reason: "The worker result was not a clean success, so the steward should review it.",
      provider: "deterministic",
      model: "deterministic",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      durationMs: null,
      handledBy: "deterministic",
    };
  }

  const changedFiles = input.result.changedFiles.filter(Boolean);

  if (changedFiles.some(isStewardKeyFile)) {
    return {
      stewardWorthy: true,
      reason: "The diff touches a steward-owned coordination file.",
      provider: "deterministic",
      model: "deterministic",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      durationMs: null,
      handledBy: "deterministic",
    };
  }

  if (changedFiles.length === 0) {
    return {
      stewardWorthy: true,
      reason: "No file diff was captured, so this result still needs steward review.",
      provider: "deterministic",
      model: "deterministic",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      durationMs: null,
      handledBy: "deterministic",
    };
  }

  const allRoutineSupportFiles = changedFiles.every(isRoutineSupportFile);

  if (allRoutineSupportFiles && !hasConfiguredTier1Route(input.globalConfig)) {
    return {
      stewardWorthy: false,
      reason: "Only routine support files changed, and no tier-1 model is configured for deeper triage.",
      provider: "deterministic",
      model: "deterministic",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      durationMs: null,
      handledBy: "deterministic",
    };
  }

  return null;
}

export const compressCompletedRunOutputTask: CompileTask<
  CompressCompletedRunOutputInput,
  RunCognitiveDigest
> = {
  id: "compress-completed-run-output",
  kind: "run-result",
  trigger: "event",
  freshnessMs: DEFAULT_PACKET_FRESHNESS_MS,
  priority: "foreground",
  shouldRun(input) {
    if (!shouldUseTier1Compression(input.run, input.globalConfig)) {
      return false;
    }

    const visibleOutput = normalizeText(input.finalVisibleOutput);
    return Boolean(
      visibleOutput ||
      input.changedFiles.length > 0 ||
      input.gitSummaryLines.length > 0,
    );
  },
  fingerprint(input) {
    return fingerprintParts(
      input.run.runId,
      input.run.status,
      input.run.ended,
      input.run.agentId,
      input.globalConfig,
      normalizeText(input.finalVisibleOutput),
      input.changedFiles,
      input.gitSummaryLines,
    );
  },
  classify(input) {
    return resolveTier1Bucket(input.globalConfig, true);
  },
  async run(input) {
    const visibleOutput = normalizeText(input.finalVisibleOutput);
    const result = await runTier1Task({
      globalConfig: input.globalConfig,
      systemPrompt:
        "You compress completed worker output for a steward. Return strict JSON with keys summary, outcome, key_decisions, files_changed. Keep summary under 160 characters. Use outcome success, partial, blocked, or failed. Do not invent facts.",
      userContent: buildCompressionPrompt({
        run: input.run,
        visibleOutput,
        changedFiles: input.changedFiles,
        gitSummaryLines: input.gitSummaryLines,
      }),
      preferLocal: true,
      fetchImpl: input.fetchImpl,
      cloudRunner: input.cloudRunner,
    });

    if (!result) {
      return null;
    }

    const parsed = parseDigestContent(result.text);

    if (!parsed?.summary) {
      return createFallbackDigest({
        run: input.run,
        visibleOutput,
        changedFiles: input.changedFiles,
        gitSummaryLines: input.gitSummaryLines,
        provider: result.provider,
        model: result.model,
      });
    }

    return {
      provider: result.provider,
      model: result.model,
      summary: parsed.summary,
      outcome: parsed.outcome ?? defaultOutcomeForRun(input.run),
      keyDecisions: parsed.keyDecisions,
      filesChanged:
        parsed.filesChanged.length > 0
          ? parsed.filesChanged
          : input.changedFiles.slice(0, MAX_LIST_ITEMS),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      durationMs: result.durationMs,
    };
  },
};

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

export const triageRunDiffForStewardTask: CompileTask<
  TriageRunDiffForStewardInput,
  Tier1DiffTriageDecision
> = {
  id: "triage-run-diff-for-steward",
  kind: "diff-triage",
  trigger: "event",
  freshnessMs: DEFAULT_PACKET_FRESHNESS_MS,
  priority: "foreground",
  shouldRun() {
    return true;
  },
  fingerprint(input) {
    return fingerprintParts(
      input.globalConfig,
      input.result.runId,
      input.result.status,
      input.result.changedFiles,
      input.result.gitSummaryLines,
      input.result.finalVisibleOutput,
      input.result.cognitiveDigest?.summary ?? null,
      input.result.cognitiveDigest?.outcome ?? null,
    );
  },
  classify(input) {
    const deterministicDecision = getDeterministicDiffTriageDecision(input);

    if (deterministicDecision) {
      return "deterministic";
    }

    const changedFiles = input.result.changedFiles.filter(Boolean);
    const allRoutineSupportFiles = changedFiles.every(isRoutineSupportFile);

    return resolveTier1Bucket(input.globalConfig, allRoutineSupportFiles);
  },
  async run(input) {
    const deterministicDecision = getDeterministicDiffTriageDecision(input);

    if (deterministicDecision) {
      return deterministicDecision;
    }

    const changedFiles = input.result.changedFiles.filter(Boolean);
    const allRoutineSupportFiles = changedFiles.every(isRoutineSupportFile);
    const result = await runTier1Task({
      globalConfig: input.globalConfig,
      systemPrompt: [
        "You triage completed worker diffs for a HIVE steward.",
        "Return strict JSON with keys steward_worthy and reason.",
        "steward_worthy must be true when the change is likely to affect plan, coordination, architecture, interfaces, or human-visible direction.",
        "steward_worthy must be false when the change is routine support work that does not need immediate steward attention.",
        "Be conservative: when in doubt, return true.",
        "Keep reason under 140 characters.",
      ].join(" "),
      userContent: [
        `agent: ${input.result.agentId}`,
        `status: ${input.result.status}`,
        `assignment: ${input.result.assignmentMessage ?? "(none)"}`,
        "",
        "changed-files:",
        changedFiles.join("\n"),
        "",
        "git-summary:",
        input.result.gitSummaryLines.length > 0 ? input.result.gitSummaryLines.join("\n") : "(none)",
        "",
        "worker-summary:",
        input.result.cognitiveDigest?.summary || truncateInline(input.result.finalVisibleOutput, 320) || "(none)",
      ].join("\n"),
      preferLocal: allRoutineSupportFiles,
      fetchImpl: input.fetchImpl,
      cloudRunner: input.cloudRunner,
    });

    if (!result) {
      return {
        stewardWorthy: true,
        reason: "Tier-1 diff triage was unavailable, so the steward should review the result.",
        provider: "deterministic",
        model: "deterministic",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        durationMs: null,
        handledBy: "deterministic",
      };
    }

    const parsed = parseDiffTriageContent(result.text);

    if (parsed?.stewardWorthy == null) {
      return {
        stewardWorthy: true,
        reason: "Tier-1 diff triage returned an unusable result, so the steward should review it.",
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        durationMs: result.durationMs,
        handledBy: "tier1",
      };
    }

    return {
      stewardWorthy: parsed.stewardWorthy,
      reason:
        parsed.reason ||
        (parsed.stewardWorthy
          ? "Tier-1 flagged the diff as steward-worthy."
          : "Tier-1 marked the diff as routine."),
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      durationMs: result.durationMs,
      handledBy: "tier1",
    };
  },
};

export const cognitionTasks = [
  compressCompletedRunOutputTask,
  preprocessHumanMessageTask,
  triageRunDiffForStewardTask,
] as const satisfies Array<CompileTask<unknown, unknown>>;
