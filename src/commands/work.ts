import { UsageError } from "../lib/errors";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
  listProjects,
  projectExists,
  setActiveProject,
} from "../lib/paths";
import { extractRepoPath, normalizeProjectName } from "../lib/project";

export async function workCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();

  if (args.length === 0) {
    const activeProject = await getActiveProject(paths);

    if (!activeProject) {
      const projects = await listProjects(paths);
      const projectLine = projects.length > 0 ? projects.join(", ") : "(none)";

      return `No active project\nRegistered projects: ${projectLine}`;
    }

    const projectPaths = getProjectPaths(paths, activeProject);
    const configText = await Bun.file(projectPaths.config).text();
    const repoPath = extractRepoPath(configText) ?? "(unknown)";

    return `Active project: ${activeProject}\nRepo path: ${repoPath}`;
  }

  const projectId = normalizeProjectName(args[0]);

  if (!(await projectExists(paths, projectId))) {
    throw new UsageError(`Unknown project: ${projectId}`);
  }

  await setActiveProject(paths, projectId);

  const projectPaths = getProjectPaths(paths, projectId);
  const configText = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(configText) ?? "(unknown)";

  return `Active project set to ${projectId}\nRepo path: ${repoPath}`;
}
