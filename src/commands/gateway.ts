import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { parseFrontmatter, stringifyFrontmatter } from "../lib/frontmatter";
import { ensureHiveScaffold } from "../lib/paths";
import { startGateway, stopGateway } from "../gateway/server";

const DEFAULT_PORT = 4200;
const GATEWAY_FILE = "gateway.md";

function gatewayFilePath(hiveHome: string): string {
  return join(hiveHome, GATEWAY_FILE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readGatewayState(hiveHome: string): Promise<{
  status: string;
  pid: number;
  port: number;
  started: string;
  url: string;
} | null> {
  const file = Bun.file(gatewayFilePath(hiveHome));
  if (!(await file.exists())) return null;

  const text = await file.text();
  const { attributes } = parseFrontmatter(text);

  if (!attributes.pid || !attributes.port) return null;

  return {
    status: attributes.status ?? "unknown",
    pid: Number(attributes.pid),
    port: Number(attributes.port),
    started: attributes.started ?? "",
    url: attributes.url ?? "",
  };
}

async function writeGatewayState(
  hiveHome: string,
  state: { status: string; pid: number; port: number; started: string; url: string },
): Promise<void> {
  const content = stringifyFrontmatter(
    {
      status: state.status,
      pid: String(state.pid),
      port: String(state.port),
      started: state.started,
      url: state.url,
    },
    "",
  );
  await Bun.write(gatewayFilePath(hiveHome), content);
}

async function gatewayStatus(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const state = await readGatewayState(paths.home);

  if (!state) {
    return "Gateway: not running (no state file)";
  }

  const alive = isProcessAlive(state.pid);

  if (!alive) {
    return [
      "Gateway: not running (process dead)",
      `  last pid: ${state.pid}`,
      `  last port: ${state.port}`,
      `  started: ${state.started}`,
    ].join("\n");
  }

  return [
    "Gateway: active",
    `  pid: ${state.pid}`,
    `  port: ${state.port}`,
    `  url: ${state.url}`,
    `  started: ${state.started}`,
  ].join("\n");
}

async function gatewayStop(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const state = await readGatewayState(paths.home);

  if (!state) {
    return "Gateway is not running (no state file).";
  }

  if (!isProcessAlive(state.pid)) {
    await writeGatewayState(paths.home, { ...state, status: "stopped" });
    return "Gateway is not running (process already dead). State file updated.";
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // process may have already exited
  }

  await writeGatewayState(paths.home, { ...state, status: "stopped" });
  return `Gateway stopped (pid ${state.pid}).`;
}

function parseGatewayArgs(args: string[]): { port: number; open: boolean } {
  let port = DEFAULT_PORT;
  let open = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new UsageError("Invalid port number. Usage: hive gateway [--port <port>] [--open]");
      }
      port = value;
      i += 1;
    } else if (args[i] === "--open") {
      open = true;
    }
  }

  return { port, open };
}

async function startGatewayServer(args: string[]): Promise<string> {
  const { port, open } = parseGatewayArgs(args);
  const paths = await ensureHiveScaffold();

  // Check if already running
  const existing = await readGatewayState(paths.home);
  if (existing && isProcessAlive(existing.pid)) {
    return `Gateway already running (pid ${existing.pid}) at ${existing.url}`;
  }

  let state;
  try {
    state = startGateway({ port, hivePaths: paths });
  } catch (err) {
    if (err instanceof Error && err.message.includes("EADDRINUSE")) {
      throw new UsageError(`Port ${port} is already in use. Try a different port with --port.`);
    }
    throw err;
  }

  const url = `http://localhost:${port}`;
  const started = new Date().toISOString();

  await writeGatewayState(paths.home, {
    status: "active",
    pid: process.pid,
    port,
    started,
    url,
  });

  // Handle clean shutdown
  const shutdown = async () => {
    stopGateway(state);
    await writeGatewayState(paths.home, {
      status: "stopped",
      pid: process.pid,
      port,
      started,
      url,
    });
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (open) {
    // Open browser (macOS)
    try {
      Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      // ignore — user can open manually
    }
  }

  return `HIVE Gateway started on ${url} (pid ${process.pid})`;
}

export async function gatewayCommand(args: string[]): Promise<string> {
  const subcommand = args[0];

  if (subcommand === "status") return gatewayStatus();
  if (subcommand === "stop") return gatewayStop();

  return startGatewayServer(args);
}
