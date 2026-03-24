import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { isProcessAlive } from "./process";
import { markRunStopRequested, readRunRecord } from "./runs";
import type { RunRecord } from "./runs";
import type { TacticalEvaluation } from "./tactical-evaluator";

export type InterruptResult =
  | { ok: true; runId: string }
  | { ok: false; runId: string; reason: string };

/**
 * Implements the OODA interrupt protocol: writes an interrupt file, sends
 * SIGTERM to the worker process, and updates the run record.
 *
 * Called by the evaluation dispatcher's onInterruptRequest callback.
 */
export async function interruptWorker(opts: {
  runId: string;
  reason: string;
  evaluation: TacticalEvaluation;
  projectRunsActiveDir: string;
}): Promise<InterruptResult> {
  const { runId, reason, evaluation, projectRunsActiveDir } = opts;

  // 1. Find the run record — active runs are stored as <agentId>.md, not <runId>.md
  const run = await findActiveRunById(projectRunsActiveDir, runId);

  if (!run) {
    return { ok: false, runId, reason: "run not found" };
  }

  // 2. Check process is alive before attempting interrupt
  if (!isProcessAlive(run.pid)) {
    return { ok: false, runId, reason: "process not alive" };
  }

  // 3. Interrupt discipline — don't interrupt runs that just started
  const ageMs = Date.now() - new Date(run.started).getTime();

  if (ageMs < 30_000) {
    return { ok: false, runId, reason: "run too new for interrupt" };
  }

  // 4. Write interrupt file — gives the worker a chance to read and flush cleanly
  const interruptPath = join(projectRunsActiveDir, runId, "interrupt.md");
  const interruptedAt = new Date().toISOString();
  const interruptContent = `---
interrupted-at: ${interruptedAt}
interrupted-by: tactical-evaluator
reason: ${reason}
urgency: ${evaluation.urgency}
classification: ${evaluation.classification}
---

# Interrupt

This worker was interrupted by the HIVE tactical evaluator.

**Reason:** ${reason}

Please flush any work-in-progress to disk and terminate cleanly.
`;

  try {
    await Bun.write(interruptPath, interruptContent);
  } catch (err) {
    console.warn(
      `[interrupt-handler] failed to write interrupt file: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Non-fatal — proceed with SIGTERM regardless
  }

  // 5. Send SIGTERM — not SIGKILL, give the process a chance to flush
  if (run.pid === null) {
    return { ok: false, runId, reason: "no pid on run record" };
  }

  try {
    process.kill(run.pid, "SIGTERM");
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : null;

    if (code === "ESRCH") {
      // Process already exited — treat as success (interrupt file is still useful)
    } else if (code === "EPERM") {
      return { ok: false, runId, reason: "permission denied sending SIGTERM" };
    } else {
      return {
        ok: false,
        runId,
        reason: `SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 6. Update the run record — sets stopRequestedAt and stopRequestedBy
  try {
    await markRunStopRequested(run, "tactical-evaluator");
  } catch (err) {
    console.warn(
      `[interrupt-handler] failed to update run record: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Non-fatal — SIGTERM already sent, interrupt is in progress
  }

  return { ok: true, runId };
}

/**
 * Scans projectRunsActiveDir for an active run matching the given runId.
 * Active run files are named <agentId>.md — the runId is in the frontmatter.
 */
async function findActiveRunById(
  projectRunsActiveDir: string,
  runId: string,
): Promise<RunRecord | null> {
  let entries: Awaited<ReturnType<typeof readdir>>;

  try {
    entries = await readdir(projectRunsActiveDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = join(projectRunsActiveDir, entry.name);
    const record = await readRunRecord(filePath);

    if (record?.runId === runId || record?.agentId === runId) {
      return record;
    }
  }

  return null;
}
