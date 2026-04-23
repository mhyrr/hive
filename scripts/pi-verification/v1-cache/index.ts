/**
 * V1 — Pi cross-session prompt caching, end-to-end.
 *
 * Hypothesis: two back-to-back SDK sessions with an identical system prompt
 * share Anthropic's prompt cache. Run 1 writes, run 2 reads.
 *
 * Pass: run 2's assistant response usage shows cacheRead > 0.
 * Uses subscription OAuth from ~/.pi/agent/auth.json (no env var needed).
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Target ~5000 tokens to comfortably clear both Sonnet (1024) and Haiku (2048) mins.
const SEG_1 = [
  "# HIVE — Simulated Identity Stack (SEG 1)",
  "",
  "Static system prompt for cache architecture verification.",
  "",
  "## Who We Are",
  "We are craftsmen — technology married with liberal arts, engineering married with taste. ".repeat(100),
  "",
  "## How We Work",
  "We read before we write. We think in systems. We ship before perfecting. ".repeat(80),
  "",
  "## Operating Discipline",
  "Verify before claiming done. Stage files by name. Cite code as path:line. ".repeat(60),
].join("\n");

interface PayloadSummary {
  model?: string;
  systemBlocks?: Array<{ type?: string; textLength?: number; cache_control?: unknown }> | string;
  messageCount?: number;
}

interface RunResult {
  label: string;
  outgoingSystemLength: number;
  responseStatus: number | null;
  assistantUsage: unknown;
  assistantMessageSnippet: string;
  outgoingPayloads: PayloadSummary[];
}

function summarizePayload(p: unknown): PayloadSummary {
  if (!p || typeof p !== "object") return {};
  const q = p as Record<string, unknown>;
  const sys = q.system;
  return {
    model: typeof q.model === "string" ? q.model : undefined,
    systemBlocks: Array.isArray(sys)
      ? sys.map((s) => {
          const b = s as Record<string, unknown>;
          return {
            type: typeof b.type === "string" ? b.type : undefined,
            textLength: typeof b.text === "string" ? (b.text as string).length : undefined,
            cache_control: b.cache_control,
          };
        })
      : typeof sys === "string"
        ? `string(length=${sys.length})`
        : "absent",
    messageCount: Array.isArray(q.messages) ? q.messages.length : undefined,
  };
}

async function runSession(label: string, userPrompt: string): Promise<RunResult> {
  const payloads: unknown[] = [];
  let responseStatus: number | null = null;

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => SEG_1,
    extensionFactories: [
      (pi) => {
        pi.on("before_provider_request", async (event) => {
          payloads.push(event.payload);
        });
        pi.on("after_provider_response", async (event) => {
          responseStatus = event.status;
        });
      },
    ],
  });
  await loader.reload();

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  const modelName = process.env.V1_MODEL || "claude-sonnet-4-6";
  const model = getModel("anthropic", modelName);
  if (!model) throw new Error(`Model ${modelName} not found`);

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    resourceLoader: loader,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    tools: [],
  });

  await session.prompt(userPrompt);

  const messages = session.agent.state.messages as Array<Record<string, unknown>>;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  session.dispose();

  return {
    label,
    outgoingSystemLength: SEG_1.length,
    responseStatus,
    assistantUsage: lastAssistant?.usage,
    assistantMessageSnippet: JSON.stringify(lastAssistant).slice(0, 400),
    outgoingPayloads: payloads.map(summarizePayload),
  };
}

function extractCacheNumbers(usage: unknown): { cacheRead: number; cacheWrite: number } {
  if (!usage || typeof usage !== "object") return { cacheRead: 0, cacheWrite: 0 };
  const u = usage as Record<string, unknown>;
  const read =
    (typeof u.cacheRead === "number" ? u.cacheRead : undefined) ??
    (typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined) ??
    0;
  const write =
    (typeof u.cacheWrite === "number" ? u.cacheWrite : undefined) ??
    (typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined) ??
    0;
  return { cacheRead: read, cacheWrite: write };
}

async function main() {
  console.log("V1 — Pi cross-session prompt caching");
  console.log(`System prompt: ${SEG_1.length} chars`);
  console.log();

  const run1 = await runSession("run1", "Reply with the digit 1 only.");
  const run2 = await runSession("run2", "Reply with the digit 2 only.");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const runsDir = path.join(here, "runs");
  await mkdir(runsDir, { recursive: true });
  const outFile = path.join(runsDir, `v1-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(outFile, JSON.stringify({ run1, run2 }, null, 2));

  console.log("--- RUN 1 outgoing payload ---");
  console.log(JSON.stringify(run1.outgoingPayloads, null, 2));
  console.log("\n--- RUN 1 usage ---");
  console.log(JSON.stringify(run1.assistantUsage, null, 2));
  console.log("\n--- RUN 2 outgoing payload ---");
  console.log(JSON.stringify(run2.outgoingPayloads, null, 2));
  console.log("\n--- RUN 2 usage ---");
  console.log(JSON.stringify(run2.assistantUsage, null, 2));

  const c1 = extractCacheNumbers(run1.assistantUsage);
  const c2 = extractCacheNumbers(run2.assistantUsage);

  console.log(`\nRun 1: cacheWrite=${c1.cacheWrite} cacheRead=${c1.cacheRead}`);
  console.log(`Run 2: cacheWrite=${c2.cacheWrite} cacheRead=${c2.cacheRead}`);
  console.log(`\nResults: ${outFile}`);

  const pass = c2.cacheRead > 0;
  console.log(pass ? "\nPASS: run 2 hit the cache." : "\nFAIL: run 2 did not read from cache.");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Experiment failed:", err);
  process.exit(2);
});
