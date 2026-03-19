import type { RunResult } from "../../runs";
import type { CompileTask } from "../packets";
import { fingerprintParts } from "../packets";
import {
  DEFAULT_PACKET_FRESHNESS_MS,
  extractJsonObject,
  hasConfiguredTier1Route,
  resolveTier1Bucket,
  runTier1Task,
  truncateInline,
  type FetchLike,
  type Tier1CloudTextRunner,
} from "./shared";

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

export type TriageRunDiffForStewardInput = {
  globalConfig: string;
  result: RunResult;
  fetchImpl?: FetchLike;
  cloudRunner?: Tier1CloudTextRunner;
};

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
