/**
 * What actually got worked on.
 *
 * The yard's verdicts answer "what needs me." This answers the question the
 * reader asks first: where did work happen, and what came out of it. It
 * reads the same git scan the nightly condition report uses rather than
 * parsing `git log` a second time.
 *
 * Commits are the honest signal here. Ticket counts are cumulative rather
 * than windowed, so they cannot say what happened yesterday; a commit
 * subject can.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { gitSignal, type GitSignal } from "../condition";
import type { ProjectCard } from "./collect";

export type ProjectActivity = {
  projectId: string;
  commits: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  /** Commit subjects, newest first, as written. */
  subjects: string[];
  /** Commits over the longer window — sustained work, not just yesterday's. */
  monthCommits: number;
};

/** How far back "recent work" reaches. Two days so a Monday morning is not blank. */
export const ACTIVITY_WINDOW_DAYS = 2;
/** The longer horizon, for telling a burst apart from a run of real work. */
export const MONTH_WINDOW_DAYS = 30;

/** Commit count only — `rev-list --count` is one cheap call, no log parsing. */
function commitCount(repoPath: string | null, sinceIso: string): number {
  if (!repoPath || !existsSync(join(repoPath, ".git"))) return 0;
  const res = spawnSync(
    "git",
    ["-C", repoPath, "rev-list", "--count", `--since=${sinceIso}`, "HEAD"],
    { encoding: "utf-8" },
  );
  if (res.status !== 0) return 0;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Scan every project's repo for work inside the window.
 *
 * `today` anchors the window to the date under test, not the wall clock, so
 * a rebuilt archive snapshot reports the same thing it did on the day.
 */
export function collectActivity(
  projects: ProjectCard[],
  today: string,
  windowDays: number = ACTIVITY_WINDOW_DAYS,
): ProjectActivity[] {
  const end = Date.parse(`${today}T23:59:59.999Z`);
  const sinceIso = new Date(end - windowDays * 86_400_000).toISOString();
  const monthIso = new Date(end - MONTH_WINDOW_DAYS * 86_400_000).toISOString();

  const out: ProjectActivity[] = [];
  for (const p of projects) {
    const monthCommits = commitCount(p.path, monthIso);
    const g: GitSignal = gitSignal(p.path, sinceIso);
    // A repo with a quiet week but a busy month still counts as live, so it
    // earns a row even when the short window is empty.
    if (!g.available && monthCommits === 0) continue;
    if (g.commits === 0 && monthCommits === 0) continue;
    out.push({
      projectId: p.id,
      commits: g.commits,
      insertions: g.insertions,
      deletions: g.deletions,
      filesChanged: g.filesChanged,
      subjects: g.subjects,
      monthCommits,
    });
  }

  // Busiest first — churn breaks ties so a single sweeping commit outranks
  // three one-liners.
  return out.sort(
    (a, b) =>
      b.commits - a.commits ||
      b.insertions + b.deletions - (a.insertions + a.deletions) ||
      a.projectId.localeCompare(b.projectId),
  );
}
