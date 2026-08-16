/**
 * Archive snapshot helpers.
 *
 * The nightly build writes a frozen HTML snapshot per day under
 * `~/.hive/dashboard/archive/YYYY-MM-DD.html`. This module lists those
 * snapshots and resolves a path by date.
 *
 * Pure `list` / `resolve` functions; no HTTP, no render logic.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { HivePaths } from "../paths";

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.html$/;

export function archiveDir(paths: HivePaths): string {
  return join(paths.home, "dashboard", "archive");
}

export function archivePathForDate(paths: HivePaths, date: string): string {
  // date must be YYYY-MM-DD — caller validates with isValidArchiveDate.
  return join(archiveDir(paths), `${date}.html`);
}

export function isValidArchiveDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

export type ArchiveEntry = {
  date: string; // YYYY-MM-DD
  path: string; // absolute file path
};

/**
 * List archived dashboard snapshots, newest first.
 *
 * @param paths     HIVE paths root.
 * @param maxDays   Include at most this many days back from the newest entry
 *                  (default 30 — matches the ticket spec's window).
 */
export async function listArchiveFiles(
  paths: HivePaths,
  maxDays = 30,
): Promise<ArchiveEntry[]> {
  const dir = archiveDir(paths);
  const entries = await readdir(dir).catch(() => [] as string[]);

  const matched: ArchiveEntry[] = [];
  for (const name of entries) {
    const m = name.match(DATE_RE);
    if (!m) continue;
    matched.push({ date: m[1]!, path: join(dir, name) });
  }

  // Newest first (ISO dates lexically sort correctly).
  matched.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return matched.slice(0, Math.max(0, maxDays));
}

/**
 * Current-day date string in YYYY-MM-DD (local clock). Exposed so callers
 * (build, tests) can override via injection if needed.
 */
export function todayDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
