// Nightly resume manifest and taste-cadence gate.
//
// runs/{DATE}/resume.json records which passes finished for that date. The
// orchestrator writes it; nothing else does. A retry of the same date skips a
// pass only when this manifest says it finished AND its artifact is still on
// disk. An artifact alone is not proof: a stale file planted by an older run
// must never stand in for tonight's work (see the stale-artifact tests).
//
// The same manifests carry the taste track's history, which the cadence gate
// reads: when the track last finished, and through which date each project's
// sessions have been analyzed.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HivePaths } from "./paths";
import type { TasteConsolidateResult } from "./taste-consolidate";

export interface ResumeManifest {
  version: 1;
  date: string;
  /** Pass B, per project: ISO time the candidates file was written. */
  B: Record<string, string>;
  C?: string;
  V?: string;
  /** Pass F applied V's decisions to canon. Once set, the fact track is done
   * for this date: re-running it would apply a second time. */
  F?: string;
  /** Taste track, per project: finished through TC (or had nothing for TC).
   * `tc` is the project's TC result, kept so a resumed run can rebuild the
   * combined taste-decisions file without re-running TC. */
  taste: Record<string, { at: string; tc: TasteConsolidateResult | null }>;
  /** Every targeted project finished the taste track for this date. */
  tasteComplete?: string;
}

const FILENAME = "resume.json";
const DAY_MS = 86_400_000;

export function emptyManifest(date: string): ResumeManifest {
  return { version: 1, date, B: {}, taste: {} };
}

export function manifestPath(paths: HivePaths, date: string): string {
  return join(paths.memoryRunsDir, date, FILENAME);
}

export function readManifest(paths: HivePaths, date: string): ResumeManifest | null {
  const file = manifestPath(paths, date);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as ResumeManifest;
    if (parsed?.version !== 1) return null;
    return { ...emptyManifest(date), ...parsed };
  } catch {
    // intentional: a corrupt manifest resumes nothing, so every pass re-runs
    return null;
  }
}

export async function writeManifest(paths: HivePaths, manifest: ResumeManifest): Promise<void> {
  const dir = join(paths.memoryRunsDir, manifest.date);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FILENAME), JSON.stringify(manifest, null, 2));
}

// ---------------------------------------------------------------------------
// Taste cadence gate
// ---------------------------------------------------------------------------

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Run dates before `date` that have a manifest, newest first. */
function priorManifests(paths: HivePaths, date: string): ResumeManifest[] {
  if (!existsSync(paths.memoryRunsDir)) return [];
  return readdirSync(paths.memoryRunsDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
    .sort()
    .reverse()
    .map((d) => readManifest(paths, d))
    .filter((m): m is ResumeManifest => m !== null);
}

/** Longest catch-up a taste run covers. Bounds the TA/TB prompt after a long
 * gap (a week off, a broken nightly); older sessions are left behind. */
export const MAX_TASTE_CATCHUP_DAYS = 7;

export interface TasteGate {
  run: boolean;
  /** Last date before tonight whose taste track finished; null when none. */
  lastRun: string | null;
  /** The first date the track is due. Equals `date` when it runs tonight. */
  nextRun: string;
  /** Days of sessions tonight's run covers when nothing narrower is known. */
  catchUpDays: number;
  reason: string;
}

/**
 * Decide whether the taste track runs on `date`. It runs when the last finished
 * taste run is at least `everyNights` days back, or when none is on record.
 * Measuring from the last finished run (not date parity) survives skipped and
 * failed nights: a missed run makes the next night due rather than waiting out
 * another cycle.
 */
export function decideTasteGate(paths: HivePaths, date: string, everyNights: number): TasteGate {
  const last = priorManifests(paths, date).find((m) => m.tasteComplete)?.date ?? null;
  if (last === null) {
    return { run: true, lastRun: null, nextRun: date, catchUpDays: 1, reason: "no prior taste run on record" };
  }
  const gap = daysBetween(last, date);
  const nextRun = addDays(last, everyNights);
  if (gap >= everyNights) {
    return {
      run: true,
      lastRun: last,
      nextRun: date,
      catchUpDays: Math.min(gap, MAX_TASTE_CATCHUP_DAYS),
      reason: `last taste run ${last}, ${gap} night(s) ago`,
    };
  }
  return {
    run: false,
    lastRun: last,
    nextRun,
    catchUpDays: 0,
    reason: `last taste run ${last}; runs every ${everyNights} nights`,
  };
}

/**
 * Days of sessions one project's taste run must cover on `date`: back to the
 * last date that analyzed this project, whether in a finished track or as one
 * finished project of a track that failed elsewhere. Covering only from the
 * last finished track would re-analyze that project's sessions, and TC would
 * count each re-seen rule as a second observation.
 */
export function projectCatchUpDays(
  paths: HivePaths,
  date: string,
  projectId: string,
  gate: TasteGate,
): number {
  for (const m of priorManifests(paths, date)) {
    if (m.tasteComplete || m.taste[projectId]) {
      return Math.max(1, Math.min(daysBetween(m.date, date), MAX_TASTE_CATCHUP_DAYS));
    }
  }
  return Math.max(1, gate.catchUpDays);
}

/** Dates from `catchUpDays - 1` days before `date` through `date`. */
export function catchUpDates(date: string, catchUpDays: number): string[] {
  const out: string[] = [];
  for (let i = catchUpDays - 1; i >= 0; i--) out.push(addDays(date, -i));
  return out;
}
