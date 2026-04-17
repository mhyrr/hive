import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";

import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import { buildDashboard, dashboardPath } from "../lib/dashboard";
import { startDashboardServer, DEFAULT_PORT } from "../lib/dashboard/serve";

export async function dashboardCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive dashboard              Open in browser (server if running, else build+open)
  hive dashboard build        Regenerate ~/.hive/dashboard/index.html + archive
  hive dashboard serve [--port N] [--open]
                              Start the interactive server (127.0.0.1:7777)
  hive dashboard open         Open the existing static dashboard
  hive dashboard path         Print the dashboard file path`;

  const paths = await ensureHiveScaffold();
  const subcommand = args[0];

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(usage);
    return;
  }

  const outputPath = dashboardPath(paths);
  const defaultPort = Number(process.env.HIVE_DASHBOARD_PORT ?? DEFAULT_PORT);

  if (subcommand === "serve") {
    const { port, openAfter } = parseServeArgs(args.slice(1), defaultPort);
    const { server, port: actualPort } = startDashboardServer({ paths, port });
    const url = `http://127.0.0.1:${actualPort}`;
    console.log(`HIVE dashboard serving at ${url}`);
    if (openAfter) openInBrowser(url);
    // Keep the process alive; the server loop handles requests.
    // Under launchd this is the main loop; under a terminal, ctrl-C exits.
    await new Promise<void>((resolve) => {
      process.on("SIGTERM", () => { server.stop(); resolve(); });
      process.on("SIGINT",  () => { server.stop(); resolve(); });
    });
    return;
  }

  if (subcommand === "build") {
    const result = await buildDashboard(paths, outputPath);
    console.log(`Dashboard written: ${result.output}`);
    console.log(`Archive snapshot: ${result.archive}`);
    console.log(
      `  ${result.data.projects.length} projects · ` +
      `${result.data.tickets.ready.length + result.data.tickets.inProgress.length + result.data.tickets.blocked.length} active tickets · ` +
      `${result.data.runs.length} recent runs · ` +
      `${result.data.briefings.length} briefings`,
    );
    return;
  }

  if (!subcommand) {
    // Auto-detect: if the server is up, open the server URL. Else build + open.
    const serverUp = await probePort("127.0.0.1", defaultPort, 100);
    if (serverUp) {
      const url = `http://127.0.0.1:${defaultPort}`;
      console.log(`Dashboard server detected — opening ${url}`);
      openInBrowser(url);
      return;
    }
    const result = await buildDashboard(paths, outputPath);
    console.log(`Dashboard written: ${result.output}`);
    openInBrowser(outputPath);
    return;
  }

  if (subcommand === "open") {
    if (!existsSync(outputPath)) {
      throw new UsageError(
        `Dashboard not found at ${outputPath}. Run: hive dashboard build`,
      );
    }
    openInBrowser(outputPath);
    return;
  }

  if (subcommand === "path") {
    console.log(outputPath);
    return;
  }

  throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
}

function parseServeArgs(args: string[], defaultPort: number): { port: number; openAfter: boolean } {
  let port = defaultPort;
  let openAfter = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--port" || a === "-p") {
      const next = args[++i];
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError(`Invalid port: ${next}`);
      }
      port = n;
    } else if (a === "--open") {
      openAfter = true;
    } else {
      throw new UsageError(`Unknown flag: ${a}`);
    }
  }
  return { port, openAfter };
}

/**
 * TCP connect probe with a tight timeout. `true` iff we could open a
 * socket to the port within `timeoutMs`. No HTTP, no handshake — just
 * a "something is listening" signal.
 */
export function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error",   () => finish(false));
  });
}

function openInBrowser(target: string): void {
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "explorer" :
    "xdg-open";
  const child = spawn(opener, [target], { detached: true, stdio: "ignore" });
  child.unref();
}
