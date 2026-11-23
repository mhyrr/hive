// Canon size against Pass V's prompt budget (TK-158).
//
// Pass V reads each project's whole canon in one Verify call. Search stays fine
// as memory grows (it is ranked top_k); the Verify call does not. It fails at
// the budget `assertPromptFits` enforces, and before TK-137 it failed silently.
// This module measures how close each project is, records one row per night,
// and turns the numbers into briefing lines at 60% (warn) and 80% (act).
//
// What is measured: the Verify prompt for the project with its canon and the
// taste principles, but no candidates and no Pass A signal. That is the floor
// every Verify call for the project pays, and it is the part that only grows.
// The night's candidates and signal ride on top and vary day to day. Tokens use
// the same estimate `assertPromptFits` uses, so 100% here is the line where
// that guard throws.
//
// Measurement only. The remedy (split the shard by section or tag, or compact
// old entries) is a design call; the warning text proposes it and stops.

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { knowledgePath } from "./memory";
import type { HivePaths } from "./paths";
import { listProjects } from "./paths";
import {
  VERIFY_BUDGET_TOKENS,
  VERIFY_WINDOW_TOKENS,
  buildProjectVerifierSystemPrompt,
  buildProjectVerifierUserContent,
  estimatePromptTokens,
  serializeProjectCanon,
} from "./verify";

/** Fraction of the budget at which the briefing warns. */
export const CANON_WARN_AT = 0.6;
/** Fraction of the budget at which the briefing says to act. */
export const CANON_ACT_AT = 0.8;
/** How far back growth is measured. */
export const CANON_GROWTH_DAYS = 7;

export type CanonSizeLevel = "ok" | "warn" | "act";

export interface CanonSizeMeasurement {
  projectId: string;
  /** Bytes of knowledge.md on disk, superseded entries included. */
  knowledgeBytes: number;
  /** Characters of the canon-only Verify prompt (system + user content). */
  promptChars: number;
  /** estimatePromptTokens of that prompt — the assertPromptFits estimate. */
  promptTokens: number;
  /** promptTokens / budgetTokens. 1.0 is where assertPromptFits throws. */
  pctOfBudget: number;
  level: CanonSizeLevel;
}

export interface CanonSizeRecord {
  version: 1;
  date: string;
  measuredAt: string;
  windowTokens: number;
  budgetTokens: number;
  projects: CanonSizeMeasurement[];
}

export interface CanonGrowth {
  /** Days between the baseline record and this one. */
  days: number;
  tokens: number;
  bytes: number;
}

export function canonSizeLevel(pctOfBudget: number): CanonSizeLevel {
  if (pctOfBudget >= CANON_ACT_AT) return "act";
  if (pctOfBudget >= CANON_WARN_AT) return "warn";
  return "ok";
}

export function canonSizePath(paths: HivePaths, date: string): string {
  return join(paths.memoryRunsDir, date, "canon-size.json");
}

function readPrinciples(paths: HivePaths): string {
  const p = join(paths.home, "taste", "principles.md");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/** Measure one project. Null when it has no knowledge.md — nothing to verify
 * against, and measuring must not create the file. */
export async function measureProjectCanon(
  paths: HivePaths,
  projectId: string,
  principlesText: string,
  date: string,
  budgetTokens: number = VERIFY_BUDGET_TOKENS,
): Promise<CanonSizeMeasurement | null> {
  const kPath = knowledgePath(paths, projectId);
  if (!existsSync(kPath)) return null;
  const knowledgeBytes = statSync(kPath).size;
  const canon = await serializeProjectCanon(paths, projectId);
  const system = buildProjectVerifierSystemPrompt();
  const user = buildProjectVerifierUserContent(date, principlesText, {
    projectId,
    canon,
    midSessionCandidates: [],
    inboxText: "",
    bCandidates: [],
  });
  const promptTokens = estimatePromptTokens(system, user);
  const pctOfBudget = promptTokens / budgetTokens;
  return {
    projectId,
    knowledgeBytes,
    promptChars: system.length + user.length,
    promptTokens,
    pctOfBudget,
    level: canonSizeLevel(pctOfBudget),
  };
}

/** Measure every project the verifier would consider, largest prompt first.
 * Read-only: touches nothing on disk. */
export async function measureAllCanons(
  paths: HivePaths,
  date: string,
  measuredAt: string = new Date().toISOString(),
): Promise<CanonSizeRecord> {
  const principles = readPrinciples(paths);
  const projects: CanonSizeMeasurement[] = [];
  for (const id of await listProjects(paths.projectsDir)) {
    const m = await measureProjectCanon(paths, id, principles, date);
    if (m) projects.push(m);
  }
  projects.sort((a, b) => b.promptTokens - a.promptTokens);
  return {
    version: 1,
    date,
    measuredAt,
    windowTokens: VERIFY_WINDOW_TOKENS,
    budgetTokens: VERIFY_BUDGET_TOKENS,
    projects,
  };
}

export async function writeCanonSizeRecord(paths: HivePaths, record: CanonSizeRecord): Promise<string> {
  const p = canonSizePath(paths, record.date);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(record, null, 2) + "\n");
  return p;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Records from the `days` nights before `date`, oldest first. Nights without a
 * record (stub nights, failed V) are skipped; a malformed record is skipped. */
export async function readCanonSizeHistory(
  paths: HivePaths,
  date: string,
  days: number = CANON_GROWTH_DAYS,
): Promise<CanonSizeRecord[]> {
  const out: CanonSizeRecord[] = [];
  for (let back = days; back >= 1; back--) {
    const raw = await readFile(canonSizePath(paths, shiftDate(date, -back)), "utf-8").catch(() => null);
    if (raw === null) continue;
    try {
      const rec = JSON.parse(raw) as CanonSizeRecord;
      if (rec?.version === 1 && Array.isArray(rec.projects)) out.push(rec);
    } catch {
      // intentional: a malformed record only costs that night's baseline
    }
  }
  return out;
}

/** Growth per project against the oldest record in `history` that has it.
 * A project with no earlier record has no growth entry. */
export function computeCanonGrowth(
  current: CanonSizeRecord,
  history: CanonSizeRecord[],
): Map<string, CanonGrowth> {
  const out = new Map<string, CanonGrowth>();
  for (const m of current.projects) {
    for (const rec of history) {
      const base = rec.projects.find((p) => p.projectId === m.projectId);
      if (!base) continue;
      out.set(m.projectId, {
        days: daysBetween(rec.date, current.date),
        tokens: m.promptTokens - base.promptTokens,
        bytes: m.knowledgeBytes - base.knowledgeBytes,
      });
      break;
    }
  }
  return out;
}

const k = (n: number) => `${Math.round(n / 1000)}k`;
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const pct = (f: number) => `${Math.round(f * 100)}%`;
const signed = (n: number, fmt: (n: number) => string) => (n < 0 ? `−${fmt(-n)}` : `+${fmt(n)}`);

export function formatCanonGrowth(g: CanonGrowth | undefined): string {
  if (!g) return "no earlier record to measure growth";
  return `${signed(g.tokens, k)} tokens (${signed(g.bytes, kb)}) over ${g.days} day${g.days === 1 ? "" : "s"}`;
}

/** One briefing line per project at or over the warn line, worst first.
 * Empty when every project is below 60%. */
export function canonSizeWarnings(
  current: CanonSizeRecord,
  growth: Map<string, CanonGrowth>,
): string[] {
  const lines: string[] = [];
  for (const m of current.projects) {
    if (m.level === "ok") continue;
    const head =
      `**${m.projectId}** — Verify prompt ~${k(m.promptTokens)} tokens, ` +
      `${pct(m.pctOfBudget)} of the ${k(current.budgetTokens)} budget; ` +
      `${formatCanonGrowth(growth.get(m.projectId))}.`;
    const tail =
      m.level === "act"
        ? ` **Act:** past ${pct(CANON_ACT_AT)}. Split the Verify shard by section or tag, or compact and supersede old entries, before it reaches 100% and Pass V stops.`
        : ` **Warn:** past ${pct(CANON_WARN_AT)}. At ${pct(CANON_ACT_AT)} it needs a split by section or tag, or a compaction of old entries.`;
    lines.push(`- ${head}${tail}`);
  }
  return lines;
}

const SECTION_HEADING = "## Canon size";
const SECTION_RE = /\n*## Canon size\n[\s\S]*?(?=\n## |$)/;

/** Put the warnings into the briefing as its own section, replacing one from an
 * earlier apply of the same night. No lines removes the section. */
export function upsertCanonSizeSection(briefing: string, lines: string[]): string {
  const without = briefing.replace(SECTION_RE, "").trimEnd();
  if (lines.length === 0) return without + "\n";
  return `${without}\n\n${SECTION_HEADING}\n${lines.join("\n")}\n`;
}

/** The nightly step: measure, record, and warn in the run's briefing.md.
 * Returns the record and the lines it wrote. */
export async function recordCanonSize(
  paths: HivePaths,
  date: string,
): Promise<{ record: CanonSizeRecord; warnings: string[]; recordPath: string }> {
  const record = await measureAllCanons(paths, date);
  const recordPath = await writeCanonSizeRecord(paths, record);
  const growth = computeCanonGrowth(record, await readCanonSizeHistory(paths, date));
  const warnings = canonSizeWarnings(record, growth);
  const briefingPath = join(paths.memoryRunsDir, date, "briefing.md");
  if (existsSync(briefingPath)) {
    const before = await readFile(briefingPath, "utf-8");
    const after = upsertCanonSizeSection(before, warnings);
    if (after !== before) await writeFile(briefingPath, after);
  }
  return { record, warnings, recordPath };
}
