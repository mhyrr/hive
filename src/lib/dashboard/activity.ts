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
};

/** How far back "recent work" reaches. Two days so a Monday morning is not blank. */
export const ACTIVITY_WINDOW_DAYS = 2;

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

  const out: ProjectActivity[] = [];
  for (const p of projects) {
    const g: GitSignal = gitSignal(p.path, sinceIso);
    if (!g.available || g.commits === 0) continue;
    out.push({
      projectId: p.id,
      commits: g.commits,
      insertions: g.insertions,
      deletions: g.deletions,
      filesChanged: g.filesChanged,
      subjects: g.subjects,
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
