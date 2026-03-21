import { getEnvApiKey, getModel, getModels, type KnownProvider } from "@mariozechner/pi-ai";

import { UsageError } from "../errors";
import { isPiModelSupported, isPiProviderSupported } from "../pi";
import { resolvePiRuntimeRoute } from "../runtime";

export type PersistentStewardRuntimeConfig = {
  provider: string;
  modelId: string;
  authPolicy: "oauth-only" | "env" | null;
  runtimeSignature: string;
};

export function describePiModel(input: {
  provider: string;
  modelId: string;
}): string {
  return `${input.provider}/${input.modelId}`;
}

export function resolvePiApiKey(
  provider: string,
  input: {
    authPolicy: "oauth-only" | "env" | null;
  },
): string | undefined {
  if (provider === "anthropic" && input.authPolicy === "oauth-only") {
    return process.env.ANTHROPIC_OAUTH_TOKEN?.trim() || undefined;
  }

  const apiKey = getEnvApiKey(provider);
  return typeof apiKey === "string" && apiKey.trim() ? apiKey : undefined;
}

export function resolvePersistentStewardModel(input: {
  provider: string;
  configuredModel: string | null;
  sessionModel: string | null;
}): string {
  if (input.configuredModel) {
    if (!isPiModelSupported(input.provider, input.configuredModel)) {
      throw new UsageError(
        `Configured Pi model '${input.configuredModel}' is not supported for provider '${input.provider}'.`,
      );
    }

    return input.configuredModel;
  }

  if (input.sessionModel && isPiModelSupported(input.provider, input.sessionModel)) {
    return input.sessionModel;
  }

  const fallback = getModels(input.provider as KnownProvider)[0]?.id ?? null;

  if (!fallback) {
    throw new UsageError(`No Pi model is available for provider '${input.provider}'.`);
  }

  return fallback;
}

export function resolvePersistentStewardRuntime(input: {
  globalConfig: string;
  runtime: string;
  sessionModel: string | null;
  repoPath: string;
}): PersistentStewardRuntimeConfig {
  const piRoute = resolvePiRuntimeRoute({
    globalConfig: input.globalConfig,
    runtime: input.runtime,
  });

  if (!piRoute.provider) {
    throw new UsageError(
      `No Pi provider route is configured for runtime '${input.runtime}'. Configure pi-provider-${input.runtime}: <provider> in ~/.hive/config.md or use the direct steward path.`,
    );
  }

  if (!isPiProviderSupported(piRoute.provider)) {
    throw new UsageError(`Pi provider '${piRoute.provider}' is not supported in-process.`);
  }

  const modelId = resolvePersistentStewardModel({
    provider: piRoute.provider,
    configuredModel: piRoute.model,
    sessionModel: input.sessionModel,
  });

  return {
    provider: piRoute.provider,
    modelId,
    authPolicy: piRoute.authPolicy,
    runtimeSignature: [
      input.runtime,
      modelId,
      piRoute.provider,
      piRoute.authPolicy ?? "",
      input.repoPath,
    ].join(":"),
  };
}

export function buildPiModel(input: PersistentStewardRuntimeConfig) {
  return getModel(input.provider as never, input.modelId as never);
}
