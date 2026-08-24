// Pass A — Conditioning. Builds the structured signal report that feeds the
// rest of the V1 nightly pipeline.
//
// Output shape is committed; downstream passes (B, C, V) read from it.
//
// docs/specs/2026-04-26-memory-design.md §Pass A — Conditioning

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { HivePaths } from "./paths";
import { listProjects } from "./paths";
import { parseFrontmatter } from "./frontmatter";
import { readProjectMemorySnapshot } from "./memory";
import { parseInbox } from "./inbox";
import { listTickets } from "./ticket";
import {
  extractAllExchangesInWindow,
  rankExchanges,
  estimateTokens,
  type ExtractedExchange,
  type ExchangeWindow,
} from "./sessions";
import { spawnSync } from "node:child_process";

export interface RankedExchangePreview {
  role: "user" | "assistant";
  /** Legacy field name. Contains a bounded head+tail excerpt, not a prefix. */
  preview: string;
  timestamp: string;
  source: "claude" | "codex";
  sessionId: string;
  signalRank: number;
  score: number;
  tokenCount: number;
  excerptTokenCount: number;
  novelty: number;
  alwaysInclude: boolean;
  truncated: boolean;
}

export interface SessionSignal {
  sessionCount: number;
  exchangeCount: number;
  tokenEstimate: number;
  topRanked: RankedExchangePreview[];
}

export interface GitSignal {
  available: boolean;
  commits: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  subjects: string[];
}

export interface TicketMovement {
  id: string;
  title: string;
  status: string;
  updated: string;
}

export interface InboxSignal {
  /** UTF-8 bytes of semantic findings, excluding headers and machine markers. */
  inboxBytes: number;
  findings: number;
}

export interface ProjectSignal {
  projectName: string;
  projectPath: string | null;
  sessions: SessionSignal;
  git: GitSignal;
  tickets: { moved: TicketMovement[] };
  inbox: InboxSignal;
}

export interface ConditionReport {
  date: string;
  generatedAt: string;
  hoursWindow: number;
  windowStart: string;
  windowEnd: string;
  windowMode: "rolling" | "calendar-day";
  trivial: boolean;
  trivialReason: string | null;
  projects: ProjectSignal[];
  totals: {
    projectCount: number;
    sessionCount: number;
    exchangeCount: number;
    commitCount: number;
    ticketsMoved: number;
  };
}

export const DEFAULT_EXCERPT_BUDGET_TOKENS = 16_000;
export const DEFAULT_MAX_EXCERPT_TOKENS = 1_200;
const EXCERPT_OMISSION = "\n\n… [middle omitted] …\n\n";

export interface ExchangeExcerpt {
  text: string;
  tokenCount: number;
  truncated: boolean;
}

function normalizeExcerptText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function trimHeadAtBoundary(text: string, maxChars: number): string {
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"));
  return boundary >= maxChars * 0.8 ? slice.slice(0, boundary) : slice;
}

function trimTailAtBoundary(text: string, maxChars: number): string {
  const slice = text.slice(-maxChars);
  const space = slice.indexOf(" ");
  const newline = slice.indexOf("\n");
  const candidates = [space, newline].filter((n) => n >= 0 && n <= maxChars * 0.2);
  const boundary = candidates.length > 0 ? Math.min(...candidates) : -1;
  return boundary >= 0 ? slice.slice(boundary + 1) : slice;
}

/** Keep both the setup and the conclusion of a long exchange. */
export function buildExchangeExcerpt(
  text: string,
  maxTokens = DEFAULT_MAX_EXCERPT_TOKENS,
): ExchangeExcerpt {
  const cleaned = normalizeExcerptText(text);
  const maxChars = Math.max(1, maxTokens) * 4;
  if (cleaned.length <= maxChars) {
    return { text: cleaned, tokenCount: estimateTokens(cleaned), truncated: false };
  }

  const contentBudget = Math.max(2, maxChars - EXCERPT_OMISSION.length);
  const headBudget = Math.ceil(contentBudget * 0.6);
  const tailBudget = contentBudget - headBudget;
  const excerpt =
    trimHeadAtBoundary(cleaned, headBudget).trimEnd() +
    EXCERPT_OMISSION +
    trimTailAtBoundary(cleaned, tailBudget).trimStart();
  return { text: excerpt, tokenCount: estimateTokens(excerpt), truncated: true };
}

function readProjectRepoPath(paths: HivePaths, projectId: string): string | null {
  const configPath = join(paths.projectsDir, projectId, "config.md");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseFrontmatter(raw);
    const p = parsed.attributes?.path as string | undefined;
    return p && existsSync(p) ? p : null;
  } catch {
    // intentional: missing or malformed project config — no path available
    return null;
  }
}

export function gitSignal(
  repoPath: string | null,
  sinceIso: string,
  untilIso?: string,
): GitSignal {
  const empty: GitSignal = {
    available: false,
    commits: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
    subjects: [],
  };
  if (!repoPath || !existsSync(join(repoPath, ".git"))) return empty;

  const subjectsRes = spawnSync(
    "git",
    [
      "-C",
      repoPath,
      "log",
      `--since=${sinceIso}`,
      ...(untilIso ? [`--until=${untilIso}`] : []),
      "--pretty=%s",
    ],
    { encoding: "utf-8" },
  );
  if (subjectsRes.status !== 0) return empty;
  const subjects = subjectsRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  const numstatRes = spawnSync(
    "git",
    [
      "-C",
      repoPath,
      "log",
      `--since=${sinceIso}`,
      ...(untilIso ? [`--until=${untilIso}`] : []),
      "--numstat",
      "--pretty=format:",
    ],
    { encoding: "utf-8" },
  );
  let insertions = 0;
  let deletions = 0;
  const filesTouched = new Set<string>();
  if (numstatRes.status === 0) {
    for (const line of numstatRes.stdout.split("\n")) {
      const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!m) continue;
      const [, ins, del, file] = m;
      if (ins !== "-") insertions += Number(ins);
      if (del !== "-") deletions += Number(del);
      if (file) filesTouched.add(file);
    }
  }

  return {
    available: true,
    commits: subjects.length,
    insertions,
    deletions,
    filesChanged: filesTouched.size,
    subjects,
  };
}

async function ticketMovement(
  paths: HivePaths,
  projectId: string,
  sinceMs: number,
  untilMs: number,
): Promise<TicketMovement[]> {
  const tickets = await listTickets(paths, projectId).catch(() => []);
  const moved: TicketMovement[] = [];
  for (const t of tickets) {
    const updatedMs = Date.parse(t.updated);
    if (Number.isFinite(updatedMs) && updatedMs >= sinceMs && updatedMs < untilMs) {
      moved.push({
        id: t.id,
        title: t.title,
        status: t.status,
        updated: t.updated,
      });
    }
  }
  return moved;
}

function inboxSignal(paths: HivePaths, projectId: string): InboxSignal {
  const inboxPath = join(paths.projectsDir, projectId, "inbox.md");
  if (!existsSync(inboxPath)) return { inboxBytes: 0, findings: 0 };
  let raw: string;
  try {
    raw = readFileSync(inboxPath, "utf-8");
  } catch {
    // intentional: unreadable inbox file — treat as empty
    return { inboxBytes: 0, findings: 0 };
  }
  const content = parseInbox(raw, projectId);
  const findings = content.body
    .split("\n")
    .filter((l) => l.match(/^\s*[-*]\s+\S/))
    .length;
  return { inboxBytes: content.byteLength, findings };
}

async function projectKnowledgeCorpus(
  paths: HivePaths,
  projectId: string,
): Promise<string[]> {
  try {
    const snap = await readProjectMemorySnapshot(paths, projectId);
    return [
      ...snap.facts.map((f) => f.text),
      ...snap.conventions.map((c) => c.text),
      ...snap.decisions.map((d) => d.text),
      ...snap.questions.map((q) => q.text),
    ];
  } catch {
    // intentional: knowledge.md missing or unreadable — return empty corpus
    return [];
  }
}

export interface SelectExchangeOptions {
  budgetTokens?: number;
  maxExcerptTokens?: number;
  maxExcerpts?: number;
}

export function selectExchangeExcerpts(
  exchanges: ExtractedExchange[],
  knowledge: string[],
  options: SelectExchangeOptions = {},
): { topRanked: RankedExchangePreview[]; tokenEstimate: number } {
  let tokenEstimate = 0;
  for (const ex of exchanges) tokenEstimate += estimateTokens(ex.text);

  const ranked = rankExchanges(exchanges, knowledge);
  const budgetTokens = options.budgetTokens ?? DEFAULT_EXCERPT_BUDGET_TOKENS;
  const maxExcerptTokens = options.maxExcerptTokens ?? DEFAULT_MAX_EXCERPT_TOKENS;
  const maxExcerpts = options.maxExcerpts ?? Number.POSITIVE_INFINITY;
  let remainingTokens = budgetTokens;
  const selected: RankedExchangePreview[] = [];

  ranked.forEach((r, signalRank) => {
    const excerpt = buildExchangeExcerpt(r.exchange.text, maxExcerptTokens);
    const overCount = selected.length >= maxExcerpts;
    const overBudget = excerpt.tokenCount > remainingTokens;
    if (!r.alwaysInclude && (overCount || overBudget)) return;

    selected.push({
      role: r.exchange.role,
      preview: excerpt.text,
      timestamp: r.exchange.timestamp,
      source: r.exchange.source,
      sessionId: r.exchange.sessionId,
      signalRank,
      score: Number(r.score.toFixed(3)),
      tokenCount: r.tokenCount,
      excerptTokenCount: excerpt.tokenCount,
      novelty: Number(r.novelty.toFixed(4)),
      alwaysInclude: r.alwaysInclude,
      truncated: excerpt.truncated,
    });
    remainingTokens = Math.max(0, remainingTokens - excerpt.tokenCount);
  });

  // Ranking chooses the material. Chronology tells Pass B which statements
  // were questions, which were corrections, and where the session landed.
  const topRanked = selected.sort((a, b) => {
    const byTime = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    return byTime !== 0 ? byTime : a.signalRank - b.signalRank;
  });
  return { topRanked, tokenEstimate };
}

export interface BuildConditionOptions {
  hoursWindow?: number;
  excerptBudgetTokens?: number;
  maxExcerptTokens?: number;
  topK?: number;
  now?: Date; // generation clock and rolling-window end; testing seam
  /**
   * Target date in YYYY-MM-DD. When set, scan that exact UTC calendar day.
   * Live nightly runs omit it and use a rolling window ending at `now`.
   */
  date?: string;
}

function conditionWindow(options: BuildConditionOptions): {
  date: string;
  generatedAt: Date;
  window: ExchangeWindow;
  mode: ConditionReport["windowMode"];
  hoursWindow: number;
} {
  const generatedAt = options.now ?? new Date();
  if (options.date) {
    const start = new Date(`${options.date}T00:00:00.000Z`);
    if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== options.date) {
      throw new Error(`Invalid condition date: ${options.date}`);
    }
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return {
      date: options.date,
      generatedAt,
      window: { start, end },
      mode: "calendar-day",
      hoursWindow: 24,
    };
  }

  const hoursWindow = options.hoursWindow ?? 24;
  return {
    date: generatedAt.toISOString().slice(0, 10),
    generatedAt,
    window: {
      start: new Date(generatedAt.getTime() - hoursWindow * 60 * 60 * 1000),
      end: generatedAt,
    },
    mode: "rolling",
    hoursWindow,
  };
}

export async function buildConditionReport(
  paths: HivePaths,
  options: BuildConditionOptions = {},
): Promise<ConditionReport> {
  const { date, generatedAt, window, mode, hoursWindow } = conditionWindow(options);
  const sinceMs = window.start.getTime();
  const untilMs = window.end.getTime();
  const sinceIso = window.start.toISOString();
  const untilIso = window.end.toISOString();

  const allExchanges = await extractAllExchangesInWindow(window);
  const exchangesByProject = new Map(
    allExchanges.map((p) => [p.projectName, p] as const),
  );

  const projectIds = await listProjects(paths.projectsDir);
  const projects: ProjectSignal[] = [];

  for (const projectId of projectIds) {
    const projectPath = readProjectRepoPath(paths, projectId);
    const exchangeBundle = exchangesByProject.get(projectId);

    const knowledge = await projectKnowledgeCorpus(paths, projectId);
    const exchanges = exchangeBundle?.exchanges ?? [];
    const excerptOptions: SelectExchangeOptions = {};
    if (options.excerptBudgetTokens !== undefined) {
      excerptOptions.budgetTokens = options.excerptBudgetTokens;
    }
    if (options.maxExcerptTokens !== undefined) {
      excerptOptions.maxExcerptTokens = options.maxExcerptTokens;
    }
    if (options.topK !== undefined) excerptOptions.maxExcerpts = options.topK;
    const { topRanked, tokenEstimate } = selectExchangeExcerpts(
      exchanges,
      knowledge,
      excerptOptions,
    );

    const sessions: SessionSignal = {
      sessionCount: exchangeBundle?.sessionCount ?? 0,
      exchangeCount: exchanges.length,
      tokenEstimate,
      topRanked,
    };

    const git = gitSignal(projectPath, sinceIso, untilIso);
    const moved = await ticketMovement(paths, projectId, sinceMs, untilMs);
    const inbox = inboxSignal(paths, projectId);

    projects.push({
      projectName: projectId,
      projectPath,
      sessions,
      git,
      tickets: { moved },
      inbox,
    });
  }

  const totals = {
    projectCount: projects.length,
    sessionCount: projects.reduce((a, p) => a + p.sessions.sessionCount, 0),
    exchangeCount: projects.reduce((a, p) => a + p.sessions.exchangeCount, 0),
    commitCount: projects.reduce((a, p) => a + p.git.commits, 0),
    ticketsMoved: projects.reduce((a, p) => a + p.tickets.moved.length, 0),
  };

  // Trivial-day detection — no commits, no sessions of substance, no tickets moved.
  // Inbox findings alone don't disqualify trivial; they're often automated noise.
  const trivial =
    totals.commitCount === 0 &&
    totals.exchangeCount === 0 &&
    totals.ticketsMoved === 0;
  const trivialReason = trivial
    ? "no commits, no session exchanges, no ticket movement in window"
    : null;

  return {
    date,
    generatedAt: generatedAt.toISOString(),
    hoursWindow,
    windowStart: sinceIso,
    windowEnd: untilIso,
    windowMode: mode,
    trivial,
    trivialReason,
    projects,
    totals,
  };
}

/**
 * Persist the condition report to ~/.hive/memory/runs/{DATE}/condition.json.
 * Returns the absolute path written.
 */
export async function writeConditionReport(
  paths: HivePaths,
  report: ConditionReport,
): Promise<string> {
  const dir = join(paths.memoryRunsDir, report.date);
  await Bun.write(join(dir, "condition.json"), JSON.stringify(report, null, 2));
  return join(dir, "condition.json");
}
