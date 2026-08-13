// Watch invocation log — the exact prompts, one file per model call (TK-138).
//
// One module owns the format so writer and reader never drift: the runner
// writes through writeInvocationLog, the dashboard reads through
// readInvocations. Layout:
//   ~/.hive/watches/log/<YYYY-MM-DD>/<qualified--name>-<stamp>.md
// Frontmatter carries the meta (watch, at, model, autonomy, outcome, reasons);
// the body is three VERBATIM sections — system prompt, user content, and
// either output or error. Verbatim is the point: this is the audit trail for
// "what did the watch actually ask, and what came back".
//
// A malformed log file degrades to a warning, never a throw — the log is
// observability, and unreadable observability must not take a page down.

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter } from "./frontmatter";
import type { HivePaths } from "./paths";
import { toCompactTimestamp, toIsoTimestamp } from "./time";
import type { WatchAutonomy, WatchDef } from "./watch";

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

const SECTION_SYSTEM = "## System prompt";
const SECTION_USER = "## User content (digest + standing question)";
const SECTION_OUTPUT = "## Output";
const SECTION_ERROR = "## Error";

/** Log dir for a date, `YYYY-MM-DD`. */
export function invocationLogDir(paths: HivePaths, date: string): string {
  return join(paths.watchesDir, "log", date);
}

/** Filename prefix for a watch — `/` is not a path separator here. */
function filePrefix(qualifiedName: string): string {
  return qualifiedName.replace(/\//g, "--");
}

/** Full observability for every model call: the EXACT prompts sent and what
 * came back. No-delta ticks write nothing here (there was no call to record). */
export async function writeInvocationLog(args: {
  paths: HivePaths;
  watch: WatchDef;
  now: Date;
  modelId: string;
  autonomy: WatchAutonomy;
  reasons: string[];
  systemPrompt: string;
  userContent: string;
  output: string | null;
  outcome: string;
  error?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  const dir = invocationLogDir(args.paths, args.now.toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${filePrefix(args.watch.qualifiedName)}-${toCompactTimestamp(args.now)}.md`);
  const body = [
    "---",
    `watch: ${args.watch.qualifiedName}`,
    `at: ${toIsoTimestamp(args.now)}`,
    `model: ${args.modelId}`,
    `autonomy: ${args.autonomy}`,
    `outcome: ${args.outcome}`,
    ...(args.durationMs != null ? [`durationMs: ${args.durationMs}`] : []),
    ...(args.reasons.length > 0 ? [`reasons: ${args.reasons.join(" | ")}`] : []),
    "---",
    "",
    SECTION_SYSTEM,
    "",
    args.systemPrompt,
    "",
    SECTION_USER,
    "",
    args.userContent,
    "",
    args.error != null ? SECTION_ERROR : SECTION_OUTPUT,
    "",
    args.error ?? args.output ?? "(none)",
    "",
  ].join("\n");
  await Bun.write(file, body);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface WatchInvocation {
  watch: string;
  /** ISO stamp of the call. */
  at: string;
  /** Log dir date, `YYYY-MM-DD`. */
  date: string;
  model: string;
  autonomy: string;
  outcome: string;
  durationMs: number | null;
  /** Why the delta gate opened. */
  reasons: string[];
  systemPrompt: string;
  userContent: string;
  /** null when the call itself failed — see `error`. */
  output: string | null;
  error: string | null;
  path: string;
}

/**
 * Parse one log file. Returns null when the section headers are missing —
 * the caller decides whether that's a warning or a silent skip.
 *
 * Section boundaries are found by exact header match, and the trailing
 * output/error header by LAST occurrence: a digest routinely contains its own
 * `##` headings, so naive splitting on `/^## /m` would cut in the wrong place.
 */
export function parseInvocationLog(content: string, meta: { path: string; date: string }): WatchInvocation | null {
  const { attributes, body } = parseFrontmatter(content);

  const sysIdx = body.indexOf(SECTION_SYSTEM);
  const userIdx = body.indexOf(SECTION_USER, sysIdx + 1);
  if (sysIdx < 0 || userIdx < 0) return null;

  const outIdx = body.lastIndexOf(SECTION_OUTPUT);
  const errIdx = body.lastIndexOf(SECTION_ERROR);
  const tailIdx = Math.max(outIdx, errIdx);
  if (tailIdx <= userIdx) return null;
  const tailIsError = errIdx > outIdx;

  const systemPrompt = body.slice(sysIdx + SECTION_SYSTEM.length, userIdx).trim();
  const userContent = body.slice(userIdx + SECTION_USER.length, tailIdx).trim();
  const tail = body
    .slice(tailIdx + (tailIsError ? SECTION_ERROR.length : SECTION_OUTPUT.length))
    .trim();

  const durationRaw = Number(attributes.durationMs);

  return {
    watch: attributes.watch ?? "",
    at: attributes.at ?? "",
    date: meta.date,
    model: attributes.model ?? "",
    autonomy: attributes.autonomy ?? "",
    outcome: attributes.outcome ?? "",
    durationMs: Number.isFinite(durationRaw) && attributes.durationMs ? durationRaw : null,
    reasons: attributes.reasons ? attributes.reasons.split("|").map((r) => r.trim()).filter(Boolean) : [],
    systemPrompt,
    userContent,
    output: tailIsError ? null : tail,
    error: tailIsError ? tail : null,
    path: meta.path,
  };
}

export interface InvocationQuery {
  /** Only this watch (qualified name). Omit for the whole fleet. */
  watch?: string;
  /** Newest-first cap. Default 10. */
  limit?: number;
  /** How many dated log dirs back to scan. Default 30. */
  days?: number;
}

export interface InvocationRead {
  invocations: WatchInvocation[];
  warnings: string[];
}

async function logDates(paths: HivePaths, days: number): Promise<string[]> {
  const root = join(paths.watchesDir, "log");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, days);
}

/** Filenames in a log dir, newest first (the compact stamp sorts chronologically). */
async function logFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".md")).sort().reverse();
}

/** Recent invocations, newest first. Reads only as many files as `limit` needs. */
export async function readInvocations(paths: HivePaths, query: InvocationQuery = {}): Promise<InvocationRead> {
  const limit = query.limit ?? 10;
  const invocations: WatchInvocation[] = [];
  const warnings: string[] = [];
  const wanted = query.watch ? `${filePrefix(query.watch)}-` : null;

  for (const date of await logDates(paths, query.days ?? 30)) {
    const dir = invocationLogDir(paths, date);
    for (const name of await logFiles(dir)) {
      if (wanted && !name.startsWith(wanted)) continue;
      const path = join(dir, name);
      const content = await Bun.file(path).text().catch(() => null);
      if (content == null) {
        warnings.push(`${path}: unreadable invocation log`);
        continue;
      }
      const parsed = parseInvocationLog(content, { path, date });
      if (!parsed) {
        warnings.push(`${path}: unparseable invocation log — section headers missing`);
        continue;
      }
      invocations.push(parsed);
      if (invocations.length >= limit) return { invocations, warnings };
    }
  }

  return { invocations, warnings };
}

/**
 * The most recent invocation for each named watch. Walks dates newest-first
 * and stops once every name is answered, so a fleet page reads roughly one
 * file per watch rather than the whole log.
 */
export async function latestInvocations(
  paths: HivePaths,
  names: string[],
  opts: { days?: number } = {},
): Promise<{ byWatch: Map<string, WatchInvocation>; warnings: string[] }> {
  const byWatch = new Map<string, WatchInvocation>();
  const warnings: string[] = [];
  const pending = new Map(names.map((n) => [`${filePrefix(n)}-`, n]));
  if (pending.size === 0) return { byWatch, warnings };

  for (const date of await logDates(paths, opts.days ?? 30)) {
    const dir = invocationLogDir(paths, date);
    for (const name of await logFiles(dir)) {
      const hit = [...pending.entries()].find(([prefix]) => name.startsWith(prefix));
      if (!hit) continue;
      const path = join(dir, name);
      const content = await Bun.file(path).text().catch(() => null);
      if (content == null) {
        warnings.push(`${path}: unreadable invocation log`);
        continue;
      }
      const parsed = parseInvocationLog(content, { path, date });
      if (!parsed) {
        warnings.push(`${path}: unparseable invocation log — section headers missing`);
        continue;
      }
      byWatch.set(hit[1], parsed);
      pending.delete(hit[0]);
      if (pending.size === 0) return { byWatch, warnings };
    }
  }

  return { byWatch, warnings };
}
