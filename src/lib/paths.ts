import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  baseTemplates,
  personaTemplates,
  skillTemplates,
  renderBoardTemplate,
  renderLogTemplate,
  renderPlanTemplate,
  renderProjectConfigTemplate,
  renderProjectMemoryTemplate,
} from "./templates";
import { toDateLabel } from "./time";

export type HivePaths = {
  home: string;
  soul: string;
  self: string;
  agents: string;
  config: string;
  feed: string;
  personasDir: string;
  skillsDir: string;
  memoryDir: string;
  memoryProjectsDir: string;
  memoryPersonasDir: string;
  journalDir: string;
  projectsDir: string;
  msgDir: string;
  archiveDir: string;
  activeProjectFile: string;
};

export type ProjectPaths = {
  root: string;
  config: string;
  plan: string;
  board: string;
  log: string;
  memory: string;
  runsDir: string;
  runsActiveDir: string;
  supervisorDir: string;
};

export function resolveHiveHome(): string {
  return process.env.HIVE_HOME || join(homedir(), ".hive");
}

export function getHivePaths(home: string = resolveHiveHome()): HivePaths {
  return {
    home,
    soul: join(home, "SOUL.md"),
    self: join(home, "SELF.md"),
    agents: join(home, "AGENTS.md"),
    config: join(home, "config.md"),
    feed: join(home, "feed.md"),
    personasDir: join(home, "personas"),
    skillsDir: join(home, "skills"),
    memoryDir: join(home, "memory"),
    memoryProjectsDir: join(home, "memory", "projects"),
    memoryPersonasDir: join(home, "memory", "personas"),
    journalDir: join(home, "memory", "journal"),
    projectsDir: join(home, "projects"),
    msgDir: join(home, "msg"),
    archiveDir: join(home, "archive"),
    activeProjectFile: join(home, "active-project.txt"),
  };
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  const file = Bun.file(path);

  if (await file.exists()) {
    return;
  }

  await Bun.write(path, `${content.trim()}\n`);
}

export async function ensureHiveScaffold(
  home: string = resolveHiveHome(),
): Promise<HivePaths> {
  const paths = getHivePaths(home);

  await mkdir(paths.personasDir, { recursive: true });
  await mkdir(paths.skillsDir, { recursive: true });
  await mkdir(paths.memoryProjectsDir, { recursive: true });
  await mkdir(paths.memoryPersonasDir, { recursive: true });
  await mkdir(paths.journalDir, { recursive: true });
  await mkdir(paths.projectsDir, { recursive: true });
  await mkdir(paths.msgDir, { recursive: true });
  await mkdir(paths.archiveDir, { recursive: true });

  for (const [relativePath, template] of Object.entries(baseTemplates)) {
    await writeIfMissing(join(paths.home, relativePath), template);
  }

  for (const [name, template] of Object.entries(personaTemplates)) {
    await writeIfMissing(join(paths.personasDir, `${name}.md`), template);
    await writeIfMissing(join(paths.memoryPersonasDir, `${name}.md`), `# Persona Memory: ${name}\n\n(none yet)`);
  }

  for (const [name, template] of Object.entries(skillTemplates)) {
    await writeIfMissing(join(paths.skillsDir, `${name}.md`), template);
  }

  return paths;
}

export function getProjectPaths(paths: HivePaths, projectId: string): ProjectPaths {
  const root = join(paths.projectsDir, projectId);

  return {
    root,
    config: join(root, "config.md"),
    plan: join(root, "PLAN.md"),
    board: join(root, "BOARD.md"),
    log: join(root, "LOG.md"),
    memory: join(paths.memoryProjectsDir, `${projectId}.md`),
    runsDir: join(root, "runs"),
    runsActiveDir: join(root, "runs", "active"),
    supervisorDir: join(root, "supervisor"),
  };
}

export async function ensureProjectScaffold(
  paths: HivePaths,
  input: {
    projectId: string;
    projectName: string;
    repoPath: string;
  },
): Promise<ProjectPaths> {
  const projectPaths = getProjectPaths(paths, input.projectId);

  await mkdir(projectPaths.root, { recursive: true });
  await mkdir(projectPaths.runsDir, { recursive: true });
  await mkdir(projectPaths.runsActiveDir, { recursive: true });
  await mkdir(projectPaths.supervisorDir, { recursive: true });
  await writeIfMissing(
    projectPaths.config,
    renderProjectConfigTemplate(input.projectName, input.repoPath),
  );
  await writeIfMissing(projectPaths.plan, renderPlanTemplate(input.projectName));
  await writeIfMissing(projectPaths.board, renderBoardTemplate());
  await writeIfMissing(
    projectPaths.log,
    renderLogTemplate(input.projectName, toDateLabel()),
  );
  await writeIfMissing(
    projectPaths.memory,
    renderProjectMemoryTemplate(input.projectName),
  );

  return projectPaths;
}

export async function setActiveProject(
  paths: HivePaths,
  projectId: string,
): Promise<void> {
  await Bun.write(paths.activeProjectFile, `${projectId}\n`);
}

export async function getActiveProject(paths: HivePaths): Promise<string | null> {
  const file = Bun.file(paths.activeProjectFile);

  if (!(await file.exists())) {
    return null;
  }

  const value = (await file.text()).trim();

  return value || null;
}

export async function listProjects(paths: HivePaths): Promise<string[]> {
  const entries = await readdir(paths.projectsDir, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function projectExists(
  paths: HivePaths,
  projectId: string,
): Promise<boolean> {
  const projectPaths = getProjectPaths(paths, projectId);

  try {
    const info = await stat(projectPaths.root);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function resolveRepoPath(inputPath: string): string {
  return resolve(process.cwd(), inputPath);
}
