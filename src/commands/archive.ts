import { join } from "node:path";

import { UsageError } from "../lib/errors";
import {
  ensureDirectory,
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { renderLogTemplate } from "../lib/templates";
import { toCompactTimestamp, toDateLabel, toDateParts, toIsoTimestamp } from "../lib/time";

export async function archiveCommand(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const { year, month } = toDateParts();
  const archiveDir = join(paths.archiveDir, year, month);
  const archivePath = join(
    archiveDir,
    `${toCompactTimestamp()}-${activeProject}.md`,
  );
  const projectConfig = await Bun.file(projectPaths.config).text();
  const plan = await Bun.file(projectPaths.plan).text();
  const board = await Bun.file(projectPaths.board).text();
  const log = await Bun.file(projectPaths.log).text();
  const snapshot = `# Archive: ${activeProject}

archived: ${toIsoTimestamp()}

## Project Config
${projectConfig.trim()}

## PLAN.md
${plan.trim()}

## BOARD.md
${board.trim()}

## LOG.md
${log.trim()}`;

  await ensureDirectory(archiveDir);
  await Bun.write(archivePath, `${snapshot.trim()}\n`);
  await Bun.write(projectPaths.log, `${renderLogTemplate(activeProject, toDateLabel())}\n`);

  return `Archived session to ${archivePath}`;
}
