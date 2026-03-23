import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { extractConfigValue } from "./config";
import { UsageError } from "./errors";
import { PlanAgent, TeamAgent } from "./project";

// --- Runtime Adapter Interface ---

export type RuntimeMetadata = {
  authMode: "subscription" | "api" | "unknown";
  costUsd: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  totalTokens: number | null;
};

export type ParsedOutput = {
  text: string;
  metadata: RuntimeMetadata | null;
};

type RuntimeOutputCapture = {
  handleStdoutLine: (line: string) => string | null;
};

export type RuntimeAdapter = {
  name: string;
  aliases: string[];
  command: string;
  buildLaunchArgs: (input: {
    model: string | null;
    repoPath: string;
    hiveHome: string;
    prompt: string;
  }) => string[];
  buildInteractiveArgs: (input: {
    model: string | null;
    repoPath: string;
    hiveHome: string;
    systemPrompt: string;
  }) => string[];
  suppressLine: (line: string) => boolean;
  detectInstalled: () => Promise<boolean>;
  parseOutput?: (rawStdout: string) => ParsedOutput;
  createOutputCapture?: () => RuntimeOutputCapture;
};

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFirstNumber(
  record: Record<string, unknown> | null,
  keys: string[],
): number | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = toNullableNumber(record[key]);

    if (value !== null) {
      return value;
    }
  }

  return null;
}

function withDerivedTotalTokens(metadata: RuntimeMetadata): RuntimeMetadata {
  if (metadata.totalTokens !== null) {
    return metadata;
  }

  const parts = [
    metadata.inputTokens,
    metadata.outputTokens,
    metadata.cacheCreationInputTokens,
    metadata.cacheReadInputTokens,
  ].filter((value): value is number => value !== null);

  return {
    ...metadata,
    totalTokens: parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : null,
  };
}

function parseStructuredRuntimeMetadata(
  runtime: string,
  data: unknown,
): RuntimeMetadata {
  const root = toRecord(data);
  const usage = toRecord(root?.usage);

  return withDerivedTotalTokens({
    authMode: inferRuntimeAuthMode(runtime),
    costUsd:
      readFirstNumber(root, ["cost_usd", "total_cost_usd"]) ??
      readFirstNumber(usage, ["cost_usd", "total_cost_usd"]),
    durationMs: readFirstNumber(root, ["duration_ms"]),
    durationApiMs: readFirstNumber(root, ["duration_api_ms"]),
    numTurns:
      readFirstNumber(root, ["num_turns"]) ??
      readFirstNumber(usage, ["num_turns"]),
    sessionId: typeof root?.session_id === "string" ? root.session_id : null,
    inputTokens:
      readFirstNumber(root, ["input_tokens", "prompt_tokens"]) ??
      readFirstNumber(usage, ["input_tokens", "prompt_tokens"]),
    outputTokens:
      readFirstNumber(root, ["output_tokens", "completion_tokens"]) ??
      readFirstNumber(usage, ["output_tokens", "completion_tokens"]),
    cacheCreationInputTokens:
      readFirstNumber(root, ["cache_creation_input_tokens", "cache_creation_tokens"]) ??
      readFirstNumber(usage, ["cache_creation_input_tokens", "cache_creation_tokens"]),
    cacheReadInputTokens:
      readFirstNumber(root, ["cache_read_input_tokens", "cache_read_tokens"]) ??
      readFirstNumber(usage, ["cache_read_input_tokens", "cache_read_tokens"]),
    totalTokens:
      readFirstNumber(root, ["total_tokens"]) ??
      readFirstNumber(usage, ["total_tokens"]),
  });
}

function baseRuntimeMetadata(runtime: string): RuntimeMetadata {
  return {
    authMode: inferRuntimeAuthMode(runtime),
    costUsd: null,
    durationMs: null,
    durationApiMs: null,
    numTurns: null,
    sessionId: null,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    totalTokens: null,
  };
}

function hasEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(env[key]?.trim());
}

export function inferRuntimeAuthMode(
  runtime: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeMetadata["authMode"] {
  const normalized = runtime.trim().toLowerCase();

  if (normalized === "claude" || normalized === "claude-code") {
    return "subscription";
  }

  if (normalized === "codex" || normalized === "openai") {
    return hasEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
  }

  if (normalized === "gemini" || normalized === "gemini-cli" || normalized === "google") {
    return hasEnvValue(env, "GEMINI_API_KEY") || hasEnvValue(env, "GOOGLE_API_KEY")
      ? "api"
      : "subscription";
  }

  if (normalized === "ollama" || normalized === "local" || normalized === "oss") {
    return "api";
  }

  return "unknown";
}

export function formatRuntimeTokenSummary(metadata: RuntimeMetadata | null): string | null {
  if (!metadata) {
    return null;
  }

  const parts: string[] = [];

  if (metadata.inputTokens !== null) {
    parts.push(`in ${metadata.inputTokens}`);
  }

  if (metadata.outputTokens !== null) {
    parts.push(`out ${metadata.outputTokens}`);
  }

  if (metadata.cacheCreationInputTokens !== null) {
    parts.push(`cache write ${metadata.cacheCreationInputTokens}`);
  }

  if (metadata.cacheReadInputTokens !== null) {
    parts.push(`cache read ${metadata.cacheReadInputTokens}`);
  }

  if (metadata.totalTokens !== null) {
    parts.push(`total ${metadata.totalTokens}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

function extractClaudeContentText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const parts: string[] = [];

  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }

    const record = toRecord(item);

    if (!record) {
      continue;
    }

    const text = toNullableString(record.text);

    if (text) {
      parts.push(text);
      continue;
    }

    const nested = extractClaudeContentText(record.content);

    if (nested) {
      parts.push(nested);
    }
  }

  return parts.length > 0 ? parts.join("") : null;
}

function extractClaudeSnapshotText(data: unknown): string | null {
  const root = toRecord(data);
  const message = toRecord(root?.message);

  return (
    extractClaudeContentText(message?.content) ??
    extractClaudeContentText(root?.content) ??
    toNullableString(root?.result)
  );
}

function createClaudeOutputCapture(): RuntimeOutputCapture {
  let lastSnapshot = "";

  return {
    handleStdoutLine(line: string) {
      let data: unknown;

      try {
        data = JSON.parse(line);
      } catch {
        return null;
      }

      const root = toRecord(data);

      if (!root) {
        return null;
      }

      const delta = toRecord(root.delta);
      const deltaText = toNullableString(delta?.text);

      if (toNullableString(root.type) === "content_block_delta" && deltaText) {
        lastSnapshot += deltaText;
        return deltaText;
      }

      const snapshot = extractClaudeSnapshotText(root);

      if (!snapshot || snapshot === lastSnapshot) {
        return null;
      }

      const chunk = snapshot.startsWith(lastSnapshot)
        ? snapshot.slice(lastSnapshot.length)
        : snapshot;

      lastSnapshot = snapshot;
      return chunk || null;
    },
  };
}

// --- Codex JSONL Output Parsing ---

function parseCodexJsonlOutput(rawStdout: string): ParsedOutput {
  const lines = rawStdout.trim().split("\n");
  let lastAgentMessage = "";
  let metadata: RuntimeMetadata | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || !trimmed.startsWith("{")) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      const root = toRecord(event);

      if (!root) {
        continue;
      }

      const eventType = toNullableString(root.type);

      // Extract text from agent_message items
      if (eventType === "item.completed" || eventType === "item.updated") {
        const itemType = toNullableString(root.item_type);
        const text = toNullableString(root.text);

        if (itemType === "agent_message" && text) {
          lastAgentMessage = text;
        }
      }

      // Extract usage from turn.completed
      if (eventType === "turn.completed") {
        const usage = toRecord(root.usage);

        if (usage) {
          metadata = withDerivedTotalTokens({
            authMode: "api",
            costUsd: null,
            durationMs: null,
            durationApiMs: null,
            numTurns: null,
            sessionId: null,
            inputTokens: readFirstNumber(usage, ["input_tokens", "prompt_tokens"]),
            outputTokens: readFirstNumber(usage, ["output_tokens", "completion_tokens"]),
            cacheCreationInputTokens: null,
            cacheReadInputTokens: readFirstNumber(usage, ["cached_input_tokens"]),
            totalTokens: readFirstNumber(usage, ["total_tokens"]),
          });
        }
      }
    } catch {
      // Skip malformed JSON lines
    }
  }

  return {
    text: lastAgentMessage || rawStdout.trim(),
    metadata,
  };
}

function createCodexOutputCapture(): RuntimeOutputCapture {
  let currentMessage = "";

  return {
    handleStdoutLine(line: string) {
      let data: unknown;

      try {
        data = JSON.parse(line);
      } catch {
        return null;
      }

      const root = toRecord(data);

      if (!root) {
        return null;
      }

      const eventType = toNullableString(root.type);

      // Handle agent message text updates
      if (
        (eventType === "item.completed" || eventType === "item.updated") &&
        toNullableString(root.item_type) === "agent_message"
      ) {
        const text = toNullableString(root.text);

        if (text && text.length > currentMessage.length) {
          const chunk = text.slice(currentMessage.length);
          currentMessage = text;
          return chunk;
        }
      }

      return null;
    },
  };
}

// --- Built-in Adapters ---

const claudeAdapter: RuntimeAdapter = {
  name: "claude",
  aliases: ["claude-code"],
  command: "claude",
  buildLaunchArgs: ({ model, hiveHome, prompt }) => [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    prompt,
  ],
  buildInteractiveArgs: ({ model, hiveHome, systemPrompt }) => [
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    "--system-prompt",
    systemPrompt,
  ],
  suppressLine: () => false,
  detectInstalled: () => commandExists("claude"),
  createOutputCapture: () => createClaudeOutputCapture(),
  parseOutput: (rawStdout: string) => {
    const trimmed = rawStdout.trim();

    if (!trimmed) {
      return { text: "", metadata: null };
    }

    // Try to parse the last non-empty line as JSON (Claude --print --output-format json)
    const lines = trimmed.split("\n");
    let jsonStr = trimmed;

    // If there are multiple lines, try the last line first (JSON is usually on one line)
    if (lines.length > 1) {
      const lastLine = lines[lines.length - 1]!.trim();

      if (lastLine.startsWith("{")) {
        jsonStr = lastLine;
      }
    }

    try {
      const data = JSON.parse(jsonStr);

      return {
        text: typeof data.result === "string" ? data.result : trimmed,
        metadata: parseStructuredRuntimeMetadata("claude", data),
      };
    } catch {
      let assistantText = "";
      let metadataSource: unknown = null;

      for (const line of lines) {
        const candidate = line.trim();

        if (!candidate) {
          continue;
        }

        try {
          const data = JSON.parse(candidate);
          const root = toRecord(data);

          if (!root) {
            continue;
          }

          const delta = toRecord(root.delta);
          const deltaText = toNullableString(delta?.text);

          if (toNullableString(root.type) === "content_block_delta" && deltaText) {
            assistantText += deltaText;
          } else {
            const snapshot = extractClaudeSnapshotText(root);

            if (snapshot) {
              assistantText = snapshot;
            }
          }

          if (
            root.usage ||
            root.duration_ms !== undefined ||
            root.cost_usd !== undefined ||
            root.total_cost_usd !== undefined ||
            root.num_turns !== undefined ||
            root.session_id !== undefined ||
            root.input_tokens !== undefined ||
            root.output_tokens !== undefined ||
            root.total_tokens !== undefined
          ) {
            metadataSource = data;
          }
        } catch {
          // Ignore malformed stream lines and fall back to the final raw output.
        }
      }

      return {
        text: assistantText || trimmed,
        metadata: metadataSource ? parseStructuredRuntimeMetadata("claude", metadataSource) : null,
      };
    }
  },
};

function isCodexNoiseLine(line: string): boolean {
  const trimmed = line.trim();

  if (!trimmed) {
    return false;
  }

  return (
    trimmed === "mcp startup: no servers" ||
    /WARN codex_core::state_db: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back\b/.test(
      trimmed,
    ) ||
    /ERROR codex_core::rollout::list: state db missing rollout path for thread\b/.test(
      trimmed,
    )
  );
}

const codexAdapter: RuntimeAdapter = {
  name: "codex",
  aliases: ["openai"],
  command: "codex",
  buildLaunchArgs: ({ model, repoPath, hiveHome, prompt }) => [
    "exec",
    "--full-auto",
    "--json",
    "-C",
    repoPath,
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    prompt,
  ],
  buildInteractiveArgs: ({ model, repoPath, hiveHome, systemPrompt }) => [
    "--full-auto",
    "-C",
    repoPath,
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    systemPrompt,
  ],
  suppressLine: isCodexNoiseLine,
  detectInstalled: () => commandExists("codex"),
  parseOutput: parseCodexJsonlOutput,
  createOutputCapture: () => createCodexOutputCapture(),
};

const geminiAdapter: RuntimeAdapter = {
  name: "gemini",
  aliases: ["gemini-cli", "google"],
  command: "gemini",
  buildLaunchArgs: ({ model, repoPath, prompt }) => [
    "-C",
    repoPath,
    ...(model ? ["--model", model] : []),
    prompt,
  ],
  buildInteractiveArgs: ({ model, repoPath }) => [
    "-C",
    repoPath,
    ...(model ? ["--model", model] : []),
  ],
  suppressLine: () => false,
  detectInstalled: () => commandExists("gemini"),
};

const ollamaAdapter: RuntimeAdapter = {
  name: "ollama",
  aliases: ["local", "oss"],
  command: "codex",
  buildLaunchArgs: ({ model, repoPath, hiveHome, prompt }) => [
    "exec",
    "--full-auto",
    "--json",
    "--oss",
    "--local-provider",
    "ollama",
    "-C",
    repoPath,
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    prompt,
  ],
  buildInteractiveArgs: ({ model, repoPath, hiveHome, systemPrompt }) => [
    "--full-auto",
    "--oss",
    "--local-provider",
    "ollama",
    "-C",
    repoPath,
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    systemPrompt,
  ],
  suppressLine: isCodexNoiseLine,
  detectInstalled: async () => {
    const [hasCodex, hasOllama] = await Promise.all([
      commandExists("codex"),
      commandExists("ollama"),
    ]);

    return hasCodex && hasOllama;
  },
  parseOutput: parseCodexJsonlOutput,
  createOutputCapture: () => createCodexOutputCapture(),
};

// --- Registry ---

const builtinAdapters: RuntimeAdapter[] = [claudeAdapter, codexAdapter, geminiAdapter, ollamaAdapter];

function buildRegistry(adapters: RuntimeAdapter[]): Map<string, RuntimeAdapter> {
  const map = new Map<string, RuntimeAdapter>();

  for (const adapter of adapters) {
    map.set(adapter.name, adapter);

    for (const alias of adapter.aliases) {
      map.set(alias, adapter);
    }
  }

  return map;
}

const registry = buildRegistry(builtinAdapters);

// --- Public Registry API ---

export function getAdapter(name: string): RuntimeAdapter | null {
  return registry.get(name.trim().toLowerCase()) ?? null;
}

export function listRuntimeAdapters(): RuntimeAdapter[] {
  return [...builtinAdapters];
}

// --- Utility ---

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;

    return code === 0;
  } catch {
    return false;
  }
}

// --- Types (backward compatible) ---

export type RuntimeName = string;

export type LaunchSpec = {
  runtime: string;
  model: string | null;
  command: string;
  args: string[];
};

export type LaunchResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  visibleOutput: string;
  metadata: RuntimeMetadata | null;
};

export type InteractiveResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type InteractiveHandle = {
  pid: number | null;
  wait: () => Promise<InteractiveResult>;
};

export type LaunchHandle = {
  pid: number | null;
  wait: () => Promise<LaunchResult>;
};

type LaunchHandleOptions = {
  outputPath?: string | null;
  quiet?: boolean;
};

export type RuntimeHints = {
  runtime: string;
  model: string | null;
};

export type RuntimeAuthPolicy = "subscription" | "cli" | "api" | "unknown";

type PiProviderAuthPolicy = "oauth-only" | "env";

type RuntimeAccessPolicy = {
  defaultRuntime: string | null;
  defaultModel: string | null;
  directAuthByRuntime: Record<string, RuntimeAuthPolicy>;
  piProvider: string | null;
  piModel: string | null;
  piProviderByRuntime: Record<string, string | null>;
  piModelByRuntime: Record<string, string | null>;
};

export type PiRuntimeRoute = {
  runtime: string;
  provider: string | null;
  model: string | null;
  providerContext: string | null;
  authPolicy: PiProviderAuthPolicy | null;
  providerSource: "env" | "config" | "implicit";
  modelSource: "env" | "config" | "implicit";
};

type ResolveHintsInput = {
  globalConfig: string;
  teamAgent?: TeamAgent | null;
  planAgent?: PlanAgent | null;
  runtimeOverride?: string | null;
  modelOverride?: string | null;
  assignmentRuntime?: string | null;
  assignmentModel?: string | null;
};

// --- Config / Descriptor Helpers ---

function extractBodyValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));

  return match ? match[1].trim() : null;
}

function normalizeRuntimeName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const adapter = getAdapter(value);

  return adapter ? adapter.name : null;
}

function defaultDirectAuthPolicy(runtime: string): RuntimeAuthPolicy {
  const normalized = normalizeRuntimeName(runtime) ?? runtime.trim().toLowerCase();

  if (normalized === "claude") {
    return "subscription";
  }

  if (normalized === "codex" || normalized === "gemini") {
    return "cli";
  }

  return "unknown";
}

function parseRuntimeAuthPolicy(value: string | null | undefined): RuntimeAuthPolicy | null {
  const normalized = value?.trim().toLowerCase();

  if (
    normalized === "subscription" ||
    normalized === "cli" ||
    normalized === "api" ||
    normalized === "unknown"
  ) {
    return normalized;
  }

  return null;
}

function normalizeProviderName(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();

  return normalized || null;
}

function defaultPiProviderForRuntime(runtime: string): string | null {
  const normalized = normalizeRuntimeName(runtime) ?? runtime.trim().toLowerCase();

  if (normalized === "claude") {
    return "anthropic";
  }

  return null;
}

function defaultPiAuthPolicyForProvider(provider: string | null): PiProviderAuthPolicy | null {
  if (!provider) {
    return null;
  }

  if (provider === "anthropic") {
    return "oauth-only";
  }

  return "env";
}

function parsePiProviderAuthPolicy(value: string | null | undefined): PiProviderAuthPolicy | null {
  const normalized = value?.trim().toLowerCase();

  if (
    normalized === "oauth-only" ||
    normalized === "oauth" ||
    normalized === "subscription"
  ) {
    return "oauth-only";
  }

  if (
    normalized === "env" ||
    normalized === "api" ||
    normalized === "allow-api" ||
    normalized === "api-or-oauth"
  ) {
    return "env";
  }

  return null;
}

export function readRuntimeAccessPolicy(globalConfig: string): RuntimeAccessPolicy {
  const directAuthByRuntime: Record<string, RuntimeAuthPolicy> = {};
  const piProviderByRuntime: Record<string, string | null> = {};
  const piModelByRuntime: Record<string, string | null> = {};

  for (const adapter of builtinAdapters) {
    directAuthByRuntime[adapter.name] =
      parseRuntimeAuthPolicy(extractConfigValue(globalConfig, `direct-auth-${adapter.name}`)) ??
      defaultDirectAuthPolicy(adapter.name);
    piProviderByRuntime[adapter.name] =
      normalizeProviderName(extractConfigValue(globalConfig, `pi-provider-${adapter.name}`));
    piModelByRuntime[adapter.name] =
      extractConfigValue(globalConfig, `pi-model-${adapter.name}`);
  }

  return {
    defaultRuntime: normalizeRuntimeName(extractConfigValue(globalConfig, "runtime")),
    defaultModel: extractConfigValue(globalConfig, "model"),
    directAuthByRuntime,
    piProvider: normalizeProviderName(extractConfigValue(globalConfig, "pi-provider")),
    piModel: extractConfigValue(globalConfig, "pi-model"),
    piProviderByRuntime,
    piModelByRuntime,
  };
}

export function getConfiguredDirectAuthPolicy(
  runtime: string,
  globalConfig: string,
): RuntimeAuthPolicy {
  const normalized = normalizeRuntimeName(runtime) ?? runtime.trim().toLowerCase();
  const policy = readRuntimeAccessPolicy(globalConfig);

  return policy.directAuthByRuntime[normalized] ?? defaultDirectAuthPolicy(normalized);
}

export function resolvePiRuntimeRoute(input: {
  globalConfig: string;
  runtime: string;
  env?: NodeJS.ProcessEnv;
}): PiRuntimeRoute {
  const env = input.env ?? process.env;
  const policy = readRuntimeAccessPolicy(input.globalConfig);
  const normalizedRuntime = normalizeRuntimeName(input.runtime) ?? input.runtime.trim().toLowerCase();
  const envProvider = normalizeProviderName(env.HIVE_PI_PROVIDER);
  const envModel = env.HIVE_PI_MODEL?.trim() || null;
  const configuredProvider =
    policy.piProviderByRuntime[normalizedRuntime] ??
    policy.piProvider;
  const configuredModel =
    policy.piModelByRuntime[normalizedRuntime] ??
    policy.piModel;
  const implicitProvider = defaultPiProviderForRuntime(normalizedRuntime);
  const provider = envProvider ?? configuredProvider ?? implicitProvider ?? null;
  const model = envModel ?? configuredModel ?? null;
  const providerContext = provider ?? implicitProvider;
  const authPolicy = providerContext
    ? parsePiProviderAuthPolicy(extractConfigValue(input.globalConfig, `pi-auth-${providerContext}`)) ??
      defaultPiAuthPolicyForProvider(providerContext)
    : null;

  return {
    runtime: normalizedRuntime,
    provider,
    model,
    providerContext,
    authPolicy,
    providerSource: envProvider ? "env" : configuredProvider ? "config" : "implicit",
    modelSource: envModel ? "env" : configuredModel ? "config" : "implicit",
  };
}

function extractRuntimeFromDescriptor(descriptor: string): string | null {
  const match = descriptor.match(/\bvia\s+([a-z0-9._-]+)\b/i);

  return normalizeRuntimeName(match ? match[1] : null);
}

function extractModelFromDescriptor(descriptor: string): string | null {
  const match = descriptor.match(/,\s*([^,]+?)\s+via\s+[a-z0-9._-]+\b/i);

  return match ? match[1].trim() : null;
}

function selectModel(
  globalConfig: string,
  teamAgent?: TeamAgent | null,
  planAgent?: PlanAgent | null,
  modelOverride?: string | null,
  assignmentModel?: string | null,
): string | null {
  if (modelOverride?.trim()) {
    return modelOverride.trim();
  }

  if (assignmentModel?.trim()) {
    return assignmentModel.trim();
  }

  const planBodyModel = planAgent ? extractBodyValue(planAgent.body, "model") : null;
  const planDescriptorModel = planAgent ? extractModelFromDescriptor(planAgent.descriptor) : null;
  const teamDescriptorModel = teamAgent ? extractModelFromDescriptor(teamAgent.descriptor) : null;

  return (
    planBodyModel ??
    planDescriptorModel ??
    teamDescriptorModel ??
    extractConfigValue(globalConfig, "model")
  );
}

function selectRuntime(
  globalConfig: string,
  teamAgent?: TeamAgent | null,
  planAgent?: PlanAgent | null,
  runtimeOverride?: string | null,
  assignmentRuntime?: string | null,
): string {
  const candidates = [
    runtimeOverride,
    assignmentRuntime,
    planAgent ? extractBodyValue(planAgent.body, "runtime") : null,
    planAgent ? extractRuntimeFromDescriptor(planAgent.descriptor) : null,
    teamAgent ? extractRuntimeFromDescriptor(teamAgent.descriptor) : null,
    extractConfigValue(globalConfig, "runtime"),
  ];

  for (const candidate of candidates) {
    const runtime = normalizeRuntimeName(candidate);

    if (runtime) {
      return runtime;
    }
  }

  const available = builtinAdapters.map((a) => a.name).join("|");

  throw new UsageError(
    `Unsupported or missing runtime. Use \`--runtime ${available}\` or set \`runtime:\` in ~/.hive/config.md or the project team descriptor.`,
  );
}

// --- Public API ---

export function resolveRuntimeHints(input: ResolveHintsInput): RuntimeHints {
  return {
    runtime: selectRuntime(
      input.globalConfig,
      input.teamAgent,
      input.planAgent,
      input.runtimeOverride,
      input.assignmentRuntime,
    ),
    model: selectModel(
      input.globalConfig,
      input.teamAgent,
      input.planAgent,
      input.modelOverride,
      input.assignmentModel,
    ),
  };
}

export async function validateRuntimeInstalled(runtime: string): Promise<void> {
  const adapter = getAdapter(runtime);

  if (!adapter) {
    throw new UsageError(`Unknown runtime: ${runtime}`);
  }

  const installed = await adapter.detectInstalled();

  if (!installed) {
    throw new UsageError(
      `Runtime '${runtime}' is not installed (command '${adapter.command}' not found). Run \`hive runtimes\` to see available runtimes.`,
    );
  }
}

export function buildLaunchSpec(input: {
  runtime: string;
  model: string | null;
  repoPath: string;
  hiveHome: string;
  prompt: string;
}): LaunchSpec {
  const adapter = getAdapter(input.runtime);

  if (!adapter) {
    throw new UsageError(`Unknown runtime: ${input.runtime}`);
  }

  return {
    runtime: adapter.name,
    model: input.model,
    command: adapter.command,
    args: adapter.buildLaunchArgs({
      model: input.model,
      repoPath: input.repoPath,
      hiveHome: input.hiveHome,
      prompt: input.prompt,
    }),
  };
}

export function buildInteractiveLaunchSpec(input: {
  runtime: string;
  model: string | null;
  repoPath: string;
  hiveHome: string;
  systemPrompt: string;
}): LaunchSpec {
  const adapter = getAdapter(input.runtime);

  if (!adapter) {
    throw new UsageError(`Unknown runtime: ${input.runtime}`);
  }

  return {
    runtime: adapter.name,
    model: input.model,
    command: adapter.command,
    args: adapter.buildInteractiveArgs({
      model: input.model,
      repoPath: input.repoPath,
      hiveHome: input.hiveHome,
      systemPrompt: input.systemPrompt,
    }),
  };
}

export function startInteractiveSession(
  spec: LaunchSpec,
  repoPath: string,
): InteractiveHandle {
  const child = spawn(spec.command, spec.args, {
    stdio: "inherit",
    cwd: repoPath,
    env: cleanEnvForRuntime(),
  });

  return {
    pid: child.pid ?? null,
    wait: () =>
      new Promise((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
        child.on("error", () => resolve({ code: 1, signal: null }));
      }),
  };
}

export function renderLaunchPreview(spec: LaunchSpec): string {
  return [
    spec.command,
    ...spec.args.map((arg) => {
      if (arg.includes("\n") || arg.length > 120) {
        return "<PROMPT>";
      }

      return /\s/.test(arg) ? JSON.stringify(arg) : arg;
    }),
  ].join(" ");
}

export function shouldSuppressRuntimeLine(runtime: string, line: string): boolean {
  const trimmed = line.trim();

  if (!trimmed) {
    return false;
  }

  const adapter = getAdapter(runtime);

  if (!adapter) {
    return false;
  }

  return adapter.suppressLine(trimmed);
}

function createForwarder(
  runtime: string,
  stream: NodeJS.WriteStream | null,
  onLine: (line: string) => void,
) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const flushLine = (line: string) => {
    if (!shouldSuppressRuntimeLine(runtime, line)) {
      stream?.write(`${line}\n`);
      onLine(line);
    }
  };

  return {
    write(chunk: Buffer) {
      buffer += decoder.write(chunk);

      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        flushLine(line);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    end() {
      buffer += decoder.end();

      if (buffer) {
        flushLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
    },
  };
}

function cleanEnvForRuntime(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Prevent nested-session detection in Claude Code
  delete env.CLAUDECODE;
  // Strip API key so Claude Code uses subscription auth (OAuth) instead of API credits
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export function startLaunchSpec(
  spec: LaunchSpec,
  repoPath: string,
  options: LaunchHandleOptions = {},
): LaunchHandle {
  const adapter = getAdapter(spec.runtime);
  const hasJsonOutput = !!adapter?.parseOutput;
  const outputCapture = adapter?.createOutputCapture?.() ?? null;
  const launchArgs = spec.args;

  const child = spawn(spec.command, launchArgs, {
    cwd: repoPath,
    stdio: ["inherit", "pipe", "pipe"],
    env: cleanEnvForRuntime(),
  });
  const visibleLines: string[] = [];
  let visibleText = "";
  const stdoutLines: string[] = [];
  const outputStream = options.outputPath
    ? createWriteStream(options.outputPath, { flags: "a" })
    : null;
  const appendVisibleText = (chunk: string) => {
    if (!chunk) {
      return;
    }

    visibleText += chunk;

    if (!options.quiet) {
      process.stdout.write(chunk);
    }

    outputStream?.write(chunk);
  };
  const captureLine = (line: string) => {
    visibleLines.push(line);

    if (visibleLines.length > 40) {
      visibleLines.shift();
    }

    outputStream?.write(`${line}\n`);
  };
  const captureStdoutLine = (line: string) => {
    stdoutLines.push(line);

    if (outputCapture) {
      const chunk = outputCapture.handleStdoutLine(line);

      if (chunk) {
        appendVisibleText(chunk);
      }

      return;
    }

    captureLine(line);
  };
  // Suppress live stdout forwarding for JSON-output adapters (raw JSON isn't useful in terminal)
  const suppressLive = options.quiet || hasJsonOutput;
  const stdoutForwarder = createForwarder(spec.runtime, suppressLive ? null : process.stdout, captureStdoutLine);
  const stderrForwarder = createForwarder(spec.runtime, suppressLive ? null : process.stderr, captureLine);

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutForwarder.write(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrForwarder.write(chunk);
  });

  return {
    pid: child.pid ?? null,
    wait: async () => {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (exitCode) => resolve(exitCode));
      });

      stdoutForwarder.end();
      stderrForwarder.end();
      outputStream?.end();

      if (adapter?.parseOutput) {
        const rawStdout = stdoutLines.join("\n").trim();
        const parsed = adapter.parseOutput(rawStdout);

        return {
          code,
          signal: child.signalCode ?? null,
          visibleOutput: parsed.text || visibleText.trim(),
          metadata: parsed.metadata
            ? withDerivedTotalTokens({
                ...baseRuntimeMetadata(spec.runtime),
                ...parsed.metadata,
              })
            : baseRuntimeMetadata(spec.runtime),
        };
      }

      return {
        code,
        signal: child.signalCode ?? null,
        visibleOutput: visibleText.trim() || visibleLines.join("\n").trim(),
        metadata: baseRuntimeMetadata(spec.runtime),
      };
    },
  };
}

export async function runLaunchSpec(
  spec: LaunchSpec,
  repoPath: string,
  options?: LaunchHandleOptions,
): Promise<LaunchResult> {
  return startLaunchSpec(spec, repoPath, options).wait();
}
