import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import { type HivePaths } from "./paths";
import { listTickets } from "./ticket";

/**
 * Deterministic pre-check for whether a heartbeat tick should invoke the LLM.
 *
 * ~90% of heartbeat ticks are no-ops emitting HEARTBEAT_OK with zero meaningful
 * output (empirically: 88 ticks / 48h produced ~11.5K total output tokens on the
 * hive project's heartbeat). Spending a frontier model on "look at structured
 * data and decide nothing happened" is a rules engine wearing a model costume.
 *
 * This module provides that rules engine. Before runTick invokes Claude, it asks
 * shouldInvokeHeartbeat whether anything has changed since the last tick. If
 * nothing has, the tick short-circuits to HEARTBEAT_OK without any LLM cost.
 *
 * Design principles:
 * - Bias toward invocation. False positives are cheap (one extra LLM call);
 *   false negatives could miss real signals (a failed dispatch, a stalled
 *   ticket). When in doubt, invoke.
 * - Fail open, not closed. Any error reading state → invoke, so we never
 *   silently swallow real work because a filesystem call threw.
 * - All signals are cheap and local — no network, no LLM, no git clones.
 * - Reasons are strings, structured enough for the LLM to focus on them when
 *   we do invoke.
 */

export interface TriggerInput {
  projectId: string;
  projectPath: string;
  /** ISO timestamp of the previous tick, or "" on the very first tick. */
  lastTick: string;
  paths: HivePaths;
}

export interface TriggerResult {
  invoke: boolean;
  reasons: string[];
}

/**
 * Force an LLM invocation at least this often, even if nothing has mechanically
 * changed. This gives the agent a regular window to do things that the rules
 * engine can't detect — memory consolidation, noticing subtle patterns, responding
 * to goals in inbox.md, etc. One hour is a reasonable compromise between cost
 * and staying-awake.
 */
const FORCED_INVOCATION_INTERVAL_MS = 60 * 60 * 1000;

export async function shouldInvokeHeartbeat(input: TriggerInput): Promise<TriggerResult> {
  const reasons: string[] = [];

  // First tick — always invoke so the agent reads standing orders and establishes
  // baseline state.
  if (!input.lastTick) {
    return { invoke: true, reasons: ["first tick — no prior lastTick recorded"] };
  }

  const lastTickMs = new Date(input.lastTick).getTime();
  if (Number.isNaN(lastTickMs)) {
    // Corrupt lastTick — fail open.
    return { invoke: true, reasons: [`lastTick unparseable (${input.lastTick}) — invoking to re-establish state`] };
  }

  // Hourly forced tick. Even with nothing else changing, give the agent a
  // window to do cross-cutting things. Costs ~24 LLM calls/day/project in the
  // worst case (fully idle project).
  const elapsedMs = Date.now() - lastTickMs;
  if (elapsedMs >= FORCED_INVOCATION_INTERVAL_MS) {
    reasons.push(`hourly forced invocation (${Math.round(elapsedMs / 60000)}m since last tick)`);
  }

  // Signal 1: New commits since last tick. Uses `git log --since` scoped to the
  // project path. Cheap shell call.
  try {
    const commits = detectNewCommits(input.projectPath, input.lastTick);
    if (commits.length > 0) {
      reasons.push(`${commits.length} new commit(s) since last tick: ${commits.slice(0, 3).join(", ")}${commits.length > 3 ? ", ..." : ""}`);
    }
  } catch {
    // intentional: not a git repo or git unavailable — skip this signal
  }

  // Signal 2: Any ticket with updated > lastTick. Catches new tickets, status
  // changes, and ticket notes (which bump updated).
  try {
    const open = await listTickets(input.paths, input.projectId, {});
    const changed = open.filter((t) => {
      const updatedMs = new Date(t.updated).getTime();
      return !Number.isNaN(updatedMs) && updatedMs > lastTickMs;
    });
    if (changed.length > 0) {
      const ids = changed.slice(0, 5).map((t) => t.id).join(", ");
      reasons.push(`${changed.length} ticket(s) updated since last tick: ${ids}${changed.length > 5 ? ", ..." : ""}`);
    }
  } catch {
    // intentional: ticket read failure — fail open so we don't miss real changes
    reasons.push("ticket read failed — invoking to re-check");
  }

  // Signal 3: Ready auto-dispatch tickets. If any open ticket is tagged
  // auto-dispatch AND has no unresolved dependencies, the heartbeat should pick
  // it up. We check for the existence of *any* such ticket every tick — if the
  // previous tick dispatched it, its status would now be in_progress and it
  // wouldn't appear in this list.
  try {
    const open = await listTickets(input.paths, input.projectId, { status: "open" });
    const closed = await listTickets(input.paths, input.projectId, { status: "closed" });
    const closedIds = new Set(closed.map((t) => t.id));
    const ready = open.filter((t) =>
      t.tags.includes("auto-dispatch") &&
      t.depends.every((d) => closedIds.has(d))
    );
    if (ready.length > 0) {
      const ids = ready.map((t) => t.id).join(", ");
      reasons.push(`${ready.length} auto-dispatch ticket(s) ready: ${ids}`);
    }
  } catch {
    // intentional: auto-dispatch ticket check failed — skip signal
  }

  // Signal 4: Dispatch runs changed since last tick. Any RUN-* directory whose
  // status file was modified after lastTick — catches starts, completions,
  // failures, crashes, whatever. We deliberately don't try to distinguish
  // "new information since last tick" from "already acknowledged"; the LLM
  // can check inbox.md for that context when it runs.
  try {
    const changed = detectChangedRuns(input.paths, lastTickMs);
    if (changed.length > 0) {
      reasons.push(`${changed.length} dispatch run(s) changed status since last tick: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", ..." : ""}`);
    }
  } catch {
    // intentional: runs dir missing or unreadable — skip signal
  }

  return { invoke: reasons.length > 0, reasons };
}

/**
 * Returns short commit hashes for commits authored after `since` (an ISO
 * timestamp). Uses `git log --since` which is a stringified timestamp compare,
 * not a commit-time exact compare, but good enough for "has anything happened
 * since last tick."
 */
function detectNewCommits(projectPath: string, since: string): string[] {
  const raw = execSync(
    `git log --since='${since}' --pretty=format:'%h %s' 2>/dev/null`,
    { cwd: projectPath, encoding: "utf-8" }
  ).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Returns RUN-* directory names whose status file has mtime > sinceMs.
 */
function detectChangedRuns(paths: HivePaths, sinceMs: number): string[] {
  const runsDir = join(paths.home, "runs");
  if (!existsSync(runsDir)) return [];

  const changed: string[] = [];
  const entries = readdirSync(runsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("RUN-")) continue;
    const statusPath = join(runsDir, entry.name, "status");
    if (!existsSync(statusPath)) continue;
    try {
      const stat = statSync(statusPath);
      if (stat.mtimeMs > sinceMs) {
        const status = readFileSync(statusPath, "utf-8").trim();
        changed.push(`${entry.name}=${status}`);
      }
    } catch {
      // intentional: skip unreadable run status file
    }
  }
  return changed;
}
