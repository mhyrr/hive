import {
  discoverLocalModels,
  readCognitiveTier1Config,
} from "./cognitive-routing";
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

  return /^tier1_local:\s*.+$/m.test(globalConfig);
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
    provider: "ollama",
    model: "unknown",
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

export async function compressCompletedRunOutput(input: {
  run: RunRecord;
  globalConfig: string;
  finalVisibleOutput: string;
  changedFiles: string[];
  gitSummaryLines: string[];
  fetchImpl?: FetchLike;
}): Promise<RunCognitiveDigest | null> {
  if (!shouldUseTier1Compression(input.run, input.globalConfig)) {
    return null;
  }

  const visibleOutput = normalizeText(input.finalVisibleOutput);

  if (!visibleOutput && input.changedFiles.length === 0 && input.gitSummaryLines.length === 0) {
    return null;
  }

  const tier1 = readCognitiveTier1Config(input.globalConfig);
  const localModels = await discoverLocalModels({
    baseUrl: tier1.ollamaBaseUrl,
    configuredModel: tier1.localModel,
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
        model: tier1.localModel,
        stream: false,
        format: "json",
        messages: [
          {
            role: "system",
            content:
              "You compress completed worker output for a steward. Return strict JSON with keys summary, outcome, key_decisions, files_changed. Keep summary under 160 characters. Use outcome success, partial, blocked, or failed. Do not invent facts.",
          },
          {
            role: "user",
            content: buildCompressionPrompt({
              run: input.run,
              visibleOutput,
              changedFiles: input.changedFiles,
              gitSummaryLines: input.gitSummaryLines,
            }),
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
    const parsed = parseDigestContent(payload.message?.content ?? "");

    if (!parsed?.summary) {
      return {
        ...createFallbackDigest({
          run: input.run,
          visibleOutput,
          changedFiles: input.changedFiles,
          gitSummaryLines: input.gitSummaryLines,
        }),
        model: tier1.localModel,
      };
    }

    const inputTokens =
      typeof payload.prompt_eval_count === "number" ? payload.prompt_eval_count : null;
    const outputTokens =
      typeof payload.eval_count === "number" ? payload.eval_count : null;

    return {
      provider: "ollama",
      model: tier1.localModel,
      summary: parsed.summary,
      outcome: parsed.outcome ?? defaultOutcomeForRun(input.run),
      keyDecisions: parsed.keyDecisions,
      filesChanged:
        parsed.filesChanged.length > 0
          ? parsed.filesChanged
          : input.changedFiles.slice(0, MAX_LIST_ITEMS),
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens !== null || outputTokens !== null
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
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
