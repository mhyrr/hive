import {
  discoverLocalModels,
  readCognitiveTier1Config,
} from "../../cognitive-routing";
import {
  completePiText,
  isPiModelSupported,
  isPiProviderSupported,
} from "../../pi";
import type { CognitionConcurrencyBucket } from "../packets";

const DEFAULT_OLLAMA_TIMEOUT_MS = 20_000;
const MAX_SUMMARY_CHARS = 220;

export const DEFAULT_PACKET_FRESHNESS_MS = 5 * 60_000;

export type FetchLike = typeof globalThis.fetch;
export type Tier1CloudTextRunner = typeof completePiText;

export type Tier1TaskResult = {
  provider: string;
  model: string;
  text: string;
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

export function normalizeText(value: string | null | undefined): string {
  return value?.replace(/\r\n/g, "\n").trim() ?? "";
}

export function truncateInline(value: string, maxChars = MAX_SUMMARY_CHARS): string {
  const normalized = value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

export function extractJsonObject(raw: string): string | null {
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

export function hasConfiguredTier1Route(globalConfig: string): boolean {
  const tier1 = readCognitiveTier1Config(globalConfig);

  return tier1.localConfigured || tier1.cloudConfigured || tier1.fallbackConfigured;
}

export function resolveTier1Bucket(
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

export async function runTier1Task(input: {
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
