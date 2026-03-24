import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import { UsageError } from "../lib/errors";
import {
  reconcileGatewayState,
  writeGatewayState,
  type GatewayStateRecord,
} from "../lib/gateway-state";
import { buildDetachedInvocation } from "../lib/detached-supervisor";
import {
  ensureHiveScaffold,
  getActiveProject,
} from "../lib/paths";
import { isProcessAlive, DEFAULT_MAX_PARALLEL, DEFAULT_SUPERVISOR_INTERVAL_SECONDS } from "../lib/supervisor";
import {
  ensureManagedGatewaySupervisor,
  shutdownGateway,
  startGateway,
} from "../gateway/server";

const DEFAULT_PORT = 4200;
const DEFAULT_GATEWAY_START_TIMEOUT_MS = 4_000;

type GatewayCommandOptions = {
  action: "start" | "status" | "stop";
  port: number;
  open: boolean;
  child: boolean;
  intervalSeconds: number;
  maxParallel: number;
};

function parseGatewayArgs(args: string[]): GatewayCommandOptions {
  const first = args[0]?.trim().toLowerCase();

  if (first === "status" || first === "stop") {
    if (args.length !== 1) {
      throw new UsageError("Usage: hive gateway status | hive gateway stop");
    }

    return {
      action: first,
      port: DEFAULT_PORT,
      open: false,
      child: false,
      intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
      maxParallel: DEFAULT_MAX_PARALLEL,
    };
  }

  let port = DEFAULT_PORT;
  let open = false;
  let child = false;
  let intervalSeconds = DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
  let maxParallel = DEFAULT_MAX_PARALLEL;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--port") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new UsageError("Usage: hive start [--port <port>] [--open]");
      }

      port = value;
      index += 1;
      continue;
    }

    if (arg === "--interval") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError("Usage: hive run [--interval <seconds>] [--max-parallel <count>] [--port <port>]");
      }

      intervalSeconds = value;
      index += 1;
      continue;
    }

    if (arg === "--max-parallel") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError("Usage: hive run [--interval <seconds>] [--max-parallel <count>] [--port <port>]");
      }

      maxParallel = value;
      index += 1;
      continue;
    }

    if (arg === "--open") {
      open = true;
      continue;
    }

    if (arg === "--gateway-child") {
      child = true;
      continue;
    }

    throw new UsageError("Usage: hive start [--port <port>] [--open]");
  }

  return {
    action: "start",
    port,
    open,
    child,
    intervalSeconds,
    maxParallel,
  };
}

function cleanGatewayEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  // Strip Claude Code's auth token — the gateway doesn't run as a Claude Code
  // subagent and shouldn't inherit that credential. The Anthropic API key is
  // kept so the gateway can make direct Anthropic calls (e.g. /dream planning).
  delete env.CLAUDECODE;

  return env;
}

function formatGatewayStatus(state: GatewayStateRecord | null): string {
  if (!state) {
    return "Gateway: not running (no state file)";
  }

  const alive = state.pid !== null && isProcessAlive(state.pid);
  const gatewayLines = alive
    ? [
        "Gateway: active",
        `  pid: ${state.pid}`,
        `  port: ${state.port ?? "unknown"}`,
        `  url: ${state.url || "(unknown)"}`,
        `  started: ${state.started || "(unknown)"}`,
      ]
    : [
        "Gateway: not running (process dead)",
        `  last pid: ${state.pid ?? "unknown"}`,
        `  last port: ${state.port ?? "unknown"}`,
        `  started: ${state.started || "(unknown)"}`,
      ];

  const supervisorLine = state.supervisorPid
    ? `Supervisor: ${state.supervisorStatus ?? "active"} (pid ${state.supervisorPid}${state.supervisorProject ? `, project ${state.supervisorProject}` : ""})`
    : `Supervisor: ${state.supervisorStatus ?? "not running"}`;

  return [...gatewayLines, supervisorLine].join("\n");
}

async function waitForGatewayReady(input: {
  hiveHome: string;
  pid: number;
  timeoutMs?: number;
}): Promise<GatewayStateRecord | null> {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_GATEWAY_START_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const state = await reconcileGatewayState(input.hiveHome);

    if (state?.status === "active" && state.pid === input.pid && isProcessAlive(state.pid)) {
      return state;
    }

    if (!isProcessAlive(input.pid)) {
      break;
    }

    await Bun.sleep(100);
  }

  return reconcileGatewayState(input.hiveHome);
}

async function waitForGatewaySupervisorReady(input: {
  hiveHome: string;
  gatewayPid: number | null;
  projectId: string;
  timeoutMs?: number;
}): Promise<GatewayStateRecord | null> {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_GATEWAY_START_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const state = await reconcileGatewayState(input.hiveHome);
    const gatewayAlive = state?.pid != null && isProcessAlive(state.pid);
    const supervisorAlive = state?.supervisorPid != null && isProcessAlive(state.supervisorPid);

    if (
      state?.status === "active" &&
      gatewayAlive &&
      supervisorAlive &&
      state.supervisorProject === input.projectId
    ) {
      return state;
    }

    if (input.gatewayPid && !isProcessAlive(input.gatewayPid)) {
      break;
    }

    await Bun.sleep(100);
  }

  return reconcileGatewayState(input.hiveHome);
}

async function requestManagedSupervisorRestart(input: {
  port: number;
  intervalSeconds: number;
  maxParallel: number;
}): Promise<void> {
  const response = await fetch(`http://localhost:${input.port}/api/supervisor/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      intervalSeconds: input.intervalSeconds,
      maxParallel: input.maxParallel,
    }),
  });

  if (!response.ok) {
    throw new Error(`Gateway supervisor restart failed (${response.status})`);
  }
}

async function ensureManagedGatewayDaemon(input: {
  port: number;
  open: boolean;
  intervalSeconds: number;
  maxParallel: number;
}): Promise<GatewayStateRecord> {
  const paths = await ensureHiveScaffold();
  let existing = await reconcileGatewayState(paths.home);

  if (existing?.status === "active" && existing.pid && isProcessAlive(existing.pid)) {
    const activeProject = await getActiveProject(paths);
    const supervisorAlive = existing.supervisorPid !== null && isProcessAlive(existing.supervisorPid);
    const supervisorMatchesProject = !activeProject || existing.supervisorProject === activeProject;

    if (activeProject && (!supervisorAlive || !supervisorMatchesProject) && existing.port) {
      await requestManagedSupervisorRestart({
        port: existing.port,
        intervalSeconds: input.intervalSeconds,
        maxParallel: input.maxParallel,
      });
      existing =
        (await waitForGatewaySupervisorReady({
          hiveHome: paths.home,
          gatewayPid: existing.pid,
          projectId: activeProject,
        })) ?? existing;
    }

    if (
      activeProject &&
      (!existing.supervisorPid || !isProcessAlive(existing.supervisorPid) || existing.supervisorProject !== activeProject)
    ) {
      throw new UsageError(
        "Gateway is running but the managed supervisor is unavailable. Use `hive stop` and `hive start` to recover.",
      );
    }

    if (input.open && existing.url) {
      try {
        Bun.spawn(["open", existing.url], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        // ignore
      }
    }

    return existing;
  }

  const logPath = join(paths.home, "gateway.log");
  const logFd = openSync(logPath, "a");
  const invocation = buildDetachedInvocation([
    "gateway",
    "--gateway-child",
    "--port",
    String(input.port),
    "--interval",
    String(input.intervalSeconds),
    "--max-parallel",
    String(input.maxParallel),
  ]);
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: cleanGatewayEnv(),
  });

  closeSync(logFd);
  child.unref();

  const state = await waitForGatewayReady({
    hiveHome: paths.home,
    pid: child.pid ?? -1,
  });

  if (!state || state.status !== "active" || state.pid !== child.pid) {
    throw new UsageError(`Gateway failed to start. Check ${logPath} for details.`);
  }

  if (input.open && state.url) {
    try {
      Bun.spawn(["open", state.url], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      // ignore
    }
  }

  return state;
}

async function startManagedGatewayChild(options: GatewayCommandOptions): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);
  let state;

  try {
    state = startGateway({
      port: options.port,
      hivePaths: paths,
      projectId: activeProject,
      manageSupervisorChildren: true,
      supervisorIntervalSeconds: options.intervalSeconds,
      supervisorMaxParallel: options.maxParallel,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("EADDRINUSE")) {
      throw new UsageError(`Port ${options.port} is already in use. Try a different port with --port.`);
    }

    throw error;
  }

  const url = `http://localhost:${options.port}`;
  const started = new Date().toISOString();
  const supervisorState = activeProject
    ? await ensureManagedGatewaySupervisor({
        hivePaths: paths,
        projectId: activeProject,
        intervalSeconds: options.intervalSeconds,
        maxParallel: options.maxParallel,
      })
    : null;

  await writeGatewayState(paths.home, {
    status: "active",
    pid: process.pid,
    port: options.port,
    started,
    url,
    supervisorPid: supervisorState?.pid ?? null,
    supervisorStatus: supervisorState?.status ?? null,
    supervisorProject: supervisorState?.projectId ?? activeProject ?? null,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await shutdownGateway(state);
    await writeGatewayState(paths.home, {
      status: "stopped",
      pid: process.pid,
      port: options.port,
      started,
      url,
      supervisorPid: null,
      supervisorStatus: "stopped",
      supervisorProject: activeProject ?? null,
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("uncaughtException", (error) => {
    console.error(error);
    void shutdown();
  });

  return `HIVE Gateway started on ${url} (pid ${process.pid})`;
}

export async function gatewayStatusCommand(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const state = await reconcileGatewayState(paths.home);

  return formatGatewayStatus(state);
}

export async function stopManagedGatewayCommand(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const state = await reconcileGatewayState(paths.home);

  if (!state) {
    return "Gateway is not running (no state file).";
  }

  if (!state.pid || !isProcessAlive(state.pid)) {
    await writeGatewayState(paths.home, {
      ...state,
      status: "stopped",
      supervisorPid: null,
      supervisorStatus: "stopped",
    });
    return "Gateway is not running (process already dead). State file updated.";
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // process may have already exited
  }

  const deadline = Date.now() + 4_000;
  let reconciled = state;

  while (Date.now() < deadline) {
    reconciled = await reconcileGatewayState(paths.home) ?? reconciled;

    if (!isProcessAlive(state.pid) || reconciled.status === "stopped") {
      break;
    }

    await Bun.sleep(100);
  }

  return `Gateway stopped (pid ${state.pid}).`;
}

export async function startCommand(args: string[]): Promise<string> {
  const options = parseGatewayArgs(args);

  if (options.action !== "start" || options.child) {
    throw new UsageError("Usage: hive start [--port <port>] [--open]");
  }

  const state = await ensureManagedGatewayDaemon(options);

  return [
    `HIVE started at ${state.url || `http://localhost:${state.port ?? DEFAULT_PORT}`}`,
    `gateway pid: ${state.pid ?? "unknown"}`,
    `supervisor pid: ${state.supervisorPid ?? "starting"}`,
  ].join("\n");
}

export async function ensureGatewayRunning(input: {
  port?: number;
  open?: boolean;
  intervalSeconds?: number;
  maxParallel?: number;
} = {}): Promise<GatewayStateRecord> {
  return ensureManagedGatewayDaemon({
    port: input.port ?? DEFAULT_PORT,
    open: input.open ?? false,
    intervalSeconds: input.intervalSeconds ?? DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
    maxParallel: input.maxParallel ?? DEFAULT_MAX_PARALLEL,
  });
}

export async function gatewayCommand(args: string[]): Promise<string> {
  const options = parseGatewayArgs(args);

  if (options.action === "status") {
    return gatewayStatusCommand();
  }

  if (options.action === "stop") {
    return stopManagedGatewayCommand();
  }

  if (options.child) {
    return startManagedGatewayChild(options);
  }

  const state = await ensureManagedGatewayDaemon(options);

  return [
    `HIVE started at ${state.url || `http://localhost:${state.port ?? DEFAULT_PORT}`}`,
    `gateway pid: ${state.pid ?? "unknown"}`,
    `supervisor pid: ${state.supervisorPid ?? "starting"}`,
  ].join("\n");
}
