import { resolvePiApiKey } from "./steward/runtime";

export class AnthropicError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AnthropicError";
  }
}

export class AnthropicTimeoutError extends AnthropicError {
  constructor(timeoutMs: number) {
    super(`Anthropic API call timed out after ${timeoutMs}ms`);
    this.name = "AnthropicTimeoutError";
  }
}

type Message = {
  role: "user" | "assistant";
  content: string;
};

type CallOptions = {
  model: string;
  system?: string;
  messages: Message[];
  maxTokens?: number;
  timeoutMs?: number;
};

export async function callAnthropic(opts: CallOptions): Promise<string> {
  // Resolve credentials — prefer API key if available, fall back to OAuth
  const resolved = await resolvePiApiKey("anthropic", { authPolicy: null });

  if (!resolved) {
    throw new AnthropicError(
      "No Anthropic credentials available. Sign in with Claude CLI (claude auth login) or set ANTHROPIC_API_KEY.",
    );
  }

  const authHeaders: Record<string, string> = resolved.isOAuth
    ? { Authorization: `Bearer ${resolved.token}` }
    : { "x-api-key": resolved.token };

  const { model, system, messages, maxTokens = 150, timeoutMs = 5000 } = opts;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
  };

  if (system) {
    body.system = system;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        ...authHeaders,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);

    if (err instanceof Error && err.name === "AbortError") {
      throw new AnthropicTimeoutError(timeoutMs);
    }

    throw new AnthropicError(
      `Anthropic API fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  clearTimeout(timer);

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const excerpt = bodyText.slice(0, 200);
    throw new AnthropicError(
      `Anthropic API returned ${response.status}: ${excerpt}`,
      response.status,
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const firstBlock = data.content?.[0];

  if (!firstBlock || firstBlock.type !== "text" || !firstBlock.text) {
    throw new AnthropicError("Anthropic API returned no text content");
  }

  return firstBlock.text;
}
