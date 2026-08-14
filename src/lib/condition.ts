// Pass A — Conditioning. Builds the structured signal report that feeds the
// rest of the V1 nightly pipeline.
//
// Output shape is committed; downstream passes (B, C, V) read from it.
//
// docs/specs/2026-04-26-memory-design.md §Pass A — Conditioning

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { HivePaths } from "./paths";
import { listProjects } from "./paths";
import { parseFrontmatter } from "./frontmatter";
import { readProjectMemorySnapshot } from "./memory";
import { listTickets } from "./ticket";
import {
  extractAllRecentExchanges,
  rankExchanges,
  estimateTokens,
  type ExtractedExchange,
} from "./sessions";
import { spawnSync } from "node:child_process";

export interface RankedExchangePreview {
  role: "user" | "assistant";
  preview: string;
  score: number;
  tokenCount: number;
  novelty: number;
  alwaysInclude: boolean;
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

export interface HeartbeatSignal {
  inboxBytes: number;
  findings: number;
}

export interface ProjectSignal {
  projectName: string;
  projectPath: string | null;
  sessions: SessionSignal;
  git: GitSignal;
  tickets: { moved: TicketMovement[] };
  heartbeat: HeartbeatSignal;
}

export interface ConditionReport {
  date: string;
  generatedAt: string;
  hoursWindow: number;
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

const PREVIEW_CHARS = 200;
const DEFAULT_TOP_K = 30;

function previewText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= PREVIEW_CHARS) return cleaned;
  return cleaned.slice(0, PREVIEW_CHARS) + "…";
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

export function gitSignal(repoPath: string | null, sinceIso: string): GitSignal {
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
    ["-C", repoPath, "log", `--since=${sinceIso}`, "--pretty=%s"],
    { encoding: "utf-8" },
  );
  if (subjectsRes.status !== 0) return empty;
  const subjects = subjectsRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  const numstatRes = spawnSync(
    "git",
    ["-C", repoPath, "log", `--since=${sinceIso}`, "--numstat", "--pretty=format:"],
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
): Promise<TicketMovement[]> {
  const tickets = await listTickets(paths, projectId).catch(() => []);
  const moved: TicketMovement[] = [];
  for (const t of tickets) {
    const updatedMs = Date.parse(t.updated);
    if (Number.isFinite(updatedMs) && updatedMs >= sinceMs) {
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

function heartbeatSignal(paths: HivePaths, projectId: string): HeartbeatSignal {
  const inboxPath = join(paths.projectsDir, projectId, "inbox.md");
  if (!existsSync(inboxPath)) return { inboxBytes: 0, findings: 0 };
  let inboxBytes = 0;
  try {
    inboxBytes = statSync(inboxPath).size;
  } catch {
    // intentional: stat failure on inbox file — treat as empty
    return { inboxBytes: 0, findings: 0 };
  }
  if (inboxBytes === 0) return { inboxBytes: 0, findings: 0 };
  const content = readFileSync(inboxPath, "utf-8");
  const findings = content
    .split("\n")
    .filter((l) => l.match(/^\s*[-*]\s+\S/))
    .length;
  return { inboxBytes, findings };
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

function rankedToPreview(
  exchanges: ExtractedExchange[],
  knowledge: string[],
  topK: number,
): { topRanked: RankedExchangePreview[]; tokenEstimate: number } {
  let tokenEstimate = 0;
  for (const ex of exchanges) tokenEstimate += estimateTokens(ex.text);

  const ranked = rankExchanges(exchanges, knowledge);
  const topRanked = ranked.slice(0, topK).map((r) => ({
    role: r.exchange.role,
    preview: previewText(r.exchange.text),
    score: Number(r.score.toFixed(3)),
    tokenCount: r.tokenCount,
    novelty: Number(r.novelty.toFixed(4)),
    alwaysInclude: r.alwaysInclude,
  }));
  return { topRanked, tokenEstimate };
}

export interface BuildConditionOptions {
  hoursWindow?: number;
  topK?: number;
  now?: Date; // testing seam — overrides everything
  /**
   * Target date in YYYY-MM-DD. When set, anchors `now` to end-of-day UTC for
   * that date so the 24h window covers the named day and report.date matches.
   * Used by `hive memory nightly --date X` for retroactive runs.
   */
  date?: string;
}

export async function buildConditionReport(
  paths: HivePaths,
  options: BuildConditionOptions = {},
): Promise<ConditionReport> {
  const hoursWindow = options.hoursWindow ?? 24;
  // `now` precedence: explicit Date > derived from `date` > wall clock.
  const now = options.now
    ?? (options.date ? new Date(`${options.date}T23:59:59.999Z`) : new Date());
  const sinceMs = now.getTime() - hoursWindow * 3600 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const date = options.date ?? now.toISOString().slice(0, 10);
  const topK = options.topK ?? DEFAULT_TOP_K;

  const allExchanges = await extractAllRecentExchanges(hoursWindow, now);
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
    const { topRanked, tokenEstimate } = rankedToPreview(exchanges, knowledge, topK);

    const sessions: SessionSignal = {
      sessionCount: exchangeBundle?.sessionCount ?? 0,
      exchangeCount: exchanges.length,
      tokenEstimate,
      topRanked,
    };

    const git = gitSignal(projectPath, sinceIso);
    const moved = await ticketMovement(paths, projectId, sinceMs);
    const heartbeat = heartbeatSignal(paths, projectId);

    projects.push({
      projectName: projectId,
      projectPath,
      sessions,
      git,
      tickets: { moved },
      heartbeat,
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
  // Heartbeat findings alone don't disqualify trivial; they're often automated noise.
  const trivial =
    totals.commitCount === 0 &&
    totals.exchangeCount === 0 &&
    totals.ticketsMoved === 0;
  const trivialReason = trivial
    ? "no commits, no session exchanges, no ticket movement in window"
    : null;

  return {
    date,
    generatedAt: now.toISOString(),
    hoursWindow,
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
