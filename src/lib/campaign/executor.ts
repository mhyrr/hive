/**
 * Campaign executor iteration runner (TK-076, C3).
 *
 * Spawns a cold Claude Code session into the campaign worktree, monitors
 * token/walltime caps via C2, and returns a structured IterationResult.
 *
 * This is a LAYER — it runs one iteration and reports what happened.
 * It does not decide whether to continue, replan, or stop; that's the
 * judge (C4).
 *
 * Architecture:
 * - Spawns `claude --print --output-format stream-json --verbose`
 * - Parses JSON-line stream for token usage from `assistant` messages
 * - Evaluates caps each time usage updates
 * - Soft signal: writes a sentinel file; executor prompt instructs the
 *   model to check for it and write checkpoint.md before exiting
 * - Hard kill: SIGTERM + 5s grace + SIGKILL
 * - On exit: checks for checkpoint.md to determine exit reason
 */

import { existsSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { createWriteStream, type WriteStream } from "node:fs";

import {
  type CampaignState,
  iterationDir,
} from "./state";
import { evaluateCaps, type CapsConfig, type UsageSnapshot } from "./caps";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExitReason = "clean" | "soft_triggered" | "hard_killed" | "crashed";

export interface IterationResult {
  exitReason: ExitReason;
  checkpointPath: string | null;
  tokensUsed: number;
  walltimeMs: number;
}

export interface RunIterationOpts {
  /** Full campaign state. */
  state: CampaignState;
  /** 1-based iteration number. */
  iterationN: number;
  /** Cap configuration (from C2). */
  caps: CapsConfig;
  /** Absolute path to the claude CLI binary. */
  claudePath: string;
  /** Model string (e.g. "claude-opus-4-6"). */
  model: string;
  /** Assembled identity text to append as system prompt. */
  identity: string;
  /** Override HIVE_HOME for testing. */
  hiveHome?: string;
  /** Cap poll interval in ms. Default 5000. Lower for tests. */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the executor prompt for a single iteration.
 *
 * Structure:
 * 1. Goal (raw user-supplied text)
 * 2. Scope fence (extracted from frozen prefix, or inline default)
 * 3. Current plan
 * 4. Previous checkpoint (if any)
 * 5. Iteration instructions (including soft-cap sentinel check)
 */
export function buildExecutorPrompt(
  state: CampaignState,
  iterationN: number,
  sentinelPath: string,
): string {
  const sections: string[] = [];

  // Goal text — prefer the separate goal field, fall back to frozenPrefix for legacy
  const goalText = state.goal ?? state.frozenPrefix;
  if (goalText) {
    sections.push(`# Goal\n\n${goalText}`);
  }

  // Scope fence — extracted from the structured frozen prefix if available
  if (state.frozenPrefix && state.frozenPrefix.includes("## Scope Fence")) {
    const fenceStart = state.frozenPrefix.indexOf("## Scope Fence");
    const fenceEnd = state.frozenPrefix.indexOf("\n## ", fenceStart + 1);
    const fence = fenceEnd > -1
      ? state.frozenPrefix.slice(fenceStart, fenceEnd).trim()
      : state.frozenPrefix.slice(fenceStart).trim();
    sections.push(`# ${fence.slice(3)}`); // Convert ## Scope Fence to # Scope Fence
  }

  // Current plan
  if (state.plan) {
    sections.push(`# Current Plan\n\n${state.plan}`);
  }

  // Previous checkpoint
  if (state.checkpoint) {
    sections.push(`# Previous Iteration Checkpoint\n\n${state.checkpoint}`);
  }

  // Iteration instructions
  sections.push(`# Iteration ${iterationN} Instructions

You are executing iteration ${iterationN} of a campaign. Work on the next actionable items from the plan above.

## Exit Protocol
When you reach a coherent stopping point (a plan step is complete, tests pass/fail decisively, or you hit a blocker), write \`checkpoint.md\` in the campaign workspace root with:
- What you accomplished
- Current state of the work
- What the next iteration should pick up

Then exit naturally.

## Soft-Cap Signal
Between major actions, check if the file \`${sentinelPath}\` exists. If it does, you are approaching a resource cap. Immediately:
1. Write \`checkpoint.md\` summarizing your progress so far
2. Exit cleanly

Do not ignore the soft-cap signal. It means the orchestrator needs you to save state.

## Working Directory
Your CWD is the campaign workspace (a git worktree). Commit meaningful progress to the campaign branch.
`);

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Stream parser
// ---------------------------------------------------------------------------

interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Parse a JSON-line from claude's stream-json output and extract token usage.
 * Returns null if the line doesn't contain usage data.
 */
export function parseStreamLine(line: string): StreamUsage | null {
  if (!line.trim()) return null;

  try {
    const obj = JSON.parse(line);

    // Assistant messages carry per-turn usage
    if (obj.type === "assistant" && obj.message?.usage) {
      const u = obj.message.usage;
      return {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      };
    }

    // Result event carries final totals (most accurate)
    if (obj.type === "result" && obj.usage) {
      const u = obj.usage;
      return {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      };
    }

    return null;
  } catch {
    // intentional: usage file missing or malformed — no token stats
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worktree health check
// ---------------------------------------------------------------------------

async function isWorkspaceAccessible(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    // intentional: workspace path inaccessible (removed/permissions)
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main: runIteration
// ---------------------------------------------------------------------------

export async function runIteration(opts: RunIterationOpts): Promise<IterationResult> {
  const { state, iterationN, caps, claudePath, model, identity, hiveHome, pollIntervalMs = 5000 } = opts;
  const startTime = Date.now();

  // --- Setup iteration directory ---
  const iterDir = iterationDir(state.id, iterationN, hiveHome);
  await mkdir(iterDir, { recursive: true });

  const transcriptPath = join(iterDir, "transcript.log");
  const sentinelPath = join(iterDir, "soft-cap.signal");
  const checkpointPath = join(state.workspacePath, "checkpoint.md");

  // --- Build prompt ---
  const prompt = buildExecutorPrompt(state, iterationN, sentinelPath);

  // --- Pre-flight: verify workspace exists ---
  if (!(await isWorkspaceAccessible(state.workspacePath))) {
    await writeFile(
      transcriptPath,
      `[executor] Workspace unreachable before spawn: ${state.workspacePath}\n`,
      "utf-8",
    );
    return {
      exitReason: "crashed",
      checkpointPath: null,
      tokensUsed: 0,
      walltimeMs: Date.now() - startTime,
    };
  }

  // --- Spawn claude ---
  const child = spawn(
    claudePath,
    [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", model,
      "--permission-mode", "bypassPermissions",
      "--append-system-prompt", identity,
      prompt,
    ],
    {
      cwd: state.workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    },
  );

  // --- Stream processing ---
  let totalTokens = 0;
  let softTrippedAxis: "tokens" | "walltime" | null = null;
  let softSignalSent = false;
  let hardKillSent = false;
  let processExited = false;

  const transcriptStream: WriteStream = createWriteStream(transcriptPath, { flags: "a" });

  // Track usage from the stream
  const rl: Interface = createInterface({ input: child.stdout! });

  rl.on("line", (line: string) => {
    // Write to transcript
    transcriptStream.write(line + "\n");

    // Parse usage
    const usage = parseStreamLine(line);
    if (usage) {
      totalTokens = usage.inputTokens + usage.outputTokens +
        usage.cacheReadTokens + usage.cacheCreationTokens;
    }
  });

  // Capture stderr too
  if (child.stderr) {
    const stderrRl = createInterface({ input: child.stderr });
    stderrRl.on("line", (line: string) => {
      transcriptStream.write(`[stderr] ${line}\n`);
    });
  }

  // --- Cap enforcement polling ---
  const capPollInterval = setInterval(async () => {
    if (processExited) return;

    const elapsedMs = Date.now() - startTime;
    const snapshot: UsageSnapshot = {
      tokens: totalTokens,
      elapsed_ms: elapsedMs,
      soft_tripped_axis: softTrippedAxis,
    };

    const decision = evaluateCaps(caps, snapshot);

    if (decision.action === "soft_signal" && !softSignalSent) {
      softTrippedAxis = decision.axis;
      softSignalSent = true;
      // Write sentinel file
      try {
        await writeFile(sentinelPath, decision.reason, "utf-8");
        transcriptStream.write(
          `[executor] Soft cap signal written: ${decision.reason}\n`,
        );
      } catch {
        // intentional: workspace may be gone — sentinel write is best-effort
      }
    }

    if (decision.action === "hard_kill" && !hardKillSent) {
      hardKillSent = true;
      transcriptStream.write(
        `[executor] Hard kill triggered: ${decision.reason}\n`,
      );
      killProcess(child);
    }

    // Workspace health check
    if (!(await isWorkspaceAccessible(state.workspacePath))) {
      transcriptStream.write(
        `[executor] Workspace vanished mid-iteration: ${state.workspacePath}\n`,
      );
      hardKillSent = true; // Treat as crash, kill the process
      killProcess(child);
    }
  }, pollIntervalMs);

  // --- Wait for exit ---
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      processExited = true;
      resolve(code);
    });
    child.on("error", (err) => {
      processExited = true;
      transcriptStream.write(`[executor] Process error: ${err.message}\n`);
      resolve(null);
    });
  });

  // --- Cleanup ---
  clearInterval(capPollInterval);
  rl.close();
  transcriptStream.end();

  const walltimeMs = Date.now() - startTime;

  // --- Determine exit reason ---
  const checkpointExists = existsSync(checkpointPath);
  let exitReason: ExitReason;

  if (hardKillSent && !(await isWorkspaceAccessible(state.workspacePath))) {
    // Workspace vanished — definitive crash
    exitReason = "crashed";
  } else if (hardKillSent) {
    exitReason = "hard_killed";
  } else if (softSignalSent && checkpointExists) {
    exitReason = "soft_triggered";
  } else if (checkpointExists) {
    exitReason = "clean";
  } else {
    // No checkpoint written — something went wrong
    exitReason = "crashed";
  }

  return {
    exitReason,
    checkpointPath: checkpointExists ? checkpointPath : null,
    tokensUsed: totalTokens,
    walltimeMs,
  };
}

// ---------------------------------------------------------------------------
// Process killing helper
// ---------------------------------------------------------------------------

function killProcess(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    return; // intentional: process already gone
  }

  // Grace period: SIGKILL after 5s if still alive
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // intentional: process already dead
    }
  }, 5000);
}
