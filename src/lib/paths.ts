import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  baseTemplates,
  personaTemplates,
  renderPersonaTemplate,
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
  identity: string;
  self: string;
  agents: string;
  trust: string;
  config: string;
  feed: string;
  personasDir: string;
  skillsDir: string;
  memoryDir: string;
  memoryProjectsDir: string;
  memoryPersonasDir: string;
  journalDir: string;
  memoryStateDir: string;
  memorySummaryFile: string;
  memoryHeatFile: string;
  memoryRecentDecisionsFile: string;
  memoryEntitiesDir: string;
  memoryEntitiesProjectsDir: string;
  memoryEntitiesPeopleDir: string;
  memoryEntitiesCompaniesDir: string;
  projectsDir: string;
  msgDir: string;
  archiveDir: string;
  sessionsDir: string;
  approvalsDir: string;
  approvalsPendingDir: string;
  approvalsResolvedDir: string;
  eventsDir: string;
  eventsInternalDir: string;
  eventsExternalDir: string;
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
  stateDir: string;
  stateRevision: string;
  stateBoardSummary: string;
  stateOpenMessages: string;
  stateRecentResults: string;
  stateSeenResults: string;
  stateActiveRuns: string;
  stateHumanInbox: string;
  stateStewardDelta: string;
  stateDeltaHistory: string;
  stateSessionContext: string;
  stateUsage: string;
  statePacketsDir: string;
  statePacketBoardHealth: string;
  statePacketOpenDecisions: string;
  statePacketRunResultsDir: string;
  statePacketDiffTriageDir: string;
  statePacketHumanRequestsDir: string;
  statePacketWorkerBriefsDir: string;
  statePacketLogRollupsDir: string;
  statePacketPhaseSummariesDir: string;
  statePacketMemoryHotset: string;
  statePacketStaleMemory: string;
  stateCompilerDir: string;
  stateCompilerCacheIndex: string;
  stateWorkingSetDir: string;
  stateWorkingSetSteward: string;
  stateWorkGraph: string;      // legacy: single global graph (kept for compat)
  stateWorkGraphsDir: string;  // per-goal graphs: stateWorkGraphsDir/<goalId>.json
  stateReviewsDir: string;
  evalLog: string;
  goalsDir: string;
  schedulesDir: string;
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
    feed: join(home, "feed.md"),
    personasDir: join(home, "personas"),
    skillsDir: join(home, "skills"),
    memoryDir: join(home, "memory"),
    memoryProjectsDir: join(home, "memory", "projects"),
    memoryPersonasDir: join(home, "memory", "personas"),
    journalDir: join(home, "memory", "journal"),
    memoryStateDir: join(home, "memory", "state"),
    memorySummaryFile: join(home, "memory", "state", "memory-summary.json"),
    memoryHeatFile: join(home, "memory", "state", "memory-heat.json"),
    memoryRecentDecisionsFile: join(home, "memory", "state", "recent-decisions.json"),
    memoryEntitiesDir: join(home, "memory", "entities"),
    memoryEntitiesProjectsDir: join(home, "memory", "entities", "projects"),
    memoryEntitiesPeopleDir: join(home, "memory", "entities", "people"),
    memoryEntitiesCompaniesDir: join(home, "memory", "entities", "companies"),
    projectsDir: join(home, "projects"),
    msgDir: join(home, "msg"),
    archiveDir: join(home, "archive"),
    sessionsDir: join(home, "sessions"),
    approvalsDir: join(home, "approvals"),
    approvalsPendingDir: join(home, "approvals", "pending"),
    approvalsResolvedDir: join(home, "approvals", "resolved"),
    eventsDir: join(home, "events"),
    eventsInternalDir: join(home, "events", "internal"),
    eventsExternalDir: join(home, "events", "external"),
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

async function resolveUserName(selfPath: string): Promise<string> {
  const file = Bun.file(selfPath);

  if (!(await file.exists())) {
    return "the user";
  }

  const text = await file.text();
  const match = text.match(/^## Who I Serve\s*\n([^\n]+)/m);
  const line = match?.[1]?.trim();

  if (!line) {
    return "the user";
  }

  const [rawName] = line.split(/\s+[—-]\s+/);
  const userName = rawName?.trim();

  if (!userName || /^the user$/i.test(userName)) {
    return "the user";
  }

  return userName;
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
  await mkdir(paths.memoryStateDir, { recursive: true });
  await mkdir(paths.memoryEntitiesProjectsDir, { recursive: true });
  await mkdir(paths.memoryEntitiesPeopleDir, { recursive: true });
  await mkdir(paths.memoryEntitiesCompaniesDir, { recursive: true });
  await mkdir(paths.projectsDir, { recursive: true });
  await mkdir(paths.msgDir, { recursive: true });
  await mkdir(paths.archiveDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.approvalsPendingDir, { recursive: true });
  await mkdir(paths.approvalsResolvedDir, { recursive: true });
  await mkdir(paths.eventsInternalDir, { recursive: true });
  await mkdir(paths.eventsExternalDir, { recursive: true });

  for (const [relativePath, template] of Object.entries(baseTemplates)) {
    await writeIfMissing(join(paths.home, relativePath), template);
  }

  const userName = await resolveUserName(paths.self);

  for (const name of Object.keys(personaTemplates)) {
    await writeIfMissing(
      join(paths.personasDir, `${name}.md`),
      renderPersonaTemplate(name, { userName }),
    );
    await writeIfMissing(join(paths.memoryPersonasDir, `${name}.md`), `# Persona Memory: ${name}\n\n(none yet)`);
  }

  for (const [name, template] of Object.entries(skillTemplates)) {
    await writeIfMissing(join(paths.skillsDir, `${name}.md`), template);
  }

  return paths;
}

export function getProjectPaths(paths: HivePaths, projectId: string): ProjectPaths {
  const root = join(paths.projectsDir, projectId);
  const stateDir = join(root, "state");
  const statePacketsDir = join(stateDir, "packets");
  const stateCompilerDir = join(stateDir, "compiler");
  const stateWorkingSetDir = join(stateDir, "working-set");

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
    stateDir,
    stateRevision: join(stateDir, "revision.json"),
    stateBoardSummary: join(stateDir, "board-summary.json"),
    stateOpenMessages: join(stateDir, "open-messages.json"),
    stateRecentResults: join(stateDir, "recent-results.json"),
    stateSeenResults: join(stateDir, "seen-results.json"),
    stateActiveRuns: join(stateDir, "active-runs.json"),
    stateHumanInbox: join(stateDir, "human-inbox.json"),
    stateStewardDelta: join(stateDir, "steward-delta.json"),
    stateDeltaHistory: join(stateDir, "delta-history.jsonl"),
    stateSessionContext: join(stateDir, "session-context.json"),
    stateUsage: join(stateDir, "usage.json"),
    statePacketsDir,
    statePacketBoardHealth: join(statePacketsDir, "board-health.json"),
    statePacketOpenDecisions: join(statePacketsDir, "open-decisions.json"),
    statePacketRunResultsDir: join(statePacketsDir, "run-result"),
    statePacketDiffTriageDir: join(statePacketsDir, "diff-triage"),
    statePacketHumanRequestsDir: join(statePacketsDir, "human-request"),
    statePacketWorkerBriefsDir: join(statePacketsDir, "worker-brief"),
    statePacketLogRollupsDir: join(statePacketsDir, "log-rollup"),
    statePacketPhaseSummariesDir: join(statePacketsDir, "phase-summary"),
    statePacketMemoryHotset: join(statePacketsDir, "memory-hotset.json"),
    statePacketStaleMemory: join(statePacketsDir, "stale-memory.json"),
    stateCompilerDir,
    stateCompilerCacheIndex: join(stateCompilerDir, "cache-index.json"),
    stateWorkingSetDir,
    stateWorkingSetSteward: join(stateWorkingSetDir, "steward.json"),
    stateWorkGraph: join(stateDir, "work-graph.json"),
    stateWorkGraphsDir: join(stateDir, "work-graphs"),
    stateReviewsDir: join(stateDir, "reviews"),
    evalLog: join(root, "eval-log.jsonl"),
    goalsDir: join(root, "goals"),
    schedulesDir: join(root, "schedules"),
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
  await mkdir(projectPaths.stateDir, { recursive: true });
  await mkdir(projectPaths.goalsDir, { recursive: true });
  await mkdir(projectPaths.schedulesDir, { recursive: true });
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

/**
 * Returns the per-goal work graph path.
 * Use this instead of projectPaths.stateWorkGraph for new goals so
 * multiple concurrent dreams don't overwrite each other.
 */
export function goalWorkGraphPath(projectPaths: ProjectPaths, goalId: string): string {
  return join(projectPaths.stateWorkGraphsDir, `${goalId}.json`);
}
