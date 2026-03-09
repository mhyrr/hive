import { join } from "node:path";

import { UsageError } from "../lib/errors";
import {
  ensureDirectory,
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { extractRepoPath } from "../lib/project";

export async function syncCommand(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const projectConfig = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError(`Project config is missing a repo path: ${projectPaths.config}`);
  }

  const destinationDir = join(repoPath, ".hive");
  const destinationPath = join(destinationDir, "PLAN.md");
  const plan = await Bun.file(projectPaths.plan).text();

  await ensureDirectory(destinationDir);
  await Bun.write(destinationPath, `${plan.trim()}\n`);

  return `Synced PLAN.md to ${destinationPath}`;
}
