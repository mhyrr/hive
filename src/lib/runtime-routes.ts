/**
 * Pi runtime route resolution — determines which provider, model, and auth
 * policy to use when dispatching work through the Pi API for a given runtime.
 *
 * Extracted from the former runtime.ts; contains ONLY the route-resolution
 * logic with zero subprocess / adapter / CLI dependencies.
 */

import { extractConfigValue } from "./config";

// ---------------------------------------------------------------------------
// Known runtime aliases → canonical name
// ---------------------------------------------------------------------------

const RUNTIME_ALIASES: Record<string, string> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  openai: "codex",
  gemini: "gemini",
  "gemini-cli": "gemini",
  google: "gemini",
  ollama: "ollama",
  local: "ollama",
  oss: "ollama",
};

const KNOWN_RUNTIMES = ["claude", "codex", "gemini", "ollama"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRuntimeName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return RUNTIME_ALIASES[value.trim().toLowerCase()] ?? null;
}

function normalizeProviderName(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();

  return normalized || null;
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readRuntimeAccessPolicy(globalConfig: string): RuntimeAccessPolicy {
  const directAuthByRuntime: Record<string, RuntimeAuthPolicy> = {};
  const piProviderByRuntime: Record<string, string | null> = {};
  const piModelByRuntime: Record<string, string | null> = {};

  for (const name of KNOWN_RUNTIMES) {
    directAuthByRuntime[name] =
      parseRuntimeAuthPolicy(extractConfigValue(globalConfig, `direct-auth-${name}`)) ??
      defaultDirectAuthPolicy(name);
    piProviderByRuntime[name] =
      normalizeProviderName(extractConfigValue(globalConfig, `pi-provider-${name}`));
    piModelByRuntime[name] =
      extractConfigValue(globalConfig, `pi-model-${name}`);
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
