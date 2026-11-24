// TK-168: the Message Batches transport. A local HTTP server stands in for the
// Claude API, so these tests run the real SDK wire format and make no paid call.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";

import { batchParams, completeBatchText, nightlyTransport } from "../lib/anthropic-batch";
import { completeClaudeText, defaultCallTimeoutMs, nightlyCallTimeoutMs } from "../lib/claude";
import { estimateCost } from "../lib/pricing";

type ResultLine = Record<string, unknown>;

interface Fake {
  created: any[];
  retrieves: number;
  canceled: string[];
  /** Polls that report in_progress before the batch ends. */
  pollsUntilEnd: number;
  result: ResultLine;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
const fake: Fake = { created: [], retrieves: 0, canceled: [], pollsUntilEnd: 0, result: {} };

function batchObject(id: string, ended: boolean) {
  return {
    id,
    type: "message_batch",
    processing_status: ended ? "ended" : "in_progress",
    request_counts: { processing: ended ? 0 : 1, succeeded: ended ? 1 : 0, errored: 0, canceled: 0, expired: 0 },
    ended_at: ended ? "2026-11-24T08:00:00Z" : null,
    created_at: "2026-11-24T07:00:00Z",
    expires_at: "2026-11-25T07:00:00Z",
    archived_at: null,
    cancel_initiated_at: null,
    results_url: ended ? `${base}/v1/messages/batches/${id}/results` : null,
  };
}

function succeeded(message: Partial<Anthropic.Messages.Message>): ResultLine {
  return {
    custom_id: "hive-nightly",
    result: {
      type: "succeeded",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: '{"decisions":[]}' }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ...message,
      },
    },
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean); // v1 messages batches [id] [action]
      if (req.method === "POST" && url.pathname === "/v1/messages/batches") {
        fake.created.push(await req.json());
        return Response.json(batchObject("msgbatch_1", fake.pollsUntilEnd === 0));
      }
      const id = parts[3]!;
      if (req.method === "POST" && parts[4] === "cancel") {
        fake.canceled.push(id);
        return Response.json({ ...batchObject(id, false), processing_status: "canceling" });
      }
      if (parts[4] === "results") {
        return new Response(JSON.stringify(fake.result) + "\n", { headers: { "content-type": "application/binary" } });
      }
      fake.retrieves++;
      return Response.json(batchObject(id, fake.retrieves >= fake.pollsUntilEnd));
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

afterEach(() => {
  fake.created = [];
  fake.retrieves = 0;
  fake.canceled = [];
  fake.pollsUntilEnd = 0;
  fake.result = succeeded({});
});

const client = () => new Anthropic({ apiKey: "test-not-a-key", baseURL: base, maxRetries: 0 });
const input = {
  modelId: "claude-opus-5-5",
  systemPrompt: "You are the verifier.",
  userContent: "Decide these candidates.",
  effort: "high" as const,
};

describe("batchParams", () => {
  test("carries hive's prompt only: system, one user turn, effort, no tools or thinking", () => {
    expect(batchParams(input)).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 32_000,
      system: "You are the verifier.",
      messages: [{ role: "user", content: "Decide these candidates." }],
      output_config: { effort: "high" },
    });
  });

  test("Haiku 4.5 gets no effort (it rejects output_config.effort)", () => {
    expect(batchParams({ ...input, modelId: "claude-haiku-4-5", effort: "low" }).output_config).toBeUndefined();
  });
});

describe("completeBatchText", () => {
  test("submits one request, polls until ended, returns text and usage", async () => {
    fake.pollsUntilEnd = 2;
    fake.result = succeeded({});
    const out = await completeBatchText({ ...input, client: client(), pollMs: 1 });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].requests).toEqual([{ custom_id: "hive-nightly", params: batchParams(input) }]);
    // Two polls, plus the retrieve results() makes to find results_url.
    expect(fake.retrieves).toBe(3);
    expect(out.provider).toBe("anthropic-batch");
    expect(out.text).toBe('{"decisions":[]}');
    expect(out.inputTokens).toBe(1000);
    expect(out.outputTokens).toBe(200);
  });

  test("an errored request throws with the error", async () => {
    fake.result = {
      custom_id: "hive-nightly",
      result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "bad model" } } },
    };
    await expect(completeBatchText({ ...input, client: client(), pollMs: 1 })).rejects.toThrow(/errored.*bad model/);
  });

  test("an expired request throws", async () => {
    fake.result = { custom_id: "hive-nightly", result: { type: "expired" } };
    await expect(completeBatchText({ ...input, client: client(), pollMs: 1 })).rejects.toThrow(/expired/);
  });

  test("a refusal throws instead of reading as an empty extraction", async () => {
    fake.result = succeeded({ content: [], stop_reason: "refusal" as any });
    await expect(completeBatchText({ ...input, client: client(), pollMs: 1 })).rejects.toThrow(/refused/);
  });

  test("an empty text result throws (TK-136 rule)", async () => {
    fake.result = succeeded({ content: [{ type: "text", text: "  " } as any] });
    await expect(completeBatchText({ ...input, client: client(), pollMs: 1 })).rejects.toThrow(/empty result/);
  });

  test("truncated output throws", async () => {
    fake.result = succeeded({ stop_reason: "max_tokens" });
    await expect(completeBatchText({ ...input, client: client(), pollMs: 1 })).rejects.toThrow(/max_tokens/);
  });

  test("abort cancels the batch so it cannot bill after the deadline", async () => {
    fake.pollsUntilEnd = 1_000_000;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    await expect(completeBatchText({ ...input, client: client(), pollMs: 5, signal: ctrl.signal })).rejects.toThrow(/did not finish/);
    expect(fake.canceled).toEqual(["msgbatch_1"]);
  });
});

describe("HIVE_NIGHTLY_TRANSPORT=batch through completeClaudeText", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["HIVE_NIGHTLY_TRANSPORT", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "HIVE_CLAUDE_BIN", "HIVE_NIGHTLY_CALL_TIMEOUT_MS"];
  beforeAll(() => {
    for (const k of keys) saved[k] = process.env[k];
    // If the CLI path ran, this binary would fail the call loudly.
    process.env.HIVE_CLAUDE_BIN = "/nonexistent/claude-must-not-run";
  });
  afterAll(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("unset transport stays on the CLI path", () => {
    delete process.env.HIVE_NIGHTLY_TRANSPORT;
    expect(nightlyTransport()).toBe("cli");
    delete process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS;
    expect(nightlyCallTimeoutMs()).toBe(900_000);
  });

  test("batch routes to the Batches API and never spawns claude", async () => {
    process.env.HIVE_NIGHTLY_TRANSPORT = "batch";
    process.env.ANTHROPIC_API_KEY = "test-not-a-key";
    process.env.ANTHROPIC_BASE_URL = base;
    const out = await completeClaudeText(input);
    expect(out.provider).toBe("anthropic-batch");
    expect(fake.created).toHaveLength(1);
  });

  test("batch without a key fails; there is no fallback to the subscription", async () => {
    process.env.HIVE_NIGHTLY_TRANSPORT = "batch";
    delete process.env.ANTHROPIC_API_KEY;
    await expect(completeClaudeText(input)).rejects.toThrow(/needs ANTHROPIC_API_KEY/);
    expect(fake.created).toHaveLength(0);
  });

  test("batch mode raises the default per-call deadline to 3h", () => {
    process.env.HIVE_NIGHTLY_TRANSPORT = "batch";
    delete process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS;
    expect(defaultCallTimeoutMs()).toBe(3 * 3_600_000);
    expect(nightlyCallTimeoutMs()).toBe(3 * 3_600_000);
  });
});

describe("batch pricing", () => {
  test("a batch record costs half the list price", () => {
    const usage = { model: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 100_000 };
    const list = estimateCost({ ...usage, provider: "anthropic" });
    const batch = estimateCost({ ...usage, provider: "anthropic-batch" });
    expect(list.totalUsd).toBeCloseTo(4 + 2, 6);
    expect(batch.totalUsd).toBeCloseTo(3, 6);
    expect(batch.inputUsd).toBeCloseTo(2, 6);
    expect(batch.outputUsd).toBeCloseTo(1, 6);
  });
});
