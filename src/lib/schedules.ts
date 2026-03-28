import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";

// ── Types ────────────────────────────────────────────────────────────────────────

export type Schedule = {
  name: string;
  path: string;
  cron: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  goal: string;
};

export type ScheduleMatch = Schedule & {
  /** Why this schedule fired on this tick. */
  reason: string;
};

// ── Cron parsing (subset: minute, hour, day-of-month, month, day-of-week) ────

type CronField = { type: "any" } | { type: "values"; values: number[] };

function parseCronField(field: string, min: number, max: number): CronField {
  if (field === "*") return { type: "any" };

  const values: number[] = [];

  for (const part of field.split(",")) {
    // Handle */N step syntax
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1]!, 10);
      for (let i = min; i <= max; i += step) values.push(i);
      continue;
    }

    // Handle N-M range
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let i = start; i <= end; i++) values.push(i);
      continue;
    }

    // Plain number
    const num = parseInt(part, 10);
    if (!isNaN(num) && num >= min && num <= max) {
      values.push(num);
    }
  }

  return values.length > 0 ? { type: "values", values } : { type: "any" };
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.type === "any") return true;
  return field.values.includes(value);
}

/**
 * Check if a Date matches a 5-field cron expression.
 * Fields: minute hour day-of-month month day-of-week
 */
export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = parseCronField(parts[0]!, 0, 59);
  const hour = parseCronField(parts[1]!, 0, 23);
  const dom = parseCronField(parts[2]!, 1, 31);
  const month = parseCronField(parts[3]!, 1, 12);
  const dow = parseCronField(parts[4]!, 0, 6);

  return (
    fieldMatches(minute, date.getMinutes()) &&
    fieldMatches(hour, date.getHours()) &&
    fieldMatches(dom, date.getDate()) &&
    fieldMatches(month, date.getMonth() + 1) &&
    fieldMatches(dow, date.getDay())
  );
}

/**
 * Compute the next time a cron expression fires after `after`.
 * Brute-force scan forward by minute (max 366 days).
 */
export function nextCronOccurrence(expr: string, after: Date): Date | null {
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = 366 * 24 * 60; // max minutes to scan
  for (let i = 0; i < limit; i++) {
    if (cronMatches(expr, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

// ── Schedule file I/O ────────────────────────────────────────────────────────────

/**
 * Parse a schedule file. Format:
 *
 * ```
 * ---
 * cron: 0 9 * * 1-5
 * enabled: true
 * last-run: 2026-03-27T09:00:00Z
 * next-run: 2026-03-28T09:00:00Z
 * ---
 *
 * Check open PRs and summarize status for each.
 * ```
 */
function parseScheduleFile(name: string, path: string, raw: string): Schedule | null {
  const { attributes, body } = parseFrontmatter(raw);

  const cron = attributes.cron?.trim();
  if (!cron) return null;

  const goal = body.trim();
  if (!goal) return null;

  return {
    name,
    path,
    cron,
    enabled: attributes.enabled !== "false",
    lastRun: attributes["last-run"]?.trim() || null,
    nextRun: attributes["next-run"]?.trim() || null,
    goal,
  };
}

export async function listSchedules(schedulesDir: string): Promise<Schedule[]> {
  let entries: string[];
  try {
    entries = await readdir(schedulesDir);
  } catch {
    return [];
  }

  const schedules: Schedule[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const path = join(schedulesDir, entry);
    try {
      const raw = await Bun.file(path).text();
      const schedule = parseScheduleFile(
        entry.replace(/\.md$/, ""),
        path,
        raw,
      );
      if (schedule) schedules.push(schedule);
    } catch {
      // Skip unreadable files
    }
  }

  return schedules;
}

/**
 * Update a schedule file's last-run and next-run timestamps.
 */
export async function markScheduleRun(schedule: Schedule, now: Date): Promise<void> {
  const nextRun = nextCronOccurrence(schedule.cron, now);

  const raw = await Bun.file(schedule.path).text();
  const { attributes, body } = parseFrontmatter(raw);

  attributes["last-run"] = now.toISOString();
  if (nextRun) {
    attributes["next-run"] = nextRun.toISOString();
  } else {
    delete attributes["next-run"];
  }

  await Bun.write(schedule.path, stringifyFrontmatter(attributes, body));
}

// ── Evaluation ───────────────────────────────────────────────────────────────────

/**
 * Determine which schedules should fire now.
 * A schedule fires if:
 * 1. It is enabled.
 * 2. The cron expression matches the current time.
 * 3. It hasn't already run in this minute (dedup by last-run).
 */
export function evaluateSchedules(
  schedules: Schedule[],
  now: Date = new Date(),
): ScheduleMatch[] {
  const currentMinute = new Date(now);
  currentMinute.setSeconds(0, 0);

  const matches: ScheduleMatch[] = [];

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!cronMatches(schedule.cron, now)) continue;

    // Dedup: skip if last-run is within this same minute
    if (schedule.lastRun) {
      const lastRunMinute = new Date(schedule.lastRun);
      lastRunMinute.setSeconds(0, 0);
      if (lastRunMinute.getTime() === currentMinute.getTime()) continue;
    }

    matches.push({
      ...schedule,
      reason: `cron "${schedule.cron}" matched at ${now.toISOString()}`,
    });
  }

  return matches;
}
