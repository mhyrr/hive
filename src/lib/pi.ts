import {
  complete,
  getModel,
  getModels,
  getProviders,
  type AssistantMessage,
  type KnownProvider,
} from "@mariozechner/pi-ai";

export type PiTextCompletion = {
  provider: string;
  model: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  raw: AssistantMessage;
};

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
}

export function listPiProviders(): string[] {
  return getProviders();
}

export function isPiProviderSupported(provider: string | null | undefined): boolean {
  if (!provider) {
    return false;
  }

  return getProviders().includes(provider as KnownProvider);
}

export function isPiModelSupported(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): boolean {
  if (!provider || !modelId || !isPiProviderSupported(provider)) {
    return false;
  }

  return getModels(provider as KnownProvider).some((model) => model.id === modelId);
}

export async function completePiText(input: {
  provider: string;
  modelId: string;
  systemPrompt: string;
  userContent: string;
  signal?: AbortSignal;
}): Promise<PiTextCompletion> {
  const startedAt = Date.now();
  const model = getModel(input.provider as KnownProvider, input.modelId as never);
  const response = await complete(model, {
    systemPrompt: input.systemPrompt,
    messages: [
      {
        role: "user",
        content: input.userContent,
        timestamp: Date.now(),
      },
    ],
  }, {
    signal: input.signal,
  });

  return {
    provider: response.provider,
    model: response.model,
    text: extractAssistantText(response),
    inputTokens: response.usage?.input ?? null,
    outputTokens: response.usage?.output ?? null,
    totalTokens: response.usage?.totalTokens ?? null,
    durationMs: Date.now() - startedAt,
    raw: response,
  };
}
