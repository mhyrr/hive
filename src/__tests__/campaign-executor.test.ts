import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  runIteration,
  buildExecutorPrompt,
  parseStreamLine,
  type RunIterationOpts,
} from "../lib/campaign/executor";
import { type CampaignState } from "../lib/campaign/state";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let hiveHome: string;
let workspacePath: string;
let campaignDir: string;

/**
 * Create a stub script that mimics claude's stream-json output.
 * The script writes JSON lines to stdout and optionally writes checkpoint.md.
 */
async function createStubExecutor(
  scriptPath: string,
  opts: {
    /** JSON lines to emit (simulating stream-json output). */
    lines?: string[];
    /** Whether to write checkpoint.md in CWD before exiting. */
    writeCheckpoint?: boolean;
    /** Delay in seconds before exiting (for testing caps). */
    delaySeconds?: number;
    /** Check for sentinel file and exit if found. */
    checkSentinel?: string;
    /** Exit code. */
    exitCode?: number;
    /** If set, delete this directory after a short delay (simulates worktree vanish). */
    deleteDir?: string;
  },
): Promise<void> {
  const {
    lines = [],
    writeCheckpoint = false,
    delaySeconds = 0,
    checkSentinel,
    exitCode = 0,
    deleteDir,
  } = opts;

  // Build a bash script that emits JSON lines and optionally writes checkpoint
  let script = `#!/bin/bash\n`;

  // Emit JSON lines
  for (const line of lines) {
    script += `echo '${line.replace(/'/g, "'\\''")}'\n`;
  }

  // Worktree vanish: delete the directory early then stay alive so health check detects it
  if (deleteDir) {
    script += `sleep 0.5\n`; // Brief pause so executor starts its poll loop
    script += `rm -rf "${deleteDir}"\n`;
    script += `sleep 15\n`; // Stay alive while health check detects and kills us
    script += `exit ${exitCode}\n`;
  } else if (delaySeconds > 0 && checkSentinel) {
    // Sentinel polling: check for file every 100ms
    const totalChecks = delaySeconds * 10;
    script += `
for i in $(seq 1 ${totalChecks}); do
  sleep 0.1
  if [ -f "${checkSentinel}" ]; then
    # Sentinel found — write checkpoint and exit
    echo '{"type":"result","subtype":"success","usage":{"input_tokens":500,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'
    cat > "$PWD/checkpoint.md" << 'CKPT'
# Checkpoint

Soft cap triggered. Saving state.
CKPT
    exit 0
  fi
done
`;
  } else if (delaySeconds > 0) {
    script += `sleep ${delaySeconds}\n`;
  }

  if (!deleteDir) {
    // Write checkpoint if requested
    if (writeCheckpoint) {
      script += `cat > "$PWD/checkpoint.md" << 'CKPT'\n# Checkpoint\n\nIteration complete. All tasks done.\nCKPT\n`;
    }

    // Final result line
    const totalTokens = lines.length > 0 ? "" : `echo '{"type":"result","subtype":"success","usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":200,"cache_creation_input_tokens":0}}'`;
    if (totalTokens) script += `${totalTokens}\n`;

    script += `exit ${exitCode}\n`;
  }

  await writeFile(scriptPath, script, { mode: 0o755 });
}

function makeState(overrides?: Partial<CampaignState>): CampaignState {
  return {
    id: "CAMP-001",
    dir: campaignDir,
    workspacePath,
    status: "running",
    frozenPrefix: "Build the feature end-to-end.",
    plan: "1. [ ] Step one\n2. [ ] Step two",
    checkpoint: null,
    scorecard: [],
    iterationCount: 0,
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<RunIterationOpts>): RunIterationOpts {
  return {
    state: makeState(),
    iterationN: 1,
    caps: { tokens_soft: 100_000, walltime_soft_ms: 30 * 60 * 1000 },
    claudePath: join(tmpDir, "stub-claude"),
    model: "claude-opus-4-6",
    identity: "You are a test executor.",
    hiveHome,
    pollIntervalMs: 1000, // Fast polling for tests
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hive-executor-test-"));
  hiveHome = join(tmpDir, ".hive");
  campaignDir = join(hiveHome, "campaigns", "CAMP-001");
  workspacePath = join(campaignDir, "workspace");

  // Create campaign directory structure
  await mkdir(join(campaignDir, "iterations"), { recursive: true });
  await mkdir(workspacePath, { recursive: true });

  // Initialize workspace as a git repo (so it looks like a worktree)
  execSync("git init && git commit --allow-empty -m 'init'", {
    cwd: workspacePath,
    stdio: "pipe",
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseStreamLine
// ---------------------------------------------------------------------------

describe("parseStreamLine", () => {
  test("extracts usage from assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 30,
        },
      },
    });
    const result = parseStreamLine(line);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 30,
    });
  });

  test("extracts usage from result event", () => {
    const line = JSON.stringify({
      type: "result",
      usage: {
        input_tokens: 5000,
        output_tokens: 1000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 3000,
      },
    });
    const result = parseStreamLine(line);
    expect(result).toEqual({
      inputTokens: 5000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheCreationTokens: 3000,
    });
  });

  test("returns null for system events", () => {
    const line = JSON.stringify({ type: "system", subtype: "init" });
    expect(parseStreamLine(line)).toBeNull();
  });

  test("returns null for empty lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("  ")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseStreamLine("not json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildExecutorPrompt
// ---------------------------------------------------------------------------

describe("buildExecutorPrompt", () => {
  test("includes frozen prefix, plan, and iteration instructions", () => {
    const state = makeState();
    const prompt = buildExecutorPrompt(state, 1, "/tmp/sentinel");

    expect(prompt).toContain("# Prime Directive");
    expect(prompt).toContain("Build the feature end-to-end.");
    expect(prompt).toContain("# Current Plan");
    expect(prompt).toContain("Step one");
    expect(prompt).toContain("# Iteration 1 Instructions");
    expect(prompt).toContain("/tmp/sentinel");
  });

  test("includes previous checkpoint when present", () => {
    const state = makeState({ checkpoint: "Previous work was done on step 1." });
    const prompt = buildExecutorPrompt(state, 2, "/tmp/sentinel");

    expect(prompt).toContain("# Previous Iteration Checkpoint");
    expect(prompt).toContain("Previous work was done on step 1.");
    expect(prompt).toContain("# Iteration 2 Instructions");
  });

  test("omits sections when state fields are null", () => {
    const state = makeState({ frozenPrefix: null, plan: null, checkpoint: null });
    const prompt = buildExecutorPrompt(state, 1, "/tmp/sentinel");

    expect(prompt).not.toContain("# Prime Directive");
    expect(prompt).not.toContain("# Current Plan");
    expect(prompt).not.toContain("# Previous Iteration Checkpoint");
    expect(prompt).toContain("# Iteration 1 Instructions");
  });
});

// ---------------------------------------------------------------------------
// runIteration — clean exit
// ---------------------------------------------------------------------------

describe("runIteration — clean exit", () => {
  test("returns clean when checkpoint is written", async () => {
    const stubPath = join(tmpDir, "stub-claude");
    const assistantLine = JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 0,
      },
    });

    await createStubExecutor(stubPath, {
      lines: [assistantLine, resultLine],
      writeCheckpoint: true,
    });

    const result = await runIteration(makeOpts());

    expect(result.exitReason).toBe("clean");
    expect(result.checkpointPath).toBe(join(workspacePath, "checkpoint.md"));
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.walltimeMs).toBeGreaterThan(0);
  });

  test("writes transcript log to iteration directory", async () => {
    const stubPath = join(tmpDir, "stub-claude");
    const line = JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });

    await createStubExecutor(stubPath, { lines: [line], writeCheckpoint: true });
    await runIteration(makeOpts());

    const transcriptPath = join(campaignDir, "iterations", "1", "transcript.log");
    expect(existsSync(transcriptPath)).toBe(true);
    const content = await readFile(transcriptPath, "utf-8");
    expect(content).toContain("assistant");
  });
});

// ---------------------------------------------------------------------------
// runIteration — crashed (no checkpoint)
// ---------------------------------------------------------------------------

describe("runIteration — crashed", () => {
  test("returns crashed when no checkpoint written", async () => {
    const stubPath = join(tmpDir, "stub-claude");
    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    await createStubExecutor(stubPath, {
      lines: [resultLine],
      writeCheckpoint: false,
    });

    const result = await runIteration(makeOpts());

    expect(result.exitReason).toBe("crashed");
    expect(result.checkpointPath).toBeNull();
  });

  test("returns crashed when workspace unreachable before spawn", async () => {
    const stubPath = join(tmpDir, "stub-claude");
    await createStubExecutor(stubPath, { writeCheckpoint: true });

    // Remove workspace before running
    await rm(workspacePath, { recursive: true, force: true });

    const result = await runIteration(makeOpts());

    expect(result.exitReason).toBe("crashed");
    expect(result.checkpointPath).toBeNull();
    expect(result.walltimeMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// runIteration — soft_triggered
// ---------------------------------------------------------------------------

describe("runIteration — soft_triggered", () => {
  test("writes sentinel file when soft cap hit and reports soft_triggered", async () => {
    const stubPath = join(tmpDir, "stub-claude");
    const iterDir = join(campaignDir, "iterations", "1");
    const sentinelPath = join(iterDir, "soft-cap.signal");

    // Create a stub that runs long enough for the cap to fire,
    // checks for sentinel, writes checkpoint when found
    await createStubExecutor(stubPath, {
      lines: [
        // Emit a large token count to trigger soft cap immediately
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 60000,
              output_tokens: 50000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ],
      delaySeconds: 15,
      checkSentinel: sentinelPath,
    });

    // Use very low soft cap so it triggers immediately, fast poll interval
    const result = await runIteration(
      makeOpts({
        caps: { tokens_soft: 1000, walltime_soft_ms: 30 * 60 * 1000 },
        iterationN: 1,
        state: makeState(),
        pollIntervalMs: 500,
      }),
    );

    expect(result.exitReason).toBe("soft_triggered");
    expect(result.checkpointPath).toBe(join(workspacePath, "checkpoint.md"));
    expect(existsSync(sentinelPath)).toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// runIteration — hard_killed
// ---------------------------------------------------------------------------

describe("runIteration — hard_killed", () => {
  test("kills process when hard cap reached", async () => {
    const stubPath = join(tmpDir, "stub-claude");

    // Create a stub that runs forever (30s) without checking sentinel
    // and emits high token count
    await createStubExecutor(stubPath, {
      lines: [
        JSON.stringify({
          type: "assistant",
          message: {
            usage: {
              input_tokens: 100000,
              output_tokens: 60000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      ],
      delaySeconds: 30,
      writeCheckpoint: false,
    });

    // Very low caps: soft at 1000 tokens, hard at 1500
    // Walltime soft at 2s, hard at 3s
    const result = await runIteration(
      makeOpts({
        caps: { tokens_soft: 1000, walltime_soft_ms: 2000 },
        pollIntervalMs: 500,
      }),
    );

    expect(result.exitReason).toBe("hard_killed");
    expect(result.checkpointPath).toBeNull();
    // Should finish well under 30s due to hard kill
    expect(result.walltimeMs).toBeLessThan(15000);
  }, 20000);
});

// ---------------------------------------------------------------------------
// runIteration — worktree vanishes
// ---------------------------------------------------------------------------

describe("runIteration — worktree vanishes", () => {
  test("detects workspace deletion mid-iteration and returns crashed", async () => {
    const stubPath = join(tmpDir, "stub-claude");

    // Stub that deletes its own workspace directory then stays alive
    await createStubExecutor(stubPath, {
      lines: [
        JSON.stringify({
          type: "assistant",
          message: {
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
      ],
      deleteDir: workspacePath,
    });

    const result = await runIteration(makeOpts({ pollIntervalMs: 500 }));

    expect(result.exitReason).toBe("crashed");
    expect(result.checkpointPath).toBeNull();
    // Should detect workspace gone quickly with fast polling
    expect(result.walltimeMs).toBeLessThan(15000);
  }, 20000);
});
