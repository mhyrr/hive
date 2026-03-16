import {
  getConfiguredDirectAuthPolicy,
  listRuntimeAdapters,
  readRuntimeAccessPolicy,
  resolvePiRuntimeRoute,
  type PiRuntimeRoute,
  type RuntimeAuthPolicy,
} from "./runtime";

export const COGNITIVE_ROUTING_SKILL_NAME = "cognitive-resource-routing";

export const STEWARD_ESSENTIAL_SKILL_NAMES = [
  "state-efficient-ops",
  "autonomous-ops",
  COGNITIVE_ROUTING_SKILL_NAME,
] as const;

export type CognitiveRoutingBias = "latency" | "balanced" | "quality";

export type CognitiveRoutingModeId =
  | "direct-answer"
  | "targeted-inspection"
  | "plural-synthesis";

export type CognitiveRoutingMode = {
  id: CognitiveRoutingModeId;
  label: string;
  useWhen: string;
  depth: string;
  runtime: string;
  fanOut: string;
  parallelism: string;
};

export type CognitiveRuntimeLane = {
  runtime: string;
  directAuth: RuntimeAuthPolicy;
  piRoute: PiRuntimeRoute;
};

export type CognitiveRoutingPolicy = {
  principle: string;
  bias: CognitiveRoutingBias;
  defaultRuntime: string | null;
  defaultModel: string | null;
  maxFanOut: number;
  maxParallel: number;
  modes: CognitiveRoutingMode[];
  runtimeLanes: CognitiveRuntimeLane[];
};

export type CognitiveTier1Config = {
  localModel: string;
  cloudModel: string;
  fallbackModel: string;
  ollamaBaseUrl: string;
};

export type CognitiveLocalModel = {
  name: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  digest: string | null;
};

export type CognitiveLocalModelDiscovery = {
  baseUrl: string;
  available: boolean;
  reason: string | null;
  configuredModelStatus: "available" | "missing" | "unavailable" | "unconfigured";
  models: CognitiveLocalModel[];
};

export type CognitiveSessionContext = {
  sessionId: string;
  project: string;
  runtime: string;
  model: string | null;
};

export type CognitiveRoutingSnapshot = {
  policy: CognitiveRoutingPolicy;
  activeSession: CognitiveSessionContext | null;
  activeLane: CognitiveRuntimeLane | null;
  defaultLane: CognitiveRuntimeLane | null;
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

function extractConfigValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));

  return match ? match[1].trim() : null;
}

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

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value.trim());

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
  const cloudModel =
    normalizeConfigText(extractConfigValue(globalConfig, "tier1_cloud")) ??
    DEFAULT_TIER1_CLOUD_MODEL;

  return {
    localModel:
      normalizeConfigText(extractConfigValue(globalConfig, "tier1_local")) ??
      DEFAULT_TIER1_LOCAL_MODEL,
    cloudModel,
    fallbackModel:
      normalizeConfigText(extractConfigValue(globalConfig, "tier1_fallback")) ??
      cloudModel,
    ollamaBaseUrl: normalizeOllamaBaseUrl(
      extractConfigValue(globalConfig, "ollama-base-url"),
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

function formatLaneSummary(
  lane: CognitiveRuntimeLane | null,
  model: string | null | undefined,
): string | null {
  if (!lane) {
    return null;
  }

  const runtimeLabel = `${lane.runtime}${model ? ` (${model})` : ""}`;

  return `${runtimeLabel} | direct auth ${lane.directAuth} | ${formatPiRoute(lane.piRoute)}`;
}

export async function buildCognitiveRoutingSnapshot(input: {
  globalConfig: string;
  session?: CognitiveSessionContext | null;
  fetchImpl?: FetchLike;
}): Promise<CognitiveRoutingSnapshot> {
  const policy = readCognitiveRoutingPolicy(input.globalConfig);
  const tier1 = readCognitiveTier1Config(input.globalConfig);

  return {
    policy,
    activeSession: input.session ?? null,
    activeLane: findCognitiveRuntimeLane(policy, input.session?.runtime),
    defaultLane: findCognitiveRuntimeLane(policy, policy.defaultRuntime),
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

export function renderCognitiveRoutingInspection(input: {
  globalConfig: string;
  configPath: string;
  skillsDir?: string | null;
}): string {
  const policy = readCognitiveRoutingPolicy(input.globalConfig);
  const tier1 = readCognitiveTier1Config(input.globalConfig);
  const lines: string[] = [
    "Cognitive routing policy:",
    "",
    `  principle: ${policy.principle}`,
    `  bias: ${policy.bias}`,
    `  default runtime: ${policy.defaultRuntime ?? "(unset)"}`,
    `  default model: ${policy.defaultModel ?? "(unset)"}`,
    `  max fan-out: ${policy.maxFanOut}`,
    `  max parallel workers: ${policy.maxParallel}`,
    "",
    "Tier 1:",
    `  local model: ${tier1.localModel}`,
    `  cloud model: ${tier1.cloudModel}`,
    `  fallback model: ${tier1.fallbackModel}`,
    `  ollama base url: ${tier1.ollamaBaseUrl}`,
    "",
    "Modes:",
  ];

  for (const mode of policy.modes) {
    lines.push(`  ${mode.id}`);
    lines.push(`    when: ${mode.useWhen}`);
    lines.push(`    depth: ${mode.depth}`);
    lines.push(`    runtime: ${mode.runtime}`);
    lines.push(`    fan-out: ${mode.fanOut}`);
    lines.push(`    parallelism: ${mode.parallelism}`);
  }

  lines.push("");
  lines.push("Runtime lanes:");

  for (const lane of policy.runtimeLanes) {
    lines.push(`  ${lane.runtime}`);
    lines.push(`    direct auth: ${lane.directAuth}`);
    lines.push(`    pi route: ${formatPiRoute(lane.piRoute)}`);
  }

  if (input.skillsDir) {
    lines.push("");
    lines.push(`Skill: ${input.skillsDir}/${COGNITIVE_ROUTING_SKILL_NAME}.md`);
  }

  lines.push(`Config: ${input.configPath}`);

  return lines.join("\n");
}

export function renderCognitiveRoutingInspectionSnapshot(input: {
  snapshot: CognitiveRoutingSnapshot;
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
      `  active session: ${input.snapshot.activeSession.sessionId} | project ${input.snapshot.activeSession.project} | runtime ${input.snapshot.activeSession.runtime}${input.snapshot.activeSession.model ? ` (${input.snapshot.activeSession.model})` : ""}`,
    );
  } else {
    lines.push("  active session: (none)");
  }

  const activeLaneSummary = formatLaneSummary(
    input.snapshot.activeLane,
    input.snapshot.activeSession?.model ?? null,
  );

  if (activeLaneSummary) {
    lines.push(`  current lane: ${activeLaneSummary}`);
  }

  const defaultLaneSummary = formatLaneSummary(
    input.snapshot.defaultLane,
    input.snapshot.policy.defaultModel,
  );

  if (defaultLaneSummary) {
    lines.push(`  default lane: ${defaultLaneSummary}`);
  }

  lines.push("");
  lines.push("Tier 1:");
  lines.push(`  local model: ${input.snapshot.tier1.localModel}`);
  lines.push(`  cloud model: ${input.snapshot.tier1.cloudModel}`);
  lines.push(`  fallback model: ${input.snapshot.tier1.fallbackModel}`);
  lines.push(`  ollama base url: ${input.snapshot.localModels.baseUrl}`);
  lines.push(
    `  local discovery: ${input.snapshot.localModels.available ? "available" : "unavailable"}${input.snapshot.localModels.reason ? ` | ${input.snapshot.localModels.reason}` : ""}`,
  );
  lines.push(
    `  configured local status: ${input.snapshot.localModels.configuredModelStatus}`,
  );
  lines.push(
    `  discovered local models: ${
      input.snapshot.localModels.models.length > 0
        ? input.snapshot.localModels.models.map((model) => model.name).join(", ")
        : "(none)"
    }`,
  );
  lines.push("");
  lines.push("Modes:");

  for (const mode of input.snapshot.policy.modes) {
    lines.push(`  ${mode.id}`);
    lines.push(`    when: ${mode.useWhen}`);
    lines.push(`    depth: ${mode.depth}`);
    lines.push(`    runtime: ${mode.runtime}`);
    lines.push(`    fan-out: ${mode.fanOut}`);
    lines.push(`    parallelism: ${mode.parallelism}`);
  }

  lines.push("");
  lines.push("Runtime lanes:");

  for (const lane of input.snapshot.policy.runtimeLanes) {
    lines.push(`  ${lane.runtime}`);
    lines.push(`    direct auth: ${lane.directAuth}`);
    lines.push(`    pi route: ${formatPiRoute(lane.piRoute)}`);
  }

  if (input.skillsDir) {
    lines.push("");
    lines.push(`Skill: ${input.skillsDir}/${COGNITIVE_ROUTING_SKILL_NAME}.md`);
  }

  lines.push(`Config: ${input.configPath}`);

  return lines.join("\n");
}
