// Gemini CLI subprocess driver — invokes the user's `gemini` CLI in
// `-p (headless) -o json` mode for one-shot text completions.
//
// Mirrors claude.ts: subscription harness is the API. No SDK dependency.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelTextCompletion } from "./model";

// ---------------------------------------------------------------------------
// JSON envelope type (gemini -o json)
// ---------------------------------------------------------------------------

interface GeminiJsonEnvelope {
  session_id?: string;
  response?: string;
  stats?: {
    models?: Record<
      string,
      {
        api?: { totalRequests?: number; totalErrors?: number; totalLatencyMs?: number };
        tokens?: {
          input?: number;
          prompt?: number;
          candidates?: number;
          total?: number;
          cached?: number;
          thoughts?: number;
          tool?: number;
        };
      }
    >;
  };
}

// ---------------------------------------------------------------------------
// Resolve binary
// ---------------------------------------------------------------------------

function resolveGeminiBin(): string {
  if (process.env.HIVE_GEMINI_BIN) return process.env.HIVE_GEMINI_BIN;
  const fallback = join(process.env.HOME || "", ".local", "bin", "gemini");
  if (existsSync(fallback)) return fallback;
  return "gemini";
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnGemini(
  bin: string,
  args: string[],
  stdinPayload: string,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Force subscription/OAuth path — scrub API keys so gemini uses Google login
    delete env.GOOGLE_API_KEY;
    delete env.GEMINI_API_KEY;

    const child = spawn(bin, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 }),
    );

    if (signal) {
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        child.kill("SIGTERM");
        // Escalate to SIGKILL if SIGTERM is ignored, so an aborted call always
        // settles via 'close' instead of hanging. Mirrors campaign/executor.ts.
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // intentional: process already gone
          }
        }, 3000);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => {
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
      });
    }

    // Gemini reads stdin and appends it to -p prompt, so we pipe the user
    // content via stdin and put the system prompt in -p.
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Parse JSON envelope
// ---------------------------------------------------------------------------

function extractGeminiTokens(envelope: GeminiJsonEnvelope): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  if (!envelope.stats?.models) {
    return { inputTokens: null, outputTokens: null };
  }

  // Sum across all models (usually just one)
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;

  for (const modelStats of Object.values(envelope.stats.models)) {
    if (modelStats.tokens) {
      found = true;
      inputTokens += modelStats.tokens.input ?? modelStats.tokens.prompt ?? 0;
      outputTokens += modelStats.tokens.candidates ?? 0;
    }
  }

  return found
    ? { inputTokens, outputTokens }
    : { inputTokens: null, outputTokens: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function completeGeminiText(input: {
  modelId: string;
  systemPrompt: string;
  userContent: string;
  signal?: AbortSignal;
}): Promise<ModelTextCompletion> {
  const bin = resolveGeminiBin();
  const startedAt = Date.now();

  // Gemini CLI doesn't have a --system-prompt flag. We combine system + user
  // into -p, and pipe the user content via stdin (gemini appends stdin to -p).
  // Actually: gemini reads stdin and appends to the -p value. So we put the
  // full combined prompt into stdin and use -p "" as the trigger for headless.
  //
  // Simplest approach: put everything in -p. But -p has argv limits for long
  // prompts. Instead: use stdin for the full prompt since gemini reads it.
  const combinedPrompt = `${input.systemPrompt}\n\n---\n\n${input.userContent}`;

  const args = [
    "-p", "",  // Empty -p triggers headless mode; stdin provides content
    "-o", "json",
    "--approval-mode", "plan",  // Read-only — no tool use
    ...(input.modelId ? ["-m", input.modelId] : []),
  ];

  const { stdout, stderr, exitCode } = await spawnGemini(
    bin,
    args,
    combinedPrompt,
    input.signal,
  );

  if (exitCode !== 0 && !stdout.trim()) {
    throw new Error(
      `gemini exited ${exitCode}.\nstderr: ${stderr.slice(0, 400)}\nstdout: ${stdout.slice(0, 400)}`,
    );
  }

  let envelope: GeminiJsonEnvelope;
  try {
    envelope = JSON.parse(stdout) as GeminiJsonEnvelope;
  } catch {
    // intentional: JSON parse failure — gemini sometimes outputs plain text
    // If JSON parsing fails, the output might be plain text (gemini sometimes
    // outputs text despite -o json on errors). Treat stdout as the response.
    if (stdout.trim()) {
      return {
        provider: "google",
        model: input.modelId,
        text: stdout.trim(),
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        durationMs: Date.now() - startedAt,
      };
    }
    throw new Error(
      `gemini output was not JSON. First 400 chars: ${stdout.slice(0, 400)}\nstderr: ${stderr.slice(0, 400)}`,
    );
  }

  const text = envelope.response ?? "";
  const { inputTokens, outputTokens } = extractGeminiTokens(envelope);

  return {
    provider: "google",
    model: input.modelId,
    text,
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null,
    durationMs: Date.now() - startedAt,
  };
}
