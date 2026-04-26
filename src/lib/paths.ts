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
  overrides: string;
  config: string;
  memoryDir: string;
  memoryProjectsDir: string;
  memoryDailyDir: string;
  memoryRunsDir: string;
  projectsDir: string;
  runsDir: string;
  reflectionsDir: string;
};

export type ProjectPaths = {
  root: string;
  config: string;
  heartbeatConfig: string;
  heartbeatOrders: string;
  inbox: string;
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
    overrides: join(home, "OVERRIDES.md"),
    config: join(home, "config.md"),
    memoryDir: join(home, "memory"),
    memoryProjectsDir: join(home, "memory", "projects"),
    memoryDailyDir: join(home, "memory", "daily"),
    memoryRunsDir: join(home, "memory", "runs"),
    projectsDir: join(home, "projects"),
    runsDir: join(home, "runs"),
    reflectionsDir: join(home, "reflections"),
  };
}

export function getProjectPaths(paths: HivePaths, projectId: string): ProjectPaths {
  const root = join(paths.projectsDir, projectId);

  return {
    root,
    config: join(root, "config.md"),
    heartbeatConfig: join(root, "heartbeat.json"),
    heartbeatOrders: join(root, "HEARTBEAT.md"),
    inbox: join(root, "inbox.md"),
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
  await mkdir(paths.memoryDailyDir, { recursive: true });
  await mkdir(paths.memoryRunsDir, { recursive: true });
  await mkdir(paths.projectsDir, { recursive: true });
  await mkdir(paths.runsDir, { recursive: true });
  await mkdir(paths.reflectionsDir, { recursive: true });

  return paths;
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
