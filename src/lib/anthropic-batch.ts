// Message Batches transport for nightly one-shot completions (TK-168).
//
// Opt-in: HIVE_NIGHTLY_TRANSPORT=batch. Each call becomes a one-request
// Message Batch on the Claude API, billed at 50% of list price and paid from
// the Console organization that ANTHROPIC_API_KEY belongs to. That is the org
// the Max plan's monthly API credit lands in
// (platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).
//
// The request carries the same content `claude --print` sends for hive, minus
// Claude Code's wrapper: hive's system prompt as `system`, hive's prompt as the
// one user message, no tools, the pass's effort. The wrapper (an Agent SDK
// identity line plus five <system-reminder> blocks: environment, model, token
// budget, account email, date) is ~300-700 tokens a call and carries nothing a
// nightly pass reads.
//
// No fallback. If the key is missing or the batch fails, the call throws, the
// same as a failed `claude --print`. The nightly never silently switches
// between subscription and API billing.

import Anthropic from "@anthropic-ai/sdk";
import type { ModelTextCompletion } from "./model";
import { BATCH_PROVIDER } from "./pricing";

export { BATCH_PROVIDER };

export type NightlyTransport = "cli" | "batch";

/** HIVE_NIGHTLY_TRANSPORT=batch routes every completeClaudeText call in this
 * process through the Message Batches API. Anything else keeps `claude --print`. */
export function nightlyTransport(): NightlyTransport {
  return process.env.HIVE_NIGHTLY_TRANSPORT === "batch" ? "batch" : "cli";
}

/** `claude --print` asks for 32k output tokens; keep the same ceiling. */
const MAX_TOKENS = 32_000;

/** Models that reject `output_config.effort`. */
const NO_EFFORT = /^claude-haiku-4-5/;

export interface BatchCompletionInput {
  modelId: string;
  systemPrompt: string;
  userContent: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  signal?: AbortSignal;
  /** Injected for tests. Default: `new Anthropic()`, which reads ANTHROPIC_API_KEY. */
  client?: Anthropic;
  /** Poll interval while the batch runs. Default 30s. */
  pollMs?: number;
}

/** The one Messages request a nightly call becomes. Exported for tests. */
export function batchParams(input: BatchCompletionInput): Anthropic.Messages.MessageCreateParamsNonStreaming {
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: input.modelId,
    max_tokens: MAX_TOKENS,
    system: input.systemPrompt,
    messages: [{ role: "user", content: input.userContent }],
  };
  // No `thinking` field: Opus 5.5 and Sonnet 5.5 run adaptive thinking when it
  // is omitted (and reject `disabled`); Haiku 4.5 runs without thinking, which
  // is what TA asks `claude --print` for.
  if (input.effort && !NO_EFFORT.test(input.modelId)) {
    params.output_config = { effort: input.effort };
  }
  return params;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export async function completeBatchText(input: BatchCompletionInput): Promise<ModelTextCompletion> {
  const startedAt = Date.now();
  if (!input.client && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "HIVE_NIGHTLY_TRANSPORT=batch needs ANTHROPIC_API_KEY (a key from the Console org linked to the Max plan). " +
        "Unset HIVE_NIGHTLY_TRANSPORT to run on the subscription through `claude --print`.",
    );
  }
  const client = input.client ?? new Anthropic();
  const pollMs = input.pollMs ?? 30_000;
  const customId = "hive-nightly";

  let batch = await client.messages.batches.create({
    requests: [{ custom_id: customId, params: batchParams(input) }],
  });
  try {
    while (batch.processing_status !== "ended") {
      await sleep(pollMs, input.signal);
      batch = await client.messages.batches.retrieve(batch.id);
    }
  } catch (err) {
    // Deadline or abort: stop the batch so it can't bill after we gave up.
    await client.messages.batches.cancel(batch.id).catch(() => {});
    throw new Error(`batch ${batch.id} (${input.modelId}) did not finish: ${(err as Error).message}`);
  }

  let message: Anthropic.Messages.Message | null = null;
  for await (const entry of await client.messages.batches.results(batch.id)) {
    if (entry.custom_id !== customId) continue;
    if (entry.result.type !== "succeeded") {
      const detail = entry.result.type === "errored" ? JSON.stringify(entry.result.error).slice(0, 300) : "";
      throw new Error(`batch ${batch.id} (${input.modelId}) request ${entry.result.type}. ${detail}`.trim());
    }
    message = entry.result.message;
  }
  if (!message) throw new Error(`batch ${batch.id} (${input.modelId}) returned no result`);

  // Same rule as the CLI path (TK-136): a declined or empty completion is a
  // failure, not "the model found nothing".
  if (message.stop_reason === "refusal") {
    throw new Error(`batch ${batch.id} (${input.modelId}) refused: ${JSON.stringify(message.stop_details ?? null).slice(0, 200)}`);
  }
  const text = message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (text.trim() === "") {
    throw new Error(
      `batch ${batch.id} returned an empty result (model=${input.modelId}, stop_reason=${message.stop_reason}). ` +
        `Treat as a declined or dropped completion, not an empty extraction.`,
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error(`batch ${batch.id} (${input.modelId}) hit max_tokens (${MAX_TOKENS}); output is truncated`);
  }

  const u = message.usage;
  const cacheReadTokens = u.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
  const inputTokens = u.input_tokens + cacheReadTokens + cacheCreationTokens;
  return {
    provider: BATCH_PROVIDER,
    model: input.modelId,
    text,
    inputTokens,
    outputTokens: u.output_tokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheCreation1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    totalTokens: inputTokens + u.output_tokens,
    durationMs: Date.now() - startedAt,
  };
}
