// TK-168: one cheap Message Batch, to measure batch turnaround and to show the
// charge landing on the Console org's promotional (plan) credits.
//
//   ANTHROPIC_API_KEY=... bun scripts/batch-probe.ts [model]
//
// Default model claude-haiku-4-5: ~30 input + a few output tokens, well under
// $0.001 at the batch rate. Prints the batch id, wall time and usage. The key
// is read from the environment by the SDK and never printed.

import { completeBatchText } from "../src/lib/anthropic-batch";

const model = process.argv[2] ?? "claude-haiku-4-5";
const started = Date.now();
const out = await completeBatchText({
  modelId: model,
  systemPrompt: "Reply with the single word OK.",
  userContent: "Ping.",
  pollMs: 10_000,
});
console.log(
  JSON.stringify({
    model,
    text: out.text.trim(),
    wallSeconds: Math.round((Date.now() - started) / 1000),
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
  }),
);
