import { stat } from "node:fs/promises";

import { UsageError } from "../lib/errors";
import {
  ensureHiveScaffold,
  ensureProjectScaffold,
  resolveRepoPath,
  setActiveProject,
} from "../lib/paths";
import { normalizeProjectName } from "../lib/project";

async function addProjectCommand(args: string[]): Promise<string> {
  const [projectName, repoInput] = args;

  if (!projectName || !repoInput) {
    throw new UsageError("Usage: hive project add <project> <path>");
  }

  const repoPath = resolveRepoPath(repoInput);

  try {
    const info = await stat(repoPath);

    if (!info.isDirectory()) {
      throw new Error("Not a directory");
    }
  } catch {
    throw new UsageError(`Repo path does not exist or is not a directory: ${repoPath}`);
  }

  const paths = await ensureHiveScaffold();
  const projectId = normalizeProjectName(projectName);
  const projectPaths = await ensureProjectScaffold(paths, {
    projectId,
    projectName,
    repoPath,
  });

  await setActiveProject(paths, projectId);

  return `Registered project ${projectId}
Hive home: ${paths.home}
Project dir: ${projectPaths.root}
Repo path: ${repoPath}`;
}

export async function projectCommand(args: string[]): Promise<string> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "add":
      return addProjectCommand(rest);
    default:
      throw new UsageError("Usage: hive project add <project> <path>");
  }
}
