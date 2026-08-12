// Per-watch tick state — ~/.hive/watches/state.json (TK-138).
//
// Records what each watch last saw (delta digests), when it last ran, and a
// log-only usage envelope. Corrupt or missing state loads fresh (fail open):
// the cost of forgetting is one extra delta evaluation, never lost work.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { HivePaths } from "./paths";

/** Log-only spend record. Token accounting from spawned runs is unreliable
 * (TK-120/TK-128), so budgets are enforced as COUNT caps in the runner; this
 * envelope exists so `hive watch status` can show what was logged, not to gate. */
export interface WatchTickUsage {
  at: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
}

export type WatchOutcome =
  | "surfaced" // model called, output written to venue
  | "quiet" // model called, model chose silence (valid answer)
  | "no-delta" // gate said nothing changed — zero model calls
  | "deferred:quota" // rate-limited — skipped without retry this tick
  | "error";

export interface WatchStateEntry {
  /** Last EVALUATION (delta-gated or not) — due-ness anchors here. */
  lastRun: string | null;
  /** Last tick that actually made a model call. */
  lastInvoked: string | null;
  lastOutcome: WatchOutcome | null;
  lastError: string | null;
  /** scope kind → digest hash of what this watch last saw. */
  lastDigests: Record<string, string>;
  usage: WatchTickUsage[];
}

export interface WatchState {
  watches: Record<string, WatchStateEntry>;
}

const USAGE_LOG_CAP = 100;

export function watchStatePath(paths: HivePaths): string {
  return join(paths.watchesDir, "state.json");
}

export function freshEntry(): WatchStateEntry {
  return {
    lastRun: null,
    lastInvoked: null,
    lastOutcome: null,
    lastError: null,
    lastDigests: {},
    usage: [],
  };
}

export async function loadWatchState(paths: HivePaths): Promise<WatchState> {
  try {
    const raw = await Bun.file(watchStatePath(paths)).text();
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "watches" in parsed &&
      typeof (parsed as WatchState).watches === "object" &&
      (parsed as WatchState).watches !== null
    ) {
      return { watches: (parsed as WatchState).watches };
    }
  } catch {
    // intentional: missing or corrupt state → fresh (fail open)
  }
  return { watches: {} };
}

export async function saveWatchState(paths: HivePaths, state: WatchState): Promise<void> {
  await mkdir(paths.watchesDir, { recursive: true });
  await Bun.write(watchStatePath(paths), JSON.stringify(state, null, 2) + "\n");
}

/** Get (creating in place) the entry for a qualified watch name. */
export function stateEntry(state: WatchState, qualifiedName: string): WatchStateEntry {
  const existing = state.watches[qualifiedName];
  if (existing) return existing;
  const entry = freshEntry();
  state.watches[qualifiedName] = entry;
  return entry;
}

export function recordUsage(entry: WatchStateEntry, usage: WatchTickUsage): void {
  entry.usage.push(usage);
  if (entry.usage.length > USAGE_LOG_CAP) {
    entry.usage.splice(0, entry.usage.length - USAGE_LOG_CAP);
  }
}

/** Sum of logged tokens across usage records newer than `sinceMs` epoch. */
export function usageSince(
  entry: WatchStateEntry,
  sinceMs: number,
): { calls: number; inputTokens: number; outputTokens: number } {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const u of entry.usage) {
    const at = new Date(u.at).getTime();
    if (Number.isNaN(at) || at < sinceMs) continue;
    calls += 1;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
  }
  return { calls, inputTokens, outputTokens };
}
