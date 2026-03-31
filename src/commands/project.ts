import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

import { UsageError } from "../lib/errors";
import { ensureDirectory, ensureHiveScaffold } from "../lib/paths";
import { normalizeProjectName } from "../lib/project";
import { ensureProjectMemoryFile } from "../lib/memory";

export async function projectCommand(args: string[]): Promise<void> {
  const usage = "Usage: hive project add <name> <path>";

  if (args[0] !== "add" || args.length < 3) {
    throw new UsageError(usage);
  }

  const rawName = args[1]!;
  const rawPath = args[2]!;
  const projectId = normalizeProjectName(rawName);
  const repoPath = resolve(rawPath);

  if (!existsSync(repoPath)) {
    throw new UsageError(`Path does not exist: ${repoPath}`);
  }

  const paths = await ensureHiveScaffold();

  // Create project directory and config
  const projectDir = join(paths.projectsDir, projectId);
  await ensureDirectory(projectDir);
  await Bun.write(
    join(projectDir, "config.md"),
    `---\nname: ${projectId}\npath: ${repoPath}\n---\n`,
  );

  // Create memory file
  await ensureProjectMemoryFile(paths, projectId);

  console.log(`Project '${projectId}' registered at ${repoPath}`);
  console.log(`Memory: ~/.hive/memory/projects/${projectId}.md`);
  console.log();
  console.log(`Use \`hive\` from ${repoPath} to start a Maya session with project context.`);
}
