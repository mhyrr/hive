import { UsageError } from "../lib/errors";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { toLogHeading } from "../lib/time";

export async function logCommand(args: string[]): Promise<string> {
  const message = args.join(" ").trim();

  if (!message) {
    throw new UsageError("Usage: hive log <message>");
  }

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const existing = await Bun.file(projectPaths.log).text();
  const nextContent = `${existing.trimEnd()}\n\n${toLogHeading("human")}\n${message}\n`;

  await Bun.write(projectPaths.log, nextContent);

  return `Appended log entry for ${activeProject}`;
}
