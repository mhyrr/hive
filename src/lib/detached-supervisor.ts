import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UsageError } from "./errors";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { ProjectPaths, ensureDirectory } from "./paths";
import { isProcessAlive } from "./supervisor";
import { toIsoTimestamp } from "./time";

export type DetachedSupervisorStatus = "active" | "stopping" | "stopped" | "exited";

export type DetachedSupervisorState = {
  projectId: string;
  pid: number | null;
  status: DetachedSupervisorStatus;
  mode: "detached";
  intervalSeconds: number;
  maxParallel: number;
  startedAt: string;
  updatedAt: string;
  lastPassAt: string | null;
  stoppedAt: string | null;
  stopRequestedAt: string | null;
  stopRequestedBy: string | null;
  logPath: string;
  path: string;
};

type DetachedSupervisorFiles = {
  stateFile: string;
  logFile: string;
};

function getDetachedSupervisorFiles(projectPaths: ProjectPaths): DetachedSupervisorFiles {
  return {
    stateFile: join(projectPaths.supervisorDir, "detached.md"),
    logFile: join(projectPaths.supervisorDir, "detached.log"),
  };
}

function renderBody(state: DetachedSupervisorState): string {
  const lines = [
    "## Summary",
    `- mode: ${state.mode}`,
    `- status: ${state.status}`,
    `- interval: ${state.intervalSeconds}s`,
    `- max-parallel: ${state.maxParallel}`,
    `- log: ${state.logPath}`,
  ];

  if (state.lastPassAt) {
    lines.push(`- last-pass: ${state.lastPassAt}`);
  }

  if (state.stopRequestedAt) {
    lines.push(`- stop-requested: ${state.stopRequestedAt} by ${state.stopRequestedBy ?? "unknown"}`);
  }

  if (state.stoppedAt) {
    lines.push(`- stopped: ${state.stoppedAt}`);
  }

  return lines.join("\n");
}

async function writeDetachedSupervisorStateRecord(
  path: string,
  state: Omit<DetachedSupervisorState, "path">,
): Promise<void> {
  const attributes: Record<string, string> = {
    project: state.projectId,
    status: state.status,
    mode: state.mode,
    interval: String(state.intervalSeconds),
    "max-parallel": String(state.maxParallel),
    started: state.startedAt,
    updated: state.updatedAt,
    log: state.logPath,
  };

  if (state.pid !== null) {
    attributes.pid = String(state.pid);
  }

  if (state.lastPassAt) {
    attributes["last-pass-at"] = state.lastPassAt;
  }

  if (state.stoppedAt) {
    attributes["stopped-at"] = state.stoppedAt;
  }

  if (state.stopRequestedAt) {
    attributes["stop-requested-at"] = state.stopRequestedAt;
  }

  if (state.stopRequestedBy) {
    attributes["stop-requested-by"] = state.stopRequestedBy;
  }

  await Bun.write(path, stringifyFrontmatter(attributes, renderBody({ ...state, path })));
}

function toNullableNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readDetachedSupervisorState(
  projectPaths: ProjectPaths,
): Promise<DetachedSupervisorState | null> {
  const files = getDetachedSupervisorFiles(projectPaths);
  const file = Bun.file(files.stateFile);

  if (!(await file.exists())) {
    return null;
  }

  const parsed = parseFrontmatter(await file.text());
  const attributes = parsed.attributes;
  const status = attributes.status as DetachedSupervisorStatus | undefined;
  const mode = attributes.mode;
  const startedAt = attributes.started;
  const updatedAt = attributes.updated;
  const logPath = attributes.log;
  const projectId = attributes.project;

  if (
    !projectId ||
    !status ||
    (status !== "active" && status !== "stopping" && status !== "stopped" && status !== "exited") ||
    mode !== "detached" ||
    !startedAt ||
    !updatedAt ||
    !logPath
  ) {
    return null;
  }

  return {
    projectId,
    pid: toNullableNumber(attributes.pid),
    status,
    mode: "detached",
    intervalSeconds: Number(attributes.interval) || 30,
    maxParallel: Number(attributes["max-parallel"]) || 3,
    startedAt,
    updatedAt,
    lastPassAt: attributes["last-pass-at"] ?? null,
    stoppedAt: attributes["stopped-at"] ?? null,
    stopRequestedAt: attributes["stop-requested-at"] ?? null,
    stopRequestedBy: attributes["stop-requested-by"] ?? null,
    logPath,
    path: files.stateFile,
  };
}

export async function writeDetachedSupervisorState(
  projectPaths: ProjectPaths,
  state: Omit<DetachedSupervisorState, "path">,
): Promise<DetachedSupervisorState> {
  const files = getDetachedSupervisorFiles(projectPaths);
  await ensureDirectory(projectPaths.supervisorDir);
  await writeDetachedSupervisorStateRecord(files.stateFile, state);
  return { ...state, path: files.stateFile };
}

export async function reconcileDetachedSupervisorState(
  projectPaths: ProjectPaths,
): Promise<DetachedSupervisorState | null> {
  const state = await readDetachedSupervisorState(projectPaths);

  if (!state) {
    return null;
  }

  if ((state.status === "active" || state.status === "stopping") && !isProcessAlive(state.pid)) {
    const timestamp = toIsoTimestamp();

    return writeDetachedSupervisorState(projectPaths, {
      ...state,
      status: state.stopRequestedAt ? "stopped" : "exited",
      pid: null,
      updatedAt: timestamp,
      stoppedAt: state.stoppedAt ?? timestamp,
    });
  }

  return state;
}

function buildDetachedInvocation(args: string[]): { command: string; args: string[] } {
  const executable = process.execPath;
  const executableName = basename(executable).toLowerCase();

  if (executableName === "bun" || executableName === "bun.exe") {
    const scriptPath = fileURLToPath(new URL("../../bin/hive.ts", import.meta.url));

    return {
      command: executable,
      args: [scriptPath, ...args],
    };
  }

  return { command: executable, args };
}

export async function startDetachedSupervisor(input: {
  projectPaths: ProjectPaths;
  projectId: string;
  intervalSeconds: number;
  maxParallel: number;
}): Promise<DetachedSupervisorState> {
  const priorState = await reconcileDetachedSupervisorState(input.projectPaths);

  if (priorState?.status === "active" && isProcessAlive(priorState.pid)) {
    throw new UsageError(
      `Detached supervisor already active for ${input.projectId} (pid ${priorState.pid ?? "unknown"}).`,
    );
  }

  const files = getDetachedSupervisorFiles(input.projectPaths);
  await ensureDirectory(input.projectPaths.supervisorDir);
  const logFd = openSync(files.logFile, "a");
  const invocation = buildDetachedInvocation([
    "supervise",
    "--supervisor-child",
    "--interval",
    String(input.intervalSeconds),
    "--max-parallel",
    String(input.maxParallel),
  ]);
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  closeSync(logFd);
  child.unref();

  const timestamp = toIsoTimestamp();

  return writeDetachedSupervisorState(input.projectPaths, {
    projectId: input.projectId,
    pid: child.pid ?? null,
    status: "active",
    mode: "detached",
    intervalSeconds: input.intervalSeconds,
    maxParallel: input.maxParallel,
    startedAt: timestamp,
    updatedAt: timestamp,
    lastPassAt: null,
    stoppedAt: null,
    stopRequestedAt: null,
    stopRequestedBy: null,
    logPath: files.logFile,
  });
}

export async function noteDetachedSupervisorPass(projectPaths: ProjectPaths): Promise<void> {
  const state = await readDetachedSupervisorState(projectPaths);

  if (!state) {
    return;
  }

  const timestamp = toIsoTimestamp();

  await writeDetachedSupervisorState(projectPaths, {
    ...state,
    status: "active",
    pid: process.pid,
    updatedAt: timestamp,
    lastPassAt: timestamp,
  });
}

export async function markDetachedSupervisorStopRequested(
  projectPaths: ProjectPaths,
  actor: string,
): Promise<DetachedSupervisorState | null> {
  const state = await reconcileDetachedSupervisorState(projectPaths);

  if (!state) {
    return null;
  }

  if (state.status !== "active" || !state.pid || !isProcessAlive(state.pid)) {
    return null;
  }

  const timestamp = toIsoTimestamp();

  return writeDetachedSupervisorState(projectPaths, {
    ...state,
    status: "stopping",
    updatedAt: timestamp,
    stopRequestedAt: timestamp,
    stopRequestedBy: actor,
  });
}

export async function markDetachedSupervisorStopped(
  projectPaths: ProjectPaths,
  status: Extract<DetachedSupervisorStatus, "stopped" | "exited">,
): Promise<DetachedSupervisorState | null> {
  const state = await readDetachedSupervisorState(projectPaths);

  if (!state) {
    return null;
  }

  const timestamp = toIsoTimestamp();

  return writeDetachedSupervisorState(projectPaths, {
    ...state,
    status,
    pid: null,
    updatedAt: timestamp,
    stoppedAt: timestamp,
  });
}

export function formatDetachedSupervisorState(
  state: DetachedSupervisorState | null,
  projectId: string,
): string {
  if (!state) {
    return `Project: ${projectId}\n\nDetached Supervisor\n\nNo detached supervisor state recorded.`;
  }

  return [
    `Project: ${projectId}`,
    "",
    "Detached Supervisor",
    "",
    `status: ${state.status}`,
    `pid: ${state.pid ?? "not running"}`,
    `started: ${state.startedAt}`,
    `updated: ${state.updatedAt}`,
    `last-pass: ${state.lastPassAt ?? "none yet"}`,
    `interval: ${state.intervalSeconds}s`,
    `max-parallel: ${state.maxParallel}`,
    `log: ${state.logPath}`,
    `state: ${state.path}`,
  ].join("\n");
}
