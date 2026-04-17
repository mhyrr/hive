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

export { collectDashboardData } from "./collect";
export { renderDashboard } from "./render";
export type { DashboardData } from "./collect";

export function dashboardPath(paths: HivePaths): string {
  return join(paths.home, "dashboard", "index.html");
}

export type BuildResult = {
  output: string;    // absolute path written
  html: string;      // rendered HTML
  data: DashboardData;
};

export async function buildDashboard(
  paths: HivePaths,
  outputPath: string = dashboardPath(paths),
): Promise<BuildResult> {
  const data = await collectDashboardData(paths);
  const html = renderDashboard(data);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf-8");

  return { output: outputPath, html, data };
}
