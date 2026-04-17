/**
 * Dashboard builder entry point.
 *
 * `buildDashboard` collects data via the pure collectors, renders it
 * to a single HTML file, and writes it to `~/.hive/dashboard/index.html`
 * (or any override path).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type HivePaths } from "../paths";
import { collectDashboardData, type DashboardData } from "./collect";
import { renderDashboard } from "./render";
import { archivePathForDate, todayDateString } from "./archive";

export { collectDashboardData } from "./collect";
export { renderDashboard } from "./render";
export type { DashboardData } from "./collect";

export function dashboardPath(paths: HivePaths): string {
  return join(paths.home, "dashboard", "index.html");
}

export type BuildResult = {
  output: string;    // absolute path written
  archive: string;   // absolute path of daily snapshot
  html: string;      // rendered HTML
  data: DashboardData;
};

export async function buildDashboard(
  paths: HivePaths,
  outputPath: string = dashboardPath(paths),
): Promise<BuildResult> {
  const data = await collectDashboardData(paths);
  // Static / frozen output: no action buttons, no client JS that would
  // 404 against a server that isn't running.
  const html = renderDashboard(data, { interactive: false });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");

  // Archive snapshot for the day. Overwrites same-day rebuilds — last
  // write wins. The morning job runs once after the briefing so that's
  // the canonical snapshot.
  const archivePath = archivePathForDate(paths, todayDateString());
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, html, "utf-8");

  return { output: outputPath, archive: archivePath, html, data };
}
