import type {
  RunCognitiveDigest,
  RunCognitiveDigestOutcome,
  RunRecord,
} from "../../runs";
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

const MAX_VISIBLE_OUTPUT_CHARS = 8_000;
const MAX_LIST_ITEMS = 6;

export type CompressCompletedRunOutputInput = {
  run: RunRecord;
  globalConfig: string;
  finalVisibleOutput: string;
  changedFiles: string[];
  gitSummaryLines: string[];
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
};

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
