// Claude Code subprocess driver — invokes the user's `claude` CLI in
// `--print --output-format json` mode for one-shot text completions.
//
// HIVE rides on Claude Code: the subscription harness is the API. Pi (and
// direct Anthropic SDK) are intentionally NOT used here. Pi remains for the
// `hive -3` interactive path only.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelTextCompletion } from "./model";

export type { ModelTextCompletion };

export interface ClaudeTextCompletion extends ModelTextCompletion {
  provider: "anthropic";
}

interface ClaudeJsonEnvelope {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  api_error_status?: string | null;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }>;
}

function resolveClaudeBin(): string {
  if (process.env.HIVE_CLAUDE_BIN) return process.env.HIVE_CLAUDE_BIN;
  const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
  if (existsSync(fallback)) return fallback;
  return "claude";
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnClaude(
  bin: string,
  args: string[],
  stdinPayload: string,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      // Force OAuth/subscription path. ANTHROPIC_API_KEY would route through
      // the paid API and bypass the harness entirely.
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));
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

export async function completeClaudeText(input: {
  modelId: string;
  systemPrompt: string;
  userContent: string;
  signal?: AbortSignal;
}): Promise<ClaudeTextCompletion> {
  const bin = resolveClaudeBin();
  const startedAt = Date.now();

  // Tools are forbidden for one-shot extraction. We pass the entire context
  // in the user message; the model must reason from it, not go fetch files.
  // Use a single comma-separated string so commander's variadic <tools...>
  // consumes exactly one arg and terminates at the next flag.
  const denyTools = [
    "Bash",
    "Edit",
    "Write",
    "Read",
    "Glob",
    "Grep",
    "Agent",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Task",
    "TaskCreate",
    "TaskUpdate",
    "TaskGet",
    "TaskList",
    "TaskOutput",
    "TaskStop",
  ].join(",");

  const args = [
    "--print",
    "--output-format", "json",
    "--model", input.modelId,
    "--system-prompt", input.systemPrompt,
    "--disallowedTools", denyTools,
    "--max-turns", "1",
    "--permission-mode", "bypassPermissions",
  ];

  // Pass the user prompt over stdin to avoid argv length limits and any
  // shell-quoting traps for prompts containing newlines, quotes, or markdown.
  const { stdout, stderr, exitCode } = await spawnClaude(
    bin,
    args,
    input.userContent,
    input.signal,
  );

  if (exitCode !== 0) {
    throw new Error(
      `claude --print exited ${exitCode}.\nstderr: ${stderr.slice(0, 400)}\nstdout: ${stdout.slice(0, 400)}`,
    );
  }

  let envelope: ClaudeJsonEnvelope;
  try {
    envelope = JSON.parse(stdout) as ClaudeJsonEnvelope;
  } catch {
    // intentional: JSON parse failure → rethrow with context for debugging
    throw new Error(
      `claude --print output was not JSON. First 400 chars: ${stdout.slice(0, 400)}`,
    );
  }

  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(
      `claude --print returned error envelope (subtype=${envelope.subtype}, api_error_status=${envelope.api_error_status ?? "n/a"}). result: ${envelope.result?.slice(0, 200) ?? "(none)"}`,
    );
  }

  const text = envelope.result ?? "";
  const inputTokens = envelope.usage?.input_tokens ?? null;
  const outputTokens = envelope.usage?.output_tokens ?? null;

  return {
    provider: "anthropic",
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
