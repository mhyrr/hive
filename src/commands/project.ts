import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

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

  // Write HEARTBEAT.md from template if missing
  const heartbeatPath = join(projectDir, "HEARTBEAT.md");
  if (!existsSync(heartbeatPath)) {
    const templatePath = join(dirname(import.meta.dir), "..", "templates", "heartbeat", "HEARTBEAT.md");
    let content = await Bun.file(templatePath).text();
    content = content.replaceAll("{{projectName}}", projectId);
    await Bun.write(heartbeatPath, content);
  }

  const { getIdentityName } = await import("../lib/identity");
  const name = getIdentityName();
  console.log(`Project '${projectId}' registered at ${repoPath}`);
  console.log(`Memory: ~/.hive/memory/projects/${projectId}/knowledge.md`);
  console.log(`Heartbeat: ~/.hive/projects/${projectId}/HEARTBEAT.md`);
  console.log();
  console.log(`Use \`hive\` from ${repoPath} to start a ${name} session with project context.`);
}
