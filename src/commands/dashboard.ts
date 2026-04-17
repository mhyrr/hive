import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import { buildDashboard, dashboardPath } from "../lib/dashboard";

export async function dashboardCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive dashboard              Build and open in default browser
  hive dashboard build        Regenerate ~/.hive/dashboard/index.html
  hive dashboard open         Open the existing dashboard in the browser
  hive dashboard path         Print the dashboard file path`;

  const paths = await ensureHiveScaffold();
  const subcommand = args[0];

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(usage);
    return;
  }

  const outputPath = dashboardPath(paths);

  if (!subcommand || subcommand === "build") {
    const result = await buildDashboard(paths, outputPath);
    console.log(`Dashboard written: ${result.output}`);
    console.log(
      `  ${result.data.projects.length} projects · ` +
      `${result.data.tickets.ready.length + result.data.tickets.inProgress.length + result.data.tickets.blocked.length} active tickets · ` +
      `${result.data.runs.length} recent runs · ` +
      `${result.data.briefings.length} briefings`,
    );

    if (!subcommand) {
      openInBrowser(outputPath);
    }
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

function openInBrowser(path: string): void {
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "explorer" :
    "xdg-open";

  // Detach — we don't wait for the browser process.
  const child = spawn(opener, [path], { detached: true, stdio: "ignore" });
  child.unref();
}
