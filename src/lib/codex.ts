// Codex CLI subprocess driver — invokes the user's `codex` CLI in
// `exec --json` mode for one-shot text completions.
//
// Mirrors claude.ts: subscription harness is the API. No SDK dependency.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelTextCompletion } from "./model";

// ---------------------------------------------------------------------------
// JSONL envelope types (codex exec --json)
// ---------------------------------------------------------------------------

interface CodexItemCompleted {
  type: "item.completed";
  item: { id: string; type: string; text: string };
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

interface CodexError {
  type: "error";
  message: string;
}

interface CodexTurnFailed {
  type: "turn.failed";
  error?: { message?: string };
}

type CodexEvent = CodexItemCompleted | CodexTurnCompleted | CodexError | CodexTurnFailed;

// ---------------------------------------------------------------------------
// Resolve binary
// ---------------------------------------------------------------------------

function resolveCodexBin(): string {
  if (process.env.HIVE_CODEX_BIN) return process.env.HIVE_CODEX_BIN;
  const fallback = join(process.env.HOME || "", ".local", "bin", "codex");
  if (existsSync(fallback)) return fallback;
  return "codex";
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnCodex(
  bin: string,
  args: string[],
  stdinPayload: string,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Force subscription/OAuth path — scrub API key so codex uses ChatGPT login
    delete env.OPENAI_API_KEY;

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
      const onAbort = () => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Parse JSONL output
// ---------------------------------------------------------------------------

function parseCodexJsonl(raw: string): { text: string; inputTokens: number | null; outputTokens: number | null; error: string | null } {
  const lines = raw.split("\n").filter((l) => l.trim());
  let text = "";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let error: string | null = null;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as CodexEvent;

      if (event.type === "item.completed") {
        text += (event as CodexItemCompleted).item.text;
      } else if (event.type === "turn.completed") {
        const usage = (event as CodexTurnCompleted).usage;
        if (usage) {
          inputTokens = usage.input_tokens ?? null;
          outputTokens = usage.output_tokens ?? null;
        }
      } else if (event.type === "error") {
        error = (event as CodexError).message;
      } else if (event.type === "turn.failed") {
        error = (event as CodexTurnFailed).error?.message ?? "turn failed";
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return { text, inputTokens, outputTokens, error };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function completeCodexText(input: {
  modelId: string;
  systemPrompt: string;
  userContent: string;
  signal?: AbortSignal;
}): Promise<ModelTextCompletion> {
  const bin = resolveCodexBin();
  const startedAt = Date.now();

  const args = [
    "exec",
    "--json",
    "-s", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    // System prompt via config override
    "-c", `instructions="${input.systemPrompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    // Model override (if not default)
    ...(input.modelId ? ["-m", input.modelId] : []),
    // Read prompt from stdin
    "-",
  ];

  const { stdout, stderr, exitCode } = await spawnCodex(
    bin,
    args,
    input.userContent,
    input.signal,
  );

  const parsed = parseCodexJsonl(stdout);

  if (parsed.error) {
    throw new Error(
      `codex exec error: ${parsed.error}\nstderr: ${stderr.slice(0, 400)}`,
    );
  }

  if (exitCode !== 0 && !parsed.text) {
    throw new Error(
      `codex exec exited ${exitCode}.\nstderr: ${stderr.slice(0, 400)}\nstdout: ${stdout.slice(0, 400)}`,
    );
  }

  return {
    provider: "openai",
    model: input.modelId,
    text: parsed.text,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    totalTokens:
      parsed.inputTokens !== null && parsed.outputTokens !== null
        ? parsed.inputTokens + parsed.outputTokens
        : null,
    durationMs: Date.now() - startedAt,
  };
}
