import {
  discoverLocalModels,
  readCognitiveTier1Config,
} from "./cognitive-routing";
import {
  completePiText,
  isPiModelSupported,
  isPiProviderSupported,
} from "./pi";
import {
  RunCognitiveDigest,
  RunCognitiveDigestOutcome,
  RunRecord,
} from "./runs";

const DEFAULT_OLLAMA_TIMEOUT_MS = 20_000;
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

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
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

function shouldUseTier1Compression(run: RunRecord, globalConfig: string): boolean {
  if (run.agentId === "console" || run.agentId === "steward") {
    return false;
  }

  const tier1 = readCognitiveTier1Config(globalConfig);

  return tier1.localConfigured || tier1.cloudConfigured || tier1.fallbackConfigured;
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

export async function compressCompletedRunOutput(input: {
  run: RunRecord;
  globalConfig: string;
  finalVisibleOutput: string;
  changedFiles: string[];
  gitSummaryLines: string[];
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
}): Promise<RunCognitiveDigest | null> {
  if (!shouldUseTier1Compression(input.run, input.globalConfig)) {
    return null;
  }

  const visibleOutput = normalizeText(input.finalVisibleOutput);

  if (!visibleOutput && input.changedFiles.length === 0 && input.gitSummaryLines.length === 0) {
    return null;
  }

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

  if (/[/\\][\w.-]+/.test(normalized) || /\b[a-z0-9_-]+\.(ts|tsx|js|jsx|md|json|yaml|yml)\b/i.test(normalized)) {
    return false;
  }

  return /[?]$/.test(normalized) ||
    /^(what|which|who|when|where|why|how|is|are|can|do|does|did|should)\b/i.test(normalized);
}

export async function preprocessHumanMessage(input: {
  globalConfig: string;
  message: string;
  compactContext: string;
  preferLocal?: boolean;
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
}): Promise<Tier1HumanMessagePreprocessResult | null> {
  if (!shouldAttemptHumanMessagePreprocess(input.message)) {
    return null;
  }

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
}
