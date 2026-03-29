import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type HivePaths = {
  home: string;
  soul: string;
  identity: string;
  self: string;
  agents: string;
  trust: string;
  config: string;
  memoryDir: string;
  memoryProjectsDir: string;
  projectsDir: string;
};

export type ProjectPaths = {
  root: string;
  config: string;
};

export function resolveHiveHome(): string {
  return process.env.HIVE_HOME || join(homedir(), ".hive");
}

export function getHivePaths(home: string = resolveHiveHome()): HivePaths {
  return {
    home,
    soul: join(home, "SOUL.md"),
    identity: join(home, "IDENTITY.md"),
    self: join(home, "SELF.md"),
    agents: join(home, "AGENTS.md"),
    trust: join(home, "TRUST.md"),
    config: join(home, "config.md"),
    memoryDir: join(home, "memory"),
    memoryProjectsDir: join(home, "memory", "projects"),
    projectsDir: join(home, "projects"),
  };
}

export function getProjectPaths(paths: HivePaths, projectId: string): ProjectPaths {
  const root = join(paths.projectsDir, projectId);

  return {
    root,
    config: join(root, "config.md"),
  };
}

export async function listProjects(projectsDir: string): Promise<string[]> {
  const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function ensureHiveScaffold(
  home: string = resolveHiveHome(),
): Promise<HivePaths> {
  const paths = getHivePaths(home);

  await mkdir(paths.memoryProjectsDir, { recursive: true });
  await mkdir(paths.projectsDir, { recursive: true });

  return paths;
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
