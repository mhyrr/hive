// Watch primitive — declarative standing questions (TK-138).
//
// A watch is a markdown file: frontmatter declares scheduling, scope, and
// autonomy; the body IS the standing question, passed verbatim as the prompt
// core. Locations:
//   ~/.hive/watches/*.md               — cross-project (Observe stays here;
//                                        Act/Propose fan out to every registered
//                                        project at discovery, same spec file)
//   ~/.hive/projects/<p>/watches/*.md  — project-scoped; a same-name file wins
//                                        over the fanned fleet spec
//
// This module owns parsing, discovery, and due-ness. The delta gate lives in
// watch-delta.ts; execution in watch-run.ts. A malformed watch file degrades
// to a warning, never a throw — one bad file must not kill the tick.

import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { UsageError } from "./errors";
import { getProjectPaths, listProjects, type HivePaths } from "./paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WatchAutonomy = "observe" | "propose" | "act";
export type WatchVenue = "inbox" | "briefing" | "tickets" | "act";
export type WatchScopeKind = "tickets" | "commits" | "transcripts" | "memory" | "inbox" | "runs";

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
  model: WatchTier;
  venue: WatchVenue;
  autonomy: WatchAutonomy;
  enabled: boolean;
  /** null = cross-project. */
  project: string | null;
  /** The standing question — the markdown body, verbatim. */
  question: string;
  filePath: string;
  /** True when this instance was synthesized from a fleet Act/Propose spec.
   * Mutations of a fanned instance must not rewrite that shared file. */
  fanned: boolean;
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

export interface WatchInterval {
  since: Date;
  until: Date;
  durationMs: number;
}

/**
 * Evidence always spans the previous settled tick through this tick. A late
 * launchd wake therefore widens the interval instead of dropping activity.
 * First runs use one cadence period; calendar cadences use 24h because there
 * is no prior cursor yet.
 */
export function watchInterval(
  cadence: WatchCadence,
  lastRun: string | null,
  now: Date,
): WatchInterval {
  const parsed = lastRun ? new Date(lastRun) : null;
  const validLast = parsed && !Number.isNaN(parsed.getTime()) && parsed.getTime() < now.getTime()
    ? parsed
    : null;
  const firstDuration = cadence.type === "interval" ? cadence.ms : UNIT_MS.d;
  const since = validLast ?? new Date(now.getTime() - firstDuration);
  return { since, until: now, durationMs: now.getTime() - since.getTime() };
}

export function formatWatchDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (remainder === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${remainder} minute${remainder === 1 ? "" : "s"}`;
}

/** The shipped cycle prompts use this token; custom watches may use it too. */
export function renderWatchQuestion(question: string, interval: WatchInterval): string {
  return question.replaceAll("{{interval}}", formatWatchDuration(interval.durationMs));
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

export const SCOPE_KINDS: WatchScopeKind[] = ["tickets", "commits", "transcripts", "memory", "inbox", "runs"];

/** Default when frontmatter omits scope. Excludes `runs` — nightly-artifact
 * deltas are an explicit opt-in (@nightly watches), not ambient noise. */
export const DEFAULT_SCOPE: WatchScopeKind[] = ["tickets", "commits", "transcripts", "memory", "inbox"];
export const AUTONOMY_LEVELS: WatchAutonomy[] = ["observe", "propose", "act"];
export const VENUES: WatchVenue[] = ["inbox", "briefing", "tickets", "act"];
export const TIERS: WatchTier[] = ["fast", "standard", "judgment"];

export interface ParseWatchResult {
  watch: WatchDef | null;
  warnings: string[];
}

/** A watch name must be a single path component so override dest stays in watches/. */
export function isSafeWatchName(name: string): boolean {
  if (!name || name.includes("\0")) return false;
  if (name !== basename(name)) return false;
  const segments = name.split(/[/\\]/);
  return segments.length === 1 && segments[0] !== "." && segments[0] !== "..";
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
  if (!isSafeWatchName(name)) {
    return { watch: null, warnings: [`${label}: unsafe watch name "${name}" — skipped`] };
  }

  let scope: WatchScopeKind[];
  if (attributes.scope?.trim()) {
    const requested = attributes.scope.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    scope = requested.filter((s): s is WatchScopeKind => (SCOPE_KINDS as string[]).includes(s));
    const dropped = requested.filter((s) => !(SCOPE_KINDS as string[]).includes(s));
    if (dropped.length > 0) warnings.push(`${label}: unknown scope kind(s) ${dropped.join(", ")} — dropped`);
    if (scope.length === 0) {
      warnings.push(`${label}: no valid scope kinds — defaulting to all`);
      scope = [...DEFAULT_SCOPE];
    }
  } else {
    scope = [...DEFAULT_SCOPE];
  }

  if (attributes.window?.trim()) {
    warnings.push(`${label}: window is obsolete and ignored — evidence follows settled ticks`);
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
    if (rawVenue === "dispatch") {
      // Compatibility for Act watches installed before the public dispatch
      // subsystem was retired. Rewriting user-owned watch files is not the
      // parser's job; newly scaffolded watches use `act`.
      venue = "act";
      warnings.push(`${label}: venue "dispatch" is deprecated — treating it as "act"`);
    } else if ((VENUES as string[]).includes(rawVenue)) {
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
      model,
      venue,
      autonomy,
      enabled,
      project,
      question: body.trim(),
      filePath,
      fanned: false,
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
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md")
    .map((e) => join(dir, e.name))
    .sort();
}

/** Fleet Act/Propose specs (no project) become one evaluation per registered project. */
export function isFleetCycleWatch(watch: WatchDef): boolean {
  return watch.project === null && (watch.autonomy === "act" || watch.autonomy === "propose");
}

export async function discoverWatches(paths: HivePaths): Promise<WatchDiscovery> {
  const collected: WatchDef[] = [];
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
      collected.push(watch);
    }
  };

  await collect(paths.watchesDir, null);
  const projects = await listProjects(paths.projectsDir);
  for (const project of projects) {
    await collect(join(paths.projectsDir, project, "watches"), project);
  }

  const watches: WatchDef[] = [];
  for (const watch of collected) {
    if (!isFleetCycleWatch(watch) || projects.length === 0) {
      watches.push(watch);
      continue;
    }
    for (const project of projects) {
      const qualifiedName = `${project}/${watch.name}`;
      if (seen.has(qualifiedName) && collected.some((item) => item.qualifiedName === qualifiedName)) {
        warnings.push(`${watch.filePath}: not fanning ${qualifiedName} — project already has that watch`);
        continue;
      }
      watches.push({ ...watch, project, qualifiedName, fanned: true });
    }
  }

  return { watches, warnings };
}

/** All watches matching a qualified name, or every instance of a bare name (fan-out). */
export function findWatches(watches: WatchDef[], ref: string): WatchDef[] {
  const exact = watches.filter((w) => w.qualifiedName === ref);
  if (exact.length > 0) return exact;
  return watches.filter((w) => w.name === ref);
}

/** Find a watch by qualified name, or by bare name when unambiguous. */
export function findWatch(watches: WatchDef[], ref: string): WatchDef | null {
  const found = findWatches(watches, ref);
  return found.length === 1 ? found[0] : null;
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

/** Copy a fleet spec into a project's watches dir and apply updates.
 * Filename is `${name}.md` (not the fleet basename) so a coincidentally-named
 * local file is left alone. Never overwrites; if `${name}.md` is taken, try
 * `${name}.override.md`, then refuse. */
export async function writeWatchOverride(
  paths: HivePaths,
  watch: WatchDef,
  updates: Record<string, string>,
): Promise<string> {
  if (!watch.project) {
    throw new Error(`cannot override ${watch.qualifiedName}: not project-scoped`);
  }
  const destDir = getProjectPaths(paths, watch.project).watchesDir;
  await mkdir(destDir, { recursive: true });
  const dest = overrideDestPath(destDir, watch.name);
  await Bun.write(dest, await Bun.file(watch.filePath).text());
  await rewriteWatchFrontmatter(dest, updates);
  return dest;
}

export function overrideDestPath(destDir: string, watchName: string): string {
  if (!isSafeWatchName(watchName)) {
    throw new UsageError(`unsafe watch name "${watchName}" — must be a single path component`);
  }
  const destRoot = resolve(destDir);
  const candidates = [`${watchName}.md`, `${watchName}.override.md`];
  for (const name of candidates) {
    const dest = join(destDir, name);
    const rel = relative(destRoot, resolve(dest));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new UsageError(`unsafe watch name "${watchName}" — must be a single path component`);
    }
    if (!existsSync(dest)) return dest;
  }
  throw new UsageError(
    `refusing to overwrite existing project watch files (${candidates.join(", ")}) in ${destDir}`,
  );
}

/** Apply on/off/set. A qualified fanned instance becomes a project override.
 * Bare names that match any fanned instance refuse — they would rewrite the
 * shared fleet spec for every project. Local (non-fanned) files rewrite in place. */
export async function mutateWatches(
  paths: HivePaths,
  ref: string,
  matches: WatchDef[],
  updates: Record<string, string>,
): Promise<{ files: string[]; createdOverride: boolean }> {
  const exact = matches.find((w) => w.qualifiedName === ref);
  if (exact?.fanned) {
    const dest = await writeWatchOverride(paths, exact, updates);
    return { files: [dest], createdOverride: true };
  }
  const fanned = matches.filter((w) => w.fanned);
  if (fanned.length > 0) {
    const known = [...new Set(fanned.map((w) => w.qualifiedName))].sort().join(", ");
    throw new UsageError(
      `"${ref}" is a fanned fleet watch — use a qualified name (e.g. ${fanned[0]!.qualifiedName}) so the shared spec is not rewritten. Known: ${known}`,
    );
  }
  const files = [...new Set(matches.map((w) => w.filePath))];
  for (const file of files) await rewriteWatchFrontmatter(file, updates);
  return { files, createdOverride: false };
}
