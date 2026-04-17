/**
 * Per-section fragment renderer.
 *
 * After an action POST succeeds, the client fetches
 * `/fragment/<name>` to swap just that section's HTML back into the
 * page. This module is a thin, pure adapter over render.ts — it
 * re-collects data and returns the section that changed.
 *
 * Names match the `section-*` DOM ids emitted by render.ts.
 */

import { collectDashboardData, type DashboardData } from "./collect";
import {
  renderProjects,
  renderTickets,
  renderInboxes,
  renderRuns,
  renderArchive,
  renderTopThree,
  renderBriefings,
} from "./render";
import type { HivePaths } from "../paths";

export const FRAGMENT_NAMES = [
  "projects",
  "tickets",
  "inboxes",
  "runs",
  "archive",
  "top-three",
  "briefing",
] as const;

export type FragmentName = (typeof FRAGMENT_NAMES)[number];

export function isValidFragmentName(name: string): name is FragmentName {
  return (FRAGMENT_NAMES as readonly string[]).includes(name);
}

/**
 * Render a single section from fresh data.
 *
 * The server re-collects the full dashboard data for each fragment
 * request. Collection is ~40ms on Greg's machine and the overhead of
 * partial-only collection isn't worth the complexity.
 */
export async function renderFragment(
  paths: HivePaths,
  name: FragmentName,
): Promise<string> {
  const data = await collectDashboardData(paths);
  return renderFragmentFromData(data, name);
}

export function renderFragmentFromData(data: DashboardData, name: FragmentName): string {
  const c = { interactive: true };
  switch (name) {
    case "projects": return renderProjects(data, c);
    case "tickets":  return renderTickets(data.tickets, c);
    case "inboxes":  return renderInboxes(data.inboxes, c);
    case "runs":     return renderRuns(data.runs, c);
    case "archive":  return renderArchive(data, c);
    case "top-three": return renderTopThree(data);
    case "briefing": return renderBriefings(data);
  }
}
