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

import {
  collectDashboardData,
  collectTicketsPage,
  type DashboardData,
} from "./collect";
import {
  renderProjects,
  renderTickets,
  renderTicketsPage,
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
  "tickets-page",
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
  // tickets-page collects independently — its data shape is richer and the
  // /tickets route doesn't need the rest of the dashboard payload.
  if (name === "tickets-page") {
    const data = await collectTicketsPage(paths);
    return renderTicketsPage(data, { interactive: true });
  }
  const data = await collectDashboardData(paths);
  return renderFragmentFromData(data, name);
}

export function renderFragmentFromData(data: DashboardData, name: FragmentName): string {
  const c = { interactive: true };
  switch (name) {
    case "projects": return renderProjects(data, c);
    case "tickets":  return renderTickets(data.tickets, c);
    case "tickets-page":
      // Should be handled by renderFragment(); fragments-from-data doesn't
      // have access to the tickets-page data. Throw so the bug surfaces.
      throw new Error("tickets-page fragment must be rendered via renderFragment, not from DashboardData");
    case "inboxes":  return renderInboxes(data.inboxes, c);
    case "runs":     return renderRuns(data.runs, c);
    case "archive":  return renderArchive(data, c);
    case "top-three": return renderTopThree(data);
    case "briefing": return renderBriefings(data);
  }
}
