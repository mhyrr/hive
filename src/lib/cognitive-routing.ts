import { extractConfigValue, extractConfigValueAlias, parsePositiveInt } from "./config";
import {
  getConfiguredDirectAuthPolicy,
  listRuntimeAdapters,
  readRuntimeAccessPolicy,
  resolvePiRuntimeRoute,
  type PiRuntimeRoute,
  type RuntimeAuthPolicy,
} from "./runtime";
import type { CognitiveUsageSnapshot } from "./cognitive-usage";

export const COGNITIVE_ROUTING_SKILL_NAME = "cognitive-resource-routing";

export const STEWARD_ESSENTIAL_SKILL_NAMES = [
  "state-efficient-ops",
  "autonomous-ops",
  COGNITIVE_ROUTING_SKILL_NAME,
] as const;

type CognitiveRoutingBias = "latency" | "balanced" | "quality";

type CognitiveRoutingModeId =
  | "direct-answer"
  | "targeted-inspection"
  | "plural-synthesis";

type CognitiveRoutingMode = {
  id: CognitiveRoutingModeId;
  label: string;
  useWhen: string;
  depth: string;
  runtime: string;
  fanOut: string;
  parallelism: string;
};

type CognitiveRuntimeLane = {
  runtime: string;
  directAuth: RuntimeAuthPolicy;
  piRoute: PiRuntimeRoute;
};

type CognitiveRoutingPolicy = {
  principle: string;
  bias: CognitiveRoutingBias;
  defaultRuntime: string | null;
  defaultModel: string | null;
  maxFanOut: number;
  maxParallel: number;
  modes: CognitiveRoutingMode[];
  runtimeLanes: CognitiveRuntimeLane[];
};

type CognitiveTier1Config = {
  localModel: string;
  localConfigured: boolean;
  cloudModel: string;
  cloudConfigured: boolean;
  cloudProvider: string | null;
  cloudModelId: string | null;
  fallbackModel: string;
  fallbackConfigured: boolean;
  fallbackProvider: string | null;
  fallbackModelId: string | null;
  ollamaBaseUrl: string;
};

type CognitiveLocalModel = {
  name: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  digest: string | null;
};

type CognitiveLocalModelDiscovery = {
  baseUrl: string;
  available: boolean;
  reason: string | null;
  configuredModelStatus: "available" | "missing" | "unavailable" | "unconfigured";
  models: CognitiveLocalModel[];
};

type CognitiveSessionContext = {
  sessionId: string;
  project: string;
  runtime: string;
  model: string | null;
};

type CognitiveExecutionMode = "persistent-pi" | "direct-runtime";

type CognitiveExecutionLane = {
  mode: CognitiveExecutionMode;
  runtime: string;
  selectedModel: string | null;
  executedModel: string | null;
  directAuth: RuntimeAuthPolicy;
  piRoute: PiRuntimeRoute;
};

type CognitiveRoutingSnapshot = {
  policy: CognitiveRoutingPolicy;
  activeSession: CognitiveSessionContext | null;
  activeLane: CognitiveRuntimeLane | null;
  activeExecution: CognitiveExecutionLane | null;
  defaultLane: CognitiveRuntimeLane | null;
  defaultExecution: CognitiveExecutionLane | null;
  tier1: CognitiveTier1Config;
  localModels: CognitiveLocalModelDiscovery;
};

const DEFAULT_TIER1_LOCAL_MODEL = "qwen3:4b";
const DEFAULT_TIER1_CLOUD_MODEL = "haiku";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const LOCAL_MODEL_DISCOVERY_CACHE_TTL_MS = 10_000;

type FetchLike = typeof globalThis.fetch;
type LocalModelDiscoveryCacheEntry = {
  expiresAt: number;
  result: CognitiveLocalModelDiscovery;
};

const localModelDiscoveryCache = new Map<string, LocalModelDiscoveryCacheEntry>();

function normalizeConfigText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function parseBias(value: string | null | undefined): CognitiveRoutingBias | null {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "latency" || normalized === "balanced" || normalized === "quality") {
    return normalized;
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function defaultFanOutForBias(bias: CognitiveRoutingBias): number {
  if (bias === "quality") {
    return 3;
  }

  return 2;
}

function defaultParallelForBias(bias: CognitiveRoutingBias): number {
  if (bias === "latency") {
    return 1;
  }

  return 2;
}

function normalizeOllamaBaseUrl(value: string | null | undefined): string {
  const configured = normalizeConfigText(value);

  if (!configured) {
    return DEFAULT_OLLAMA_BASE_URL;
  }

  const withProtocol =
    /^https?:\/\//i.test(configured) ? configured : `http://${configured}`;

  return withProtocol.replace(/\/+$/, "");
}

function formatDiscoveryFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Ollama unavailable";
}

function resolveTier1CloudRoute(input: {
  label: string | null;
  provider: string | null;
  modelId: string | null;
}): {
  provider: string | null;
  modelId: string | null;
} {
  if (input.provider || input.modelId) {
    return {
      provider: input.provider,
      modelId: input.modelId,
    };
  }

  const normalized = input.label?.trim().toLowerCase();

  if (normalized === "haiku") {
    return {
      provider: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
    };
  }

  if (normalized === "sonnet") {
    return {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
    };
  }

  if (normalized === "opus") {
    return {
      provider: "anthropic",
      modelId: "claude-opus-4-1-20250805",
    };
  }

  return {
    provider: null,
    modelId: null,
  };
}

function buildModes(input: {
  bias: CognitiveRoutingBias;
  maxFanOut: number;
  maxParallel: number;
}): CognitiveRoutingMode[] {
  const pluralUseWhen =
    input.bias === "latency"
      ? "Only when ambiguity, trade-offs, or stakes make extra perspectives likely to materially change the answer."
      : input.bias === "quality"
        ? "When ambiguity, trade-offs, review pressure, or stakes make extra perspectives likely to improve the answer."
        : "When ambiguity, trade-offs, or stakes make extra perspectives likely to change the answer.";

  return [
    {
      id: "direct-answer",
      label: "Direct Answer",
      useWhen:
        "Use when extra depth is unlikely to change the answer and compact state or fresh worker output already covers the need.",
      depth: "Steward alone; deterministic status or compact-state reasoning first.",
      runtime: "Stay on the current steward lane. Do not spin workers just to restate known state.",
      fanOut: "0 extra workers.",
      parallelism: "1 lane.",
    },
    {
      id: "targeted-inspection",
      label: "Targeted Inspection",
      useWhen:
        "Use when one or two missing facts could change the answer, but extra perspectives are unlikely to.",
      depth: "Targeted reads, run inspection, or one scoped worker.",
      runtime:
        "Keep synthesis in the steward. Delegate to a single direct worker lane only when inspection must leave the steward.",
      fanOut: "0-1 worker.",
      parallelism: "1 worker; keep it serial unless checks are obviously independent.",
    },
    {
      id: "plural-synthesis",
      label: "Plural Synthesis",
      useWhen: pluralUseWhen,
      depth: "Gather distinct perspectives, then synthesize in the steward.",
      runtime:
        "Keep the steward on Pi when configured. Workers stay on direct CLI-backed lanes unless `pi-provider-<runtime>` explicitly routes them through Pi.",
      fanOut: `2 distinct perspectives by default; cap ${input.maxFanOut}.`,
      parallelism: `Cap ${input.maxParallel} concurrent workers, and only parallelize disjoint scope.`,
    },
  ];
}

export function readCognitiveRoutingPolicy(globalConfig: string): CognitiveRoutingPolicy {
  const runtimePolicy = readRuntimeAccessPolicy(globalConfig);
  const bias =
    parseBias(extractConfigValue(globalConfig, "cognitive-bias")) ?? "balanced";
  const maxFanOut = clamp(
    parsePositiveInt(extractConfigValue(globalConfig, "cognitive-max-fanout")) ??
      defaultFanOutForBias(bias),
    2,
    4,
  );
  const maxParallel = clamp(
    parsePositiveInt(extractConfigValue(globalConfig, "cognitive-max-parallel")) ??
      defaultParallelForBias(bias),
    1,
    maxFanOut,
  );

  return {
    principle:
      "Optimize expected answer quality per unit of latency and cost. Escalate only when extra cognition is likely to change the answer.",
    bias,
    defaultRuntime: runtimePolicy.defaultRuntime,
    defaultModel: runtimePolicy.defaultModel,
    maxFanOut,
    maxParallel,
    modes: buildModes({
      bias,
      maxFanOut,
      maxParallel,
    }),
    runtimeLanes: listRuntimeAdapters().map((adapter) => ({
      runtime: adapter.name,
      directAuth: getConfiguredDirectAuthPolicy(adapter.name, globalConfig),
      piRoute: resolvePiRuntimeRoute({
        globalConfig,
        runtime: adapter.name,
      }),
    })),
  };
}

export function readCognitiveTier1Config(globalConfig: string): CognitiveTier1Config {
  const localModelConfig = normalizeConfigText(
    extractConfigValueAlias(globalConfig, ["tier1_local", "tier1-local"]),
  );
  const cloudModelConfig = normalizeConfigText(
    extractConfigValueAlias(globalConfig, ["tier1_cloud", "tier1-cloud"]),
  );
  const fallbackModelConfig = normalizeConfigText(
    extractConfigValueAlias(globalConfig, ["tier1_fallback", "tier1-fallback"]),
  );
  const cloudProviderConfig = normalizeConfigText(
    extractConfigValueAlias(globalConfig, ["tier1_cloud_provider", "tier1-cloud-provider"]),
  );
  const cloudModelIdConfig = normalizeConfigText(
    extractConfigValueAlias(globalConfig, ["tier1_cloud_model", "tier1-cloud-model"]),
  );
  const fallbackProviderConfig = normalizeConfigText(
    extractConfigValueAlias(globalConfig, ["tier1_fallback_provider", "tier1-fallback-provider"]),
  );
  const fallbackModelIdConfig = normalizeConfigText(
    extractConfigValueAlias(globalConfig, ["tier1_fallback_model", "tier1-fallback-model"]),
  );
  const cloudModel = cloudModelConfig ?? DEFAULT_TIER1_CLOUD_MODEL;
  const fallbackModel = fallbackModelConfig ?? cloudModel;
  const cloudRoute = resolveTier1CloudRoute({
    label: cloudModel,
    provider: cloudProviderConfig,
    modelId: cloudModelIdConfig,
  });
  const fallbackRoute = resolveTier1CloudRoute({
    label: fallbackModel,
    provider: fallbackProviderConfig,
    modelId: fallbackModelIdConfig,
  });

  return {
    localModel: localModelConfig ?? DEFAULT_TIER1_LOCAL_MODEL,
    localConfigured: localModelConfig !== null,
    cloudModel,
    cloudConfigured:
      cloudModelConfig !== null || cloudProviderConfig !== null || cloudModelIdConfig !== null,
    cloudProvider: cloudRoute.provider,
    cloudModelId: cloudRoute.modelId,
    fallbackModel,
    fallbackConfigured:
      fallbackModelConfig !== null ||
      fallbackProviderConfig !== null ||
      fallbackModelIdConfig !== null,
    fallbackProvider: fallbackRoute.provider,
    fallbackModelId: fallbackRoute.modelId,
    ollamaBaseUrl: normalizeOllamaBaseUrl(
      extractConfigValueAlias(globalConfig, ["ollama-base-url", "ollama_base_url"]),
    ),
  };
}

export function findCognitiveRuntimeLane(
  policy: CognitiveRoutingPolicy,
  runtime: string | null | undefined,
): CognitiveRuntimeLane | null {
  if (!runtime) {
    return null;
  }

  return policy.runtimeLanes.find((lane) => lane.runtime === runtime) ?? null;
}

function isPersistentStewardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HIVE_ENABLE_PERSISTENT_STEWARD !== "0";
}

function formatRuntimeSelection(
  runtime: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (!runtime) {
    return null;
  }

  return `${runtime}${model ? ` (${model})` : " (default model)"}`;
}

function buildCognitiveExecutionLane(input: {
  lane: CognitiveRuntimeLane | null;
  selectedModel: string | null | undefined;
  persistentStewardEnabled: boolean;
}): CognitiveExecutionLane | null {
  if (!input.lane) {
    return null;
  }

  const selectedModel = normalizeConfigText(input.selectedModel);
  const usesPi = input.persistentStewardEnabled && Boolean(input.lane.piRoute.provider);

  return {
    mode: usesPi ? "persistent-pi" : "direct-runtime",
    runtime: input.lane.runtime,
    selectedModel,
    executedModel: usesPi ? input.lane.piRoute.model : selectedModel,
    directAuth: input.lane.directAuth,
    piRoute: input.lane.piRoute,
  };
}

export function resolveCognitiveExecutionLane(input: {
  globalConfig: string;
  runtime: string | null | undefined;
  selectedModel?: string | null;
  persistentStewardEnabled?: boolean;
}): CognitiveExecutionLane | null {
  const policy = readCognitiveRoutingPolicy(input.globalConfig);

  return buildCognitiveExecutionLane({
    lane: findCognitiveRuntimeLane(policy, input.runtime),
    selectedModel: input.selectedModel ?? null,
    persistentStewardEnabled:
      input.persistentStewardEnabled ?? isPersistentStewardEnabled(),
  });
}

function formatPiRoute(route: PiRuntimeRoute): string {
  if (!route.provider) {
    return "Pi not configured by default -> direct CLI-backed lane";
  }

  const source =
    route.providerSource === "env"
      ? "env override"
      : route.providerSource === "config"
        ? "config"
        : "implicit";
  const model = route.model ? ` | model: ${route.model}` : "";
  const auth = route.authPolicy ? ` | auth: ${route.authPolicy}` : "";

  return `Pi ${source} -> ${route.provider}${model}${auth}`;
}

function formatLaneLine(lane: CognitiveRuntimeLane): string {
  return `- ${lane.runtime}: direct auth ${lane.directAuth} | ${formatPiRoute(lane.piRoute)}`;
}

function formatExecutionSummary(execution: CognitiveExecutionLane | null): string | null {
  if (!execution) {
    return null;
  }

  if (execution.mode === "persistent-pi") {
    const provider = execution.piRoute.provider ?? execution.piRoute.providerContext ?? "provider unset";
    const model = execution.executedModel ?? "provider default model";
    const auth = execution.piRoute.authPolicy ? ` | auth: ${execution.piRoute.authPolicy}` : "";

    return `persistent steward via Pi | ${execution.runtime} -> ${provider} | model: ${model}${auth}`;
  }

  return `direct runtime | ${formatRuntimeSelection(execution.runtime, execution.executedModel)} | auth: ${execution.directAuth}`;
}

export function renderCognitiveExecutionSummary(
  execution: CognitiveExecutionLane | null,
): string | null {
  return formatExecutionSummary(execution);
}

function formatTier1CloudRoute(input: {
  label: string;
  provider: string | null;
  modelId: string | null;
}): string {
  if (!input.provider || !input.modelId) {
    return `${input.label} | route unset`;
  }

  return `${input.label} | ${input.provider} | ${input.modelId}`;
}

function appendUsageInspectionLines(lines: string[], usage: CognitiveUsageSnapshot | null | undefined): void {
  if (!usage) {
    return;
  }

  lines.push("");
  lines.push(`Usage (${usage.windowHours}h):`);
  lines.push(`  project: ${usage.project}`);
  lines.push(
    `  tier-3: ${usage.tiers.tier3.totalTokens} tokens | ${usage.summary.stewardWakes} steward wake(s)`,
  );
  lines.push(
    `  tier-2: ${usage.tiers.tier2.totalTokens} tokens | ${usage.summary.workerRuns} worker run(s)`,
  );
  lines.push(
    `  tier-1: ${usage.tiers.tier1.totalTokens} tokens | ${usage.summary.tier1Calls} call(s)`,
  );
  lines.push(
    `  budget tier-3: ${
      usage.budgets.tier3.tokenLimit
        ? `${usage.budgets.tier3.usedTokens}/${usage.budgets.tier3.tokenLimit} (${usage.budgets.tier3.status})`
        : `${usage.budgets.tier3.usedTokens} (${usage.budgets.tier3.status})`
    }`,
  );
  lines.push(
    `  estimated cost: ${
      usage.summary.estimatedCostUsd != null ? `$${usage.summary.estimatedCostUsd.toFixed(4)}` : "(unknown)"
    }`,
  );
  lines.push(`  last steward wake: ${usage.summary.lastStewardWakeAt ?? "(none)"}`);
}

function appendTier1InspectionLines(input: {
  lines: string[];
  tier1: CognitiveTier1Config;
  localModels?: CognitiveLocalModelDiscovery | null;
}): void {
  input.lines.push("");
  input.lines.push("Tier 1:");
  input.lines.push(`  local model: ${input.tier1.localModel}`);
  input.lines.push(`  cloud route: ${formatTier1CloudRoute({
    label: input.tier1.cloudModel,
    provider: input.tier1.cloudProvider,
    modelId: input.tier1.cloudModelId,
  })}`);
  input.lines.push(`  fallback route: ${formatTier1CloudRoute({
    label: input.tier1.fallbackModel,
    provider: input.tier1.fallbackProvider,
    modelId: input.tier1.fallbackModelId,
  })}`);
  input.lines.push(`  ollama base url: ${input.localModels?.baseUrl ?? input.tier1.ollamaBaseUrl}`);

  if (!input.localModels) {
    return;
  }

  input.lines.push(
    `  local discovery: ${input.localModels.available ? "available" : "unavailable"}${input.localModels.reason ? ` | ${input.localModels.reason}` : ""}`,
  );
  input.lines.push(`  configured local status: ${input.localModels.configuredModelStatus}`);
  input.lines.push(
    `  discovered local models: ${
      input.localModels.models.length > 0
        ? input.localModels.models.map((model) => model.name).join(", ")
        : "(none)"
    }`,
  );
}

function appendModeInspectionLines(lines: string[], modes: CognitiveRoutingMode[]): void {
  lines.push("");
  lines.push("Modes:");

  for (const mode of modes) {
    lines.push(`  ${mode.id}`);
    lines.push(`    when: ${mode.useWhen}`);
    lines.push(`    depth: ${mode.depth}`);
    lines.push(`    runtime: ${mode.runtime}`);
    lines.push(`    fan-out: ${mode.fanOut}`);
    lines.push(`    parallelism: ${mode.parallelism}`);
  }
}

function appendRuntimeLaneInspectionLines(lines: string[], lanes: CognitiveRuntimeLane[]): void {
  lines.push("");
  lines.push("Runtime lanes:");

  for (const lane of lanes) {
    lines.push(`  ${lane.runtime}`);
    lines.push(`    direct auth: ${lane.directAuth}`);
    lines.push(`    pi route: ${formatPiRoute(lane.piRoute)}`);
  }
}

function normalizeDiscoveredModel(
  value: unknown,
): CognitiveLocalModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = normalizeConfigText(
    typeof record.name === "string" ? record.name : null,
  );

  if (!name) {
    return null;
  }

  return {
    name,
    sizeBytes:
      typeof record.size === "number" && Number.isFinite(record.size)
        ? record.size
        : null,
    modifiedAt:
      typeof record.modified_at === "string" && record.modified_at.trim()
        ? record.modified_at
        : null,
    digest:
      typeof record.digest === "string" && record.digest.trim()
        ? record.digest
        : null,
  };
}

export async function discoverLocalModels(input?: {
  baseUrl?: string | null;
  configuredModel?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<CognitiveLocalModelDiscovery> {
  const baseUrl = normalizeOllamaBaseUrl(input?.baseUrl);
  const configuredModel = normalizeConfigText(input?.configuredModel);
  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input?.timeoutMs ?? 750;
  const cacheKey = `${baseUrl}::${configuredModel ?? ""}`;
  const shouldUseCache = !input?.fetchImpl;
  const cached = shouldUseCache ? localModelDiscoveryCache.get(cacheKey) : null;

  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      const result = {
        baseUrl,
        available: false,
        reason: `HTTP ${response.status}`,
        configuredModelStatus: configuredModel ? "unavailable" : "unconfigured",
        models: [],
      };

      if (shouldUseCache) {
        localModelDiscoveryCache.set(cacheKey, {
          expiresAt: Date.now() + LOCAL_MODEL_DISCOVERY_CACHE_TTL_MS,
          result,
        });
      }

      return result;
    }

    const payload = await response.json() as {
      models?: unknown[];
    };
    const models = Array.isArray(payload?.models)
      ? payload.models
          .map((item) => normalizeDiscoveredModel(item))
          .filter((item): item is CognitiveLocalModel => Boolean(item))
          .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    const hasConfiguredModel =
      configuredModel !== null &&
      models.some((model) => model.name === configuredModel);

    const result = {
      baseUrl,
      available: true,
      reason: null,
      configuredModelStatus:
        configuredModel === null
          ? "unconfigured"
          : hasConfiguredModel
            ? "available"
            : "missing",
      models,
    };

    if (shouldUseCache) {
      localModelDiscoveryCache.set(cacheKey, {
        expiresAt: Date.now() + LOCAL_MODEL_DISCOVERY_CACHE_TTL_MS,
        result,
      });
    }

    return result;
  } catch (error) {
    const result = {
      baseUrl,
      available: false,
      reason: formatDiscoveryFailure(error),
      configuredModelStatus: configuredModel ? "unavailable" : "unconfigured",
      models: [],
    };

    if (shouldUseCache) {
      localModelDiscoveryCache.set(cacheKey, {
        expiresAt: Date.now() + LOCAL_MODEL_DISCOVERY_CACHE_TTL_MS,
        result,
      });
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildCognitiveRoutingSnapshot(input: {
  globalConfig: string;
  session?: CognitiveSessionContext | null;
  persistentStewardEnabled?: boolean;
  fetchImpl?: FetchLike;
}): Promise<CognitiveRoutingSnapshot> {
  const policy = readCognitiveRoutingPolicy(input.globalConfig);
  const tier1 = readCognitiveTier1Config(input.globalConfig);
  const activeLane = findCognitiveRuntimeLane(policy, input.session?.runtime);
  const defaultLane = findCognitiveRuntimeLane(policy, policy.defaultRuntime);
  const persistentStewardEnabled =
    input.persistentStewardEnabled ?? isPersistentStewardEnabled();

  return {
    policy,
    activeSession: input.session ?? null,
    activeLane,
    activeExecution: buildCognitiveExecutionLane({
      lane: activeLane,
      selectedModel: input.session?.model ?? null,
      persistentStewardEnabled,
    }),
    defaultLane,
    defaultExecution: buildCognitiveExecutionLane({
      lane: defaultLane,
      selectedModel: policy.defaultModel,
      persistentStewardEnabled,
    }),
    tier1,
    localModels: await discoverLocalModels({
      baseUrl: tier1.ollamaBaseUrl,
      configuredModel: tier1.localModel,
      fetchImpl: input.fetchImpl,
    }),
  };
}

export function renderCognitiveRoutingPromptPolicy(input: {
  globalConfig: string;
  skillsDir?: string | null;
  sessionRuntime?: string | null;
  sessionModel?: string | null;
}): string {
  const policy = readCognitiveRoutingPolicy(input.globalConfig);
  const currentLane = findCognitiveRuntimeLane(policy, input.sessionRuntime);
  const skillPath = input.skillsDir
    ? `${input.skillsDir}/${COGNITIVE_ROUTING_SKILL_NAME}.md`
    : null;
  const lines: string[] = [];

  if (skillPath) {
    lines.push(`- skill: ${skillPath}`);
  }

  lines.push(`- principle: ${policy.principle}`);
  lines.push(
    `- policy: bias ${policy.bias} | max fan-out ${policy.maxFanOut} | max parallel ${policy.maxParallel}`,
  );

  if (currentLane) {
    const runtimeLabel = `${currentLane.runtime}${input.sessionModel ? ` (${input.sessionModel})` : ""}`;
    lines.push(
      `- current steward lane: ${runtimeLabel} | direct auth ${currentLane.directAuth} | ${formatPiRoute(currentLane.piRoute)}`,
    );
  } else if (policy.defaultRuntime) {
    const defaultLane = findCognitiveRuntimeLane(policy, policy.defaultRuntime);

    if (defaultLane) {
      const model = policy.defaultModel ? ` (${policy.defaultModel})` : "";
      lines.push(
        `- default steward lane: ${defaultLane.runtime}${model} | direct auth ${defaultLane.directAuth} | ${formatPiRoute(defaultLane.piRoute)}`,
      );
    }
  }

  lines.push("");
  lines.push("Modes:");

  for (const mode of policy.modes) {
    lines.push(
      `- ${mode.id}: ${mode.useWhen} Depth: ${mode.depth} Runtime: ${mode.runtime} Fan-out: ${mode.fanOut} Parallelism: ${mode.parallelism}`,
    );
  }

  lines.push("");
  lines.push("Lane rules:");

  for (const lane of policy.runtimeLanes) {
    lines.push(formatLaneLine(lane));
  }

  lines.push("- Reuse fresh worker output before launching new workers.");
  lines.push(
    "- Only parallelize workers when scopes are independent and the quality gain justifies the extra wait.",
  );

  return lines.join("\n");
}

export function renderCognitiveRoutingInspectionSnapshot(input: {
  snapshot: CognitiveRoutingSnapshot;
  usage?: CognitiveUsageSnapshot | null;
  configPath: string;
  skillsDir?: string | null;
}): string {
  const lines: string[] = [
    "Cognitive routing policy:",
    "",
    `  principle: ${input.snapshot.policy.principle}`,
    `  bias: ${input.snapshot.policy.bias}`,
    `  default runtime: ${input.snapshot.policy.defaultRuntime ?? "(unset)"}`,
    `  default model: ${input.snapshot.policy.defaultModel ?? "(unset)"}`,
    `  max fan-out: ${input.snapshot.policy.maxFanOut}`,
    `  max parallel workers: ${input.snapshot.policy.maxParallel}`,
  ];

  if (input.snapshot.activeSession) {
    lines.push(
      `  active session: ${input.snapshot.activeSession.sessionId} | project ${input.snapshot.activeSession.project}`,
    );
    lines.push(
      `  session selection: ${
        formatRuntimeSelection(
          input.snapshot.activeSession.runtime,
          input.snapshot.activeSession.model,
        ) ?? "(unset)"
      }`,
    );
  } else {
    lines.push("  active session: (none)");
  }

  const activeExecutionSummary = formatExecutionSummary(input.snapshot.activeExecution);

  if (activeExecutionSummary) {
    lines.push(`  current execution: ${activeExecutionSummary}`);
  }

  const defaultExecutionSummary = formatExecutionSummary(input.snapshot.defaultExecution);

  if (defaultExecutionSummary) {
    lines.push(`  default execution: ${defaultExecutionSummary}`);
  }

  appendTier1InspectionLines({
    lines,
    tier1: input.snapshot.tier1,
    localModels: input.snapshot.localModels,
  });
  appendModeInspectionLines(lines, input.snapshot.policy.modes);
  appendRuntimeLaneInspectionLines(lines, input.snapshot.policy.runtimeLanes);

  appendUsageInspectionLines(lines, input.usage ?? null);

  if (input.skillsDir) {
    lines.push("");
    lines.push(`Skill: ${input.skillsDir}/${COGNITIVE_ROUTING_SKILL_NAME}.md`);
  }

  lines.push(`Config: ${input.configPath}`);

  return lines.join("\n");
}
