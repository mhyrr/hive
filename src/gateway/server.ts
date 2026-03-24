import { type ChildProcess } from "node:child_process";

import { type Server, type ServerWebSocket } from "bun";

import {
  markDetachedSupervisorStopped,
  reconcileDetachedSupervisorState,
  startManagedSupervisor,
  type DetachedSupervisorState,
} from "../lib/detached-supervisor";
import { readGatewayState, updateGatewayState } from "../lib/gateway-state";
import { readMessageFile } from "../lib/messages";
import {
  getProjectPaths,
  listProjects,
  type HivePaths,
} from "../lib/paths";
import { disposePersistentStewardsForHome, notifyStewardRunCompleted } from "../lib/persistent-steward";
import { listActiveRuns, markRunStopRequested, type RunResult } from "../lib/runs";
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
  isProcessAlive,
} from "../lib/supervisor";
import { dispatchWorkerLaunchPass } from "../commands/worker-launch-dispatch";
import { serveStaticAsset } from "./assets";
import { primeGatewayPersistentStewardSession } from "./console";
import { handleApi, handleOptions } from "./routes";
import { startGatewayWatcher } from "./watcher";

export type GatewayOptions = {
  port: number;
  hivePaths: HivePaths;
  projectId?: string | null;
  manageSupervisorChildren?: boolean;
  supervisorIntervalSeconds?: number;
  supervisorMaxParallel?: number;
};

export type GatewayEvent = {
  type: string;
  ts: string;
  project: string;
  data?: Record<string, unknown>;
};

export type GatewayBroadcast = (event: GatewayEvent) => void;

type GatewayState = {
  server: Server;
  clients: Set<ServerWebSocket<unknown>>;
  stopWatcher: () => void;
  hiveHome: string;
};

type ManagedSupervisorEntry = {
  projectId: string;
  child: ChildProcess;
  state: DetachedSupervisorState;
};

type ManagedGatewayController = {
  hivePaths: HivePaths;
  intervalSeconds: number;
  maxParallel: number;
  current: ManagedSupervisorEntry | null;
  queue: Promise<void>;
  stopping: boolean;
};

const managedGatewayControllers = new Map<string, ManagedGatewayController>();
const scheduledGatewayWorkerLaunches = new Map<string, ReturnType<typeof setTimeout>>();

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function writeGatewaySupervisorFields(input: {
  hiveHome: string;
  pid: number | null;
  status: string | null;
  projectId: string | null;
}): Promise<void> {
  const current = await readGatewayState(input.hiveHome);

  if (!current) {
    return;
  }

  await updateGatewayState(input.hiveHome, {
    supervisorPid: input.pid,
    supervisorStatus: input.status,
    supervisorProject: input.projectId,
  });
}

async function terminateManagedActiveRuns(hivePaths: HivePaths): Promise<void> {
  const projects = await listProjects(hivePaths);

  for (const projectId of projects) {
    const projectPaths = getProjectPaths(hivePaths, projectId);
    const activeRuns = await listActiveRuns(projectPaths);

    for (const run of activeRuns) {
      if (!run.pid || run.pid === process.pid || run.source === "console") {
        continue;
      }

      try {
        await markRunStopRequested(run, "gateway");
        process.kill(run.pid, "SIGTERM");
      } catch {
        // process already dead
      }
    }
  }
}

function enqueueControllerTask<T>(
  controller: ManagedGatewayController,
  task: () => Promise<T>,
): Promise<T> {
  const next = controller.queue.then(task, task);
  controller.queue = next.then(() => undefined, () => undefined);
  return next;
}

function bindManagedSupervisorExit(
  controller: ManagedGatewayController,
  entry: ManagedSupervisorEntry,
): void {
  entry.child.once("exit", () => {
    void enqueueControllerTask(controller, async () => {
      if (controller.current?.child !== entry.child) {
        return;
      }

      const projectPaths = getProjectPaths(controller.hivePaths, entry.projectId);
      const reconciled = await reconcileDetachedSupervisorState(projectPaths);
      const status = reconciled?.status ?? (controller.stopping ? "stopped" : "exited");

      controller.current = null;
      controller.stopping = false;
      await writeGatewaySupervisorFields({
        hiveHome: controller.hivePaths.home,
        pid: null,
        status,
        projectId: entry.projectId,
      });
    });
  });
}

async function stopManagedSupervisorController(
  controller: ManagedGatewayController,
): Promise<void> {
  const entry = controller.current;

  if (!entry) {
    controller.stopping = false;
    await writeGatewaySupervisorFields({
      hiveHome: controller.hivePaths.home,
      pid: null,
      status: "stopped",
      projectId: null,
    });
    return;
  }

  controller.stopping = true;

  if (entry.state.pid && isProcessAlive(entry.state.pid)) {
    try {
      process.kill(entry.state.pid, "SIGTERM");
    } catch {
      // process already dead
    }
  }

  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    if (!entry.state.pid || !isProcessAlive(entry.state.pid)) {
      break;
    }

    await Bun.sleep(100);
  }

  if (entry.state.pid && isProcessAlive(entry.state.pid)) {
    try {
      process.kill(entry.state.pid, "SIGKILL");
    } catch {
      // process already dead
    }
  }

  const projectPaths = getProjectPaths(controller.hivePaths, entry.projectId);
  await markDetachedSupervisorStopped(projectPaths, "stopped");
  controller.current = null;
  controller.stopping = false;
  await writeGatewaySupervisorFields({
    hiveHome: controller.hivePaths.home,
    pid: null,
    status: "stopped",
    projectId: entry.projectId,
  });
}

function getManagedGatewayController(hiveHome: string): ManagedGatewayController | null {
  return managedGatewayControllers.get(hiveHome) ?? null;
}

function gatewayWorkerLaunchKey(hiveHome: string, projectId: string): string {
  return `${hiveHome}:${projectId}`;
}

function clearScheduledGatewayWorkerLaunchesForHome(hiveHome: string): void {
  for (const [key, timer] of scheduledGatewayWorkerLaunches.entries()) {
    if (!key.startsWith(`${hiveHome}:`)) {
      continue;
    }

    clearTimeout(timer);
    scheduledGatewayWorkerLaunches.delete(key);
  }
}

export async function triggerManagedGatewayWorkerLaunchPass(input: {
  hivePaths: HivePaths;
  projectId: string;
}): Promise<void> {
  const controller = getManagedGatewayController(input.hivePaths.home);

  if (!controller) {
    return;
  }

  await dispatchWorkerLaunchPass({
    hivePaths: input.hivePaths,
    projectId: input.projectId,
    maxParallel: controller.maxParallel,
    source: "hive gateway",
    actor: "hive gateway watcher",
    logActor: "hive gateway",
  });
}

function scheduleManagedGatewayWorkerLaunchPass(input: {
  hivePaths: HivePaths;
  projectId: string;
  delayMs?: number;
}): void {
  const controller = getManagedGatewayController(input.hivePaths.home);

  if (!controller) {
    return;
  }

  const key = gatewayWorkerLaunchKey(input.hivePaths.home, input.projectId);
  const existing = scheduledGatewayWorkerLaunches.get(key);

  if (existing) {
    clearTimeout(existing);
  }

  scheduledGatewayWorkerLaunches.set(
    key,
    setTimeout(() => {
      scheduledGatewayWorkerLaunches.delete(key);
      void triggerManagedGatewayWorkerLaunchPass(input).catch(() => {
        // Best-effort background dispatch; the periodic supervisor pass remains a fallback.
      });
    }, input.delayMs ?? 200),
  );
}

async function handleManagedGatewayAssignment(input: {
  hivePaths: HivePaths;
  messagePath: string;
}): Promise<void> {
  // The core watcher has already verified this is a qualifying assignment
  // (type: assign, status: open, launch != manual, to != steward).
  // We just need to extract the projectId and schedule a worker launch.
  const message = await readMessageFile(input.messagePath);

  if (!message) {
    return;
  }

  const projectId = message.attributes.project?.trim();

  if (!projectId) {
    return;
  }

  scheduleManagedGatewayWorkerLaunchPass({
    hivePaths: input.hivePaths,
    projectId,
  });
}

// Track known active runs per project so we can detect completions.
const knownActiveRunsByProject = new Map<string, Set<string>>();

/**
 * Seed the known-runs map for a project so the first run-change event
 * after startup can correctly detect completions. Without this, the
 * first change event sees previousRunIds = {} and misses completions.
 */
async function seedKnownActiveRuns(hivePaths: HivePaths, projectId: string): Promise<void> {
  const projectPaths = getProjectPaths(hivePaths, projectId);
  const activeRuns = await listActiveRuns(projectPaths);
  knownActiveRunsByProject.set(projectId, new Set(activeRuns.map((r) => r.runId)));
}

async function handleManagedGatewayRunChange(input: {
  hivePaths: HivePaths;
  runActiveDirPath: string;
}): Promise<void> {
  // Extract projectId from the active dir path.
  // Active dir is: <hiveHome>/projects/<projectId>/runs/active
  const projectsDir = input.hivePaths.projectsDir;
  if (!input.runActiveDirPath.startsWith(projectsDir)) {
    return;
  }

  const relPath = input.runActiveDirPath.slice(projectsDir.length + 1);
  const projectId = relPath.split("/")[0];

  if (!projectId) {
    return;
  }

  const projectPaths = getProjectPaths(input.hivePaths, projectId);
  const currentRuns = await listActiveRuns(projectPaths);
  const currentRunIds = new Set(currentRuns.map((r) => r.runId));
  const previousRunIds = knownActiveRunsByProject.get(projectId) ?? new Set<string>();

  // Detect runs that were active but are now gone (completed/failed/cancelled).
  const completedRunIds: string[] = [];
  for (const runId of previousRunIds) {
    if (!currentRunIds.has(runId)) {
      completedRunIds.push(runId);
    }
  }

  knownActiveRunsByProject.set(projectId, currentRunIds);

  if (completedRunIds.length === 0) {
    return;
  }

  // Look up recent results for the completed runs and notify the steward.
  const { listRecentRunResults } = await import("../lib/runs");

  const recentResults = await listRecentRunResults(projectPaths, 20);
  const completedSet = new Set(completedRunIds);

  for (const result of recentResults) {
    if (completedSet.has(result.runId) && result.agentId !== "steward" && result.agentId !== "console") {
      void notifyStewardRunCompleted(input.hivePaths.home, projectId, result).catch(() => {
        // Best-effort notification; the supervisor poll remains a fallback.
      });
    }
  }
}

async function startManagedSupervisorForProject(
  controller: ManagedGatewayController,
  projectId: string,
): Promise<DetachedSupervisorState> {
  const handle = await startManagedSupervisor({
    projectPaths: getProjectPaths(controller.hivePaths, projectId),
    projectId,
    intervalSeconds: controller.intervalSeconds,
    maxParallel: controller.maxParallel,
    parentPid: process.pid,
  });
  const entry: ManagedSupervisorEntry = {
    projectId,
    child: handle.child,
    state: handle.state,
  };

  controller.current = entry;
  bindManagedSupervisorExit(controller, entry);
  await writeGatewaySupervisorFields({
    hiveHome: controller.hivePaths.home,
    pid: handle.state.pid,
    status: handle.state.status,
    projectId,
  });

  return handle.state;
}

export async function ensureManagedGatewaySupervisor(input: {
  hivePaths: HivePaths;
  projectId: string;
  intervalSeconds?: number;
  maxParallel?: number;
}): Promise<DetachedSupervisorState | null> {
  const controller = getManagedGatewayController(input.hivePaths.home);

  if (!controller) {
    return null;
  }

  if (input.intervalSeconds) {
    controller.intervalSeconds = input.intervalSeconds;
  }

  if (input.maxParallel) {
    controller.maxParallel = input.maxParallel;
  }

  return enqueueControllerTask(controller, async () => {
    const current = controller.current;

    if (
      current &&
      current.projectId === input.projectId &&
      current.state.pid &&
      isProcessAlive(current.state.pid)
    ) {
      const reconciled = await reconcileDetachedSupervisorState(
        getProjectPaths(input.hivePaths, input.projectId),
      );

      current.state = reconciled ?? current.state;
      return current.state;
    }

    if (current) {
      await stopManagedSupervisorController(controller);
    }

    return startManagedSupervisorForProject(controller, input.projectId);
  });
}

export async function restartManagedGatewaySupervisor(input: {
  hivePaths: HivePaths;
  projectId: string;
  intervalSeconds?: number;
  maxParallel?: number;
}): Promise<DetachedSupervisorState | null> {
  const controller = getManagedGatewayController(input.hivePaths.home);

  if (!controller) {
    return null;
  }

  if (input.intervalSeconds) {
    controller.intervalSeconds = input.intervalSeconds;
  }

  if (input.maxParallel) {
    controller.maxParallel = input.maxParallel;
  }

  return enqueueControllerTask(controller, async () => {
    await stopManagedSupervisorController(controller);
    return startManagedSupervisorForProject(controller, input.projectId);
  });
}

async function shutdownManagedGatewayController(hiveHome: string): Promise<void> {
  const controller = getManagedGatewayController(hiveHome);

  clearScheduledGatewayWorkerLaunchesForHome(hiveHome);

  if (!controller) {
    return;
  }

  await enqueueControllerTask(controller, async () => {
    await stopManagedSupervisorController(controller);
    await terminateManagedActiveRuns(controller.hivePaths);
  });
  managedGatewayControllers.delete(hiveHome);
}

export function startGateway(options: GatewayOptions): GatewayState {
  const clients = new Set<ServerWebSocket<unknown>>();
  void primeGatewayPersistentStewardSession({ options }).catch(() => {
    // Best-effort warmup so supervisor singleton checks can see the session early.
  });

  if (options.manageSupervisorChildren) {
    managedGatewayControllers.set(options.hivePaths.home, {
      hivePaths: options.hivePaths,
      intervalSeconds: options.supervisorIntervalSeconds ?? DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
      maxParallel: options.supervisorMaxParallel ?? DEFAULT_MAX_PARALLEL,
      current: null,
      queue: Promise.resolve(),
      stopping: false,
    });
  }

  const broadcast: GatewayBroadcast = (event) => {
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {
        clients.delete(ws);
      }
    }
  };

  // Seed known active runs for all projects so the first run-change event
  // can correctly detect completions instead of seeing an empty baseline.
  // Fire-and-forget since startGateway is sync; the seed completes before
  // any watcher event fires (watcher debounce is 200ms).
  if (options.manageSupervisorChildren) {
    void listProjects(options.hivePaths).then((projects) =>
      Promise.all(projects.map((p) => seedKnownActiveRuns(options.hivePaths, p.id)))
    ).catch(() => {});
  }

  const stopWatcher = startGatewayWatcher(
    options.hivePaths,
    broadcast,
    options.manageSupervisorChildren
      ? {
          onAssignment: (msgPath) => {
            void handleManagedGatewayAssignment({
              hivePaths: options.hivePaths,
              messagePath: msgPath,
            }).catch(() => {
              // The file may still be mid-write; the next watcher event will retry.
            });
          },
          onRunChanged: (runActiveDirPath) => {
            void handleManagedGatewayRunChange({
              hivePaths: options.hivePaths,
              runActiveDirPath,
            }).catch(() => {
              // Best-effort; the periodic supervisor pass remains a fallback.
            });
          },
        }
      : undefined,
    options.projectId ?? null,
  );

  const server = Bun.serve({
    port: options.port,
    fetch(req, server) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return handleOptions();
      }

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", {
          status: 400,
          headers: corsHeaders(),
        });
      }

      if (url.pathname.startsWith("/api/")) {
        return handleApi(req, url, options, broadcast);
      }

      return serveStaticAsset(url.pathname);
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({
          type: "connected",
          ts: new Date().toISOString(),
          data: { message: "Connected to HIVE Gateway" },
        }));
      },
      close(ws) {
        clients.delete(ws);
      },
      message(ws, msg) {
        if (msg === "ping") {
          ws.send("pong");
        }
      },
    },
  });

  return {
    server,
    clients,
    stopWatcher,
    hiveHome: options.hivePaths.home,
  };
}

export function stopGateway(state: GatewayState): void {
  void shutdownGateway(state);
}

export async function shutdownGateway(state: GatewayState): Promise<void> {
  state.stopWatcher();
  for (const ws of state.clients) {
    try {
      ws.close(1000, "Gateway shutting down");
    } catch {
      // ignore
    }
  }
  state.clients.clear();
  state.server.stop(true);
  await shutdownManagedGatewayController(state.hiveHome);
  await disposePersistentStewardsForHome(state.hiveHome);
}
