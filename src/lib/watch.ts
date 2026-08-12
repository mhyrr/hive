// Watch primitive — declarative standing questions (TK-138).
//
// A watch is a markdown file: frontmatter declares scheduling, scope, and
// autonomy; the body IS the standing question, passed verbatim as the prompt
// core. Locations:
//   ~/.hive/watches/*.md               — cross-project
//   ~/.hive/projects/<p>/watches/*.md  — project-scoped
//
// This module owns parsing, discovery, and due-ness. The delta gate lives in
// watch-delta.ts; execution in watch-run.ts. A malformed watch file degrades
// to a warning, never a throw — one bad file must not kill the tick.

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { listProjects, type HivePaths } from "./paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WatchAutonomy = "observe" | "propose" | "act";
export type WatchVenue = "inbox" | "briefing" | "tickets" | "dispatch";
export type WatchScopeKind = "tickets" | "commits" | "transcripts" | "memory" | "inbox";

/** Model tier alias — resolution to a real model ID lives in watch-model.ts.
 * There is no "deterministic" tier here: a watch that fires makes exactly one
 * model call; everything deterministic happens before the tier matters. */
export type WatchTier = "fast" | "standard" | "judgment";

export type WatchCadence =
  | { type: "interval"; ms: number }
  | { type: "nightly" }
  | { type: "morning" }
  | { type: "weekdays"; days: number[] }; // 0=Sun … 6=Sat, local time

export interface WatchDef {
  /** Short name, unique within its scope. Defaults to the filename sans .md. */
  name: string;
  /** `<project>/<name>` for project watches, bare name for cross-project.
   * This is the state.json key and the CLI address. */
  qualifiedName: string;
  cadence: WatchCadence;
  scope: WatchScopeKind[];
  /** Delta/digest lookback in ms. */
  windowMs: number;
  model: WatchTier;
  venue: WatchVenue;
  autonomy: WatchAutonomy;
  enabled: boolean;
  /** null = cross-project. */
  project: string | null;
  /** The standing question — the markdown body, verbatim. */
  question: string;
  filePath: string;
}

export interface WatchDiscovery {
  watches: WatchDef[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Once-a-day cadences (@morning, weekday lists) fire at or after this local
 * hour — output ready before the workday without competing with interactive
 * quota (the "avoid interactive hours" posture from the budget design). */
export const MORNING_HOUR = 6;

export function parseCadence(raw: string): WatchCadence | null {
  const s = raw.trim().toLowerCase();
  if (s === "@nightly") return { type: "nightly" };
  if (s === "@morning") return { type: "morning" };

  const interval = s.match(/^(\d+)\s*(m|h|d)$/);
  if (interval) {
    const n = Number(interval[1]);
    if (n <= 0) return null;
    return { type: "interval", ms: n * UNIT_MS[interval[2]] };
  }

  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0 && parts.every((p) => p in DAY_NAMES)) {
    const days = [...new Set(parts.map((p) => DAY_NAMES[p]))].sort((a, b) => a - b);
    return { type: "weekdays", days };
  }

  return null;
}

export function formatCadence(cadence: WatchCadence): string {
  switch (cadence.type) {
    case "nightly":
      return "@nightly";
    case "morning":
      return "@morning";
    case "interval": {
      for (const [unit, ms] of Object.entries(UNIT_MS).reverse()) {
        if (cadence.ms % ms === 0) return `${cadence.ms / ms}${unit}`;
      }
      return `${Math.round(cadence.ms / 60_000)}m`;
    }
    case "weekdays": {
      const names = Object.entries(DAY_NAMES);
      return cadence.days
        .map((d) => names.find(([, n]) => n === d)?.[0] ?? String(d))
        .join(",");
    }
  }
}

export function parseWindow(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^(\d+)\s*(m|h|d)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  return n * UNIT_MS[m[2]];
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Should the hourly tick evaluate this watch now? `lastRun` is the last time
 * the watch was EVALUATED (delta-gated or not) — a quiet morning evaluation
 * marks the day done; the gate decides model calls, not due-ness.
 *
 * `@nightly` is never due on the tick: the nightly orchestrator invokes those
 * explicitly so they can read that night's runs/{DATE}/ artifacts.
 */
export function isDue(cadence: WatchCadence, lastRun: string | null, now: Date): boolean {
  const parsed = lastRun ? new Date(lastRun) : null;
  const last = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  switch (cadence.type) {
    case "nightly":
      return false;
    case "interval":
      return !last || now.getTime() - last.getTime() >= cadence.ms;
    case "morning":
      if (now.getHours() < MORNING_HOUR) return false;
      return !last || !sameLocalDay(last, now);
    case "weekdays":
      if (!cadence.days.includes(now.getDay())) return false;
      if (now.getHours() < MORNING_HOUR) return false;
      return !last || !sameLocalDay(last, now);
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export const SCOPE_KINDS: WatchScopeKind[] = ["tickets", "commits", "transcripts", "memory", "inbox"];
export const AUTONOMY_LEVELS: WatchAutonomy[] = ["observe", "propose", "act"];
export const VENUES: WatchVenue[] = ["inbox", "briefing", "tickets", "dispatch"];
export const TIERS: WatchTier[] = ["fast", "standard", "judgment"];

const DEFAULT_WINDOW_MS = 86_400_000; // 24h

export interface ParseWatchResult {
  watch: WatchDef | null;
  warnings: string[];
}

export function parseWatchFile(
  content: string,
  filePath: string,
  project: string | null,
): ParseWatchResult {
  const warnings: string[] = [];
  const { attributes, body } = parseFrontmatter(content);
  const label = project ? `${project}/${basename(filePath)}` : basename(filePath);

  if (body.trim() === "") {
    return { watch: null, warnings: [`${label}: empty body — a watch IS its standing question; skipped`] };
  }

  const rawCadence = attributes.cadence?.trim();
  if (!rawCadence) {
    return { watch: null, warnings: [`${label}: missing cadence; skipped`] };
  }
  const cadence = parseCadence(rawCadence);
  if (!cadence) {
    return { watch: null, warnings: [`${label}: unparseable cadence "${rawCadence}"; skipped`] };
  }

  const name = attributes.name?.trim() || basename(filePath).replace(/\.md$/, "");

  let scope: WatchScopeKind[];
  if (attributes.scope?.trim()) {
    const requested = attributes.scope.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    scope = requested.filter((s): s is WatchScopeKind => (SCOPE_KINDS as string[]).includes(s));
    const dropped = requested.filter((s) => !(SCOPE_KINDS as string[]).includes(s));
    if (dropped.length > 0) warnings.push(`${label}: unknown scope kind(s) ${dropped.join(", ")} — dropped`);
    if (scope.length === 0) {
      warnings.push(`${label}: no valid scope kinds — defaulting to all`);
      scope = [...SCOPE_KINDS];
    }
  } else {
    scope = [...SCOPE_KINDS];
  }

  let windowMs = DEFAULT_WINDOW_MS;
  if (attributes.window?.trim()) {
    const parsed = parseWindow(attributes.window);
    if (parsed === null) {
      warnings.push(`${label}: unparseable window "${attributes.window}" — defaulting to 24h`);
    } else {
      windowMs = parsed;
    }
  }

  const rawTier = attributes.model?.trim().toLowerCase();
  let model: WatchTier = "standard";
  if (rawTier) {
    if ((TIERS as string[]).includes(rawTier)) {
      model = rawTier as WatchTier;
    } else {
      warnings.push(`${label}: unknown model tier "${rawTier}" (want ${TIERS.join("|")}) — defaulting to standard`);
    }
  }

  const rawAutonomy = attributes.autonomy?.trim().toLowerCase();
  let autonomy: WatchAutonomy = "observe";
  if (rawAutonomy) {
    if ((AUTONOMY_LEVELS as string[]).includes(rawAutonomy)) {
      autonomy = rawAutonomy as WatchAutonomy;
    } else {
      warnings.push(`${label}: unknown autonomy "${rawAutonomy}" — defaulting to observe`);
    }
  }

  const rawVenue = attributes.venue?.trim().toLowerCase();
  let venue: WatchVenue = "inbox";
  if (rawVenue) {
    if ((VENUES as string[]).includes(rawVenue)) {
      venue = rawVenue as WatchVenue;
    } else {
      warnings.push(`${label}: unknown venue "${rawVenue}" — defaulting to inbox`);
    }
  }

  const enabled = attributes.enabled?.trim().toLowerCase() !== "false";

  return {
    watch: {
      name,
      qualifiedName: project ? `${project}/${name}` : name,
      cadence,
      scope,
      windowMs,
      model,
      venue,
      autonomy,
      enabled,
      project,
      question: body.trim(),
      filePath,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function listWatchFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(dir, e.name))
    .sort();
}

export async function discoverWatches(paths: HivePaths): Promise<WatchDiscovery> {
  const watches: WatchDef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const collect = async (dir: string, project: string | null) => {
    for (const file of await listWatchFiles(dir)) {
      let content: string;
      try {
        content = await Bun.file(file).text();
      } catch (err) {
        warnings.push(`${file}: unreadable (${err instanceof Error ? err.message : String(err)}); skipped`);
        continue;
      }
      const { watch, warnings: w } = parseWatchFile(content, file, project);
      warnings.push(...w);
      if (!watch) continue;
      if (seen.has(watch.qualifiedName)) {
        warnings.push(`${file}: duplicate watch name "${watch.qualifiedName}" — keeping the first`);
        continue;
      }
      seen.add(watch.qualifiedName);
      watches.push(watch);
    }
  };

  await collect(paths.watchesDir, null);
  for (const project of await listProjects(paths.projectsDir)) {
    await collect(join(paths.projectsDir, project, "watches"), project);
  }

  return { watches, warnings };
}

/** Find a watch by qualified name, or by bare name when unambiguous. */
export function findWatch(watches: WatchDef[], ref: string): WatchDef | null {
  const exact = watches.find((w) => w.qualifiedName === ref);
  if (exact) return exact;
  const byName = watches.filter((w) => w.name === ref);
  return byName.length === 1 ? byName[0] : null;
}

// ---------------------------------------------------------------------------
// Frontmatter rewrite (CLI `set` / `on` / `off` — no hand-editing files)
// ---------------------------------------------------------------------------

/** Rewrite frontmatter keys in a watch file, preserving the body verbatim.
 * Values are written as given; validation happens on the next parse. */
export async function rewriteWatchFrontmatter(
  filePath: string,
  updates: Record<string, string>,
): Promise<void> {
  const content = await Bun.file(filePath).text();
  const { attributes, body } = parseFrontmatter(content);
  await Bun.write(filePath, stringifyFrontmatter({ ...attributes, ...updates }, body));
}
