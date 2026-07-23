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
      //
      // HIVE_IDENTITY_IN_PROMPT=1 suppresses the SessionStart identity hook for
      // this one-shot extraction subprocess. Without it the hook injects the
      // full ~63KB HIVE/Maya identity, so a cheap extractor runs *as Maya* —
      // verbose, slow, and off-task (observed: a Haiku classify ballooning to
      // 9k output tokens / 159s). Extraction passes carry their own system
      // prompt and disallow tools; they must not inherit the interactive persona.
      env: { ...process.env, ANTHROPIC_API_KEY: undefined, HIVE_IDENTITY_IN_PROMPT: "1" },
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
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        child.kill("SIGTERM");
        // Escalate if the child ignores SIGTERM, so an aborted call always
        // settles via 'close' instead of leaving the promise pending forever.
        // Mirrors the SIGTERM→grace→SIGKILL pattern in campaign/executor.ts.
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

    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

/** Default in-process deadline for a one-shot nightly `claude --print` call.
 *
 * The nightly pipeline runs as a detached launchd LaunchAgent at 2am. In that
 * no-GUI context `claude --print` stalls on OAuth/Keychain credential access —
 * calls have been observed hanging for 1-2+ hours while exchanging *zero*
 * tokens, then either squeaking through or being killed by claude's own ~6-min
 * request cap. That cap does not reliably fire, so HIVE bounds every nightly
 * call itself. Override with HIVE_NIGHTLY_CALL_TIMEOUT_MS.
 *
 * 15 minutes (TK-135): Fable-class models at higher effort legitimately run
 * many minutes on a synthesis pass — a 6-minute bound false-kills real work.
 * Stall damage stays bounded by the whole-pipeline cap in nightly.sh. */
export function nightlyCallTimeoutMs(): number {
  const raw = Number(process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
}

/** Race `run` against a deadline. On timeout: abort the signal (so a spawned
 * child gets killed) AND reject immediately with a clear timeout error rather
 * than waiting on the child's SIGTERM→close round-trip. If the deadline wins,
 * `run`'s later settlement is swallowed so it can't surface as an unhandled
 * rejection. */
export async function withDeadline<T>(
  ms: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject FIRST so the deadline's own error wins the race, THEN abort as
      // cleanup. Aborting first lets `run`'s abort-triggered rejection (which
      // can settle synchronously) beat the timeout message to the race.
      reject(new Error(`${label} timed out after ${ms}ms`));
      ctrl.abort();
    }, ms);
  });
  const work = run(ctrl.signal);
  // If the deadline wins, `work` settles later with no listener on this chain —
  // swallow it. (When `work` wins, Promise.race still rethrows its rejection.)
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `completeClaudeText` wrapped in the nightly deadline. The nightly pipeline's
 * callers use this so a stalled extraction/verification fails fast and visibly
 * (in minutes) instead of eating hours of wall-clock. */
export function completeClaudeTextBounded(
  input: { modelId: string; systemPrompt: string; userContent: string },
  timeoutMs: number = nightlyCallTimeoutMs(),
): Promise<ClaudeTextCompletion> {
  return withDeadline(timeoutMs, `claude --print (${input.modelId})`, (signal) =>
    completeClaudeText({
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      signal,
    }),
  );
}

export async function completeClaudeText(input: {
  modelId: string;
  systemPrompt: string;
  userContent: string;
  signal?: AbortSignal;
  /** Override the user's global `alwaysThinkingEnabled` for this one-shot call.
   * Extended thinking adds large latency + hidden output tokens; classification
   * and extraction passes don't need it. Default: inherit the user's setting. */
  disableThinking?: boolean;
}): Promise<ClaudeTextCompletion> {
  const bin = resolveClaudeBin();
  const startedAt = Date.now();

  // Tools are forbidden for one-shot extraction. We pass the entire context in
  // the user message; the model must reason from it, not go fetch files.
  //
  // A denylist of built-ins is not enough: in a repo with project MCP servers
  // and skill injection, the model could still reach for `mcp__*`, `Skill`, or
  // `ToolSearch`, emit a tool_use, and trip `--max-turns 1` with
  // `error_max_turns` (observed: a 27-window Haiku classify failing this way).
  // Lock it down to ZERO tools instead:
  //   --tools ""            disables every built-in tool (per claude --help)
  //   --strict-mcp-config   with no --mcp-config, loads zero MCP servers
  // Now the model can only produce text, so a stray tool_use is impossible.
  const args = [
    "--print",
    "--output-format", "json",
    "--model", input.modelId,
    "--system-prompt", input.systemPrompt,
    "--tools", "",
    "--strict-mcp-config",
    "--max-turns", "1",
    "--permission-mode", "bypassPermissions",
  ];

  // Suppress extended thinking when asked. The user's global
  // `alwaysThinkingEnabled` otherwise applies to every spawned `claude --print`,
  // burning thousands of hidden reasoning tokens (and ~60-90s) before a tiny
  // extraction answer. `--settings` merges on top of the user config.
  if (input.disableThinking) {
    args.push("--settings", JSON.stringify({ alwaysThinkingEnabled: false }));
  }

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
