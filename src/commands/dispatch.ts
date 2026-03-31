import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync, spawn } from "node:child_process";

import { UsageError } from "../lib/errors";
import { ensureDirectory, getHivePaths } from "../lib/paths";
import { parseFrontmatter } from "../lib/frontmatter";
import { readTicket, formatTicketDetail } from "../lib/ticket";

async function nextRunId(runsDir: string): Promise<string> {
  const entries = await readdir(runsDir).catch(() => []);
  const ids = entries
    .filter((e) => e.startsWith("RUN-"))
    .map((e) => parseInt(e.replace("RUN-", ""), 10))
    .filter((n) => !isNaN(n));
  const next = ids.length > 0 ? Math.max(...ids) + 1 : 1;
  return `RUN-${String(next).padStart(3, "0")}`;
}

function resolveProjectFromCwd(paths: ReturnType<typeof getHivePaths>): string | null {
  const cwd = process.cwd();
  if (!existsSync(paths.projectsDir)) return null;

  const projects = require("fs")
    .readdirSync(paths.projectsDir, { withFileTypes: true })
    .filter((e: any) => e.isDirectory())
    .map((e: any) => e.name);

  for (const projectId of projects) {
    try {
      const configPath = join(paths.projectsDir, projectId, "config.md");
      const raw = require("fs").readFileSync(configPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      const projectPath = parsed.attributes?.path as string | undefined;
      if (projectPath && cwd.startsWith(projectPath)) return projectId;
    } catch { /* skip */ }
  }

  return projects[0] ?? null;
}

function findClaude(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new UsageError("Could not find claude CLI. Is it installed?");
  }
}

export async function dispatchCommand(args: string[]): Promise<void> {
  const usage = `Usage: hive dispatch "<goal>" [--project <name>] [--ticket <id>]
       hive dispatch --ticket TK-007
       hive dispatch --plan <path-to-plan.md>`;

  if (args.length === 0) throw new UsageError(usage);

  const paths = getHivePaths();

  // Parse flags
  let goal = "";
  let projectId = "";
  let ticketId = "";
  let planPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectId = args[++i]!;
    } else if (args[i] === "--ticket" && args[i + 1]) {
      ticketId = args[++i]!;
    } else if (args[i] === "--plan" && args[i + 1]) {
      planPath = resolve(args[++i]!);
    } else if (!args[i]!.startsWith("--")) {
      goal = args[i]!;
    }
  }

  if (!projectId) {
    projectId = resolveProjectFromCwd(paths) ?? "";
  }

  if (!projectId) {
    throw new UsageError("No project found. Use --project or run from a project directory.");
  }

  // Build goal text
  let goalText = goal;

  if (ticketId) {
    const ticket = await readTicket(paths, projectId, ticketId);
    if (!ticket) throw new UsageError(`Ticket not found: ${ticketId}`);
    goalText = `Implement ticket ${ticket.id}: ${ticket.title}\n\n${formatTicketDetail(ticket)}`;
    if (goal) goalText = `${goal}\n\nTicket context:\n${formatTicketDetail(ticket)}`;
  }

  if (planPath) {
    if (!existsSync(planPath)) throw new UsageError(`Plan file not found: ${planPath}`);
    const planContent = await Bun.file(planPath).text();
    goalText = goalText
      ? `${goalText}\n\nPlan:\n${planContent}`
      : `Execute this plan:\n\n${planContent}`;
  }

  if (!goalText) throw new UsageError("No goal specified. Provide a goal string, --ticket, or --plan.");

  // Create run directory
  const runId = await nextRunId(paths.runsDir);
  const runDir = join(paths.runsDir, runId);
  await ensureDirectory(runDir);

  // Get project path for working directory
  const projectConfigPath = join(paths.projectsDir, projectId, "config.md");
  let projectPath = process.cwd();
  try {
    const raw = await Bun.file(projectConfigPath).text();
    const parsed = parseFrontmatter(raw);
    projectPath = (parsed.attributes?.path as string) ?? process.cwd();
  } catch { /* use cwd */ }

  // Write run metadata
  await Bun.write(join(runDir, "goal.md"), `# Goal\n\n${goalText}\n\n---\nProject: ${projectId}\nDispatched: ${new Date().toISOString()}\n`);
  await Bun.write(join(runDir, "status"), "running");

  // Find claude
  const claude = findClaude();

  // Build the message for the executor
  const message = `Your run directory is: ${runDir}\nWrite your plan to: ${runDir}/plan.md\nProject: ${projectId}\n\nGoal:\n${goalText}`;

  // Launch in background
  const logPath = join(runDir, "output.log");
  const logFd = require("fs").openSync(logPath, "w");

  const child = spawn(claude, [
    "-p", message,
    "--agent", "maya-executor",
    "--max-turns", "100",
    "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep,mcp__hive__read_hive_memory,mcp__hive__write_hive_memory,mcp__hive__list_tickets,mcp__hive__show_ticket,mcp__hive__update_ticket,mcp__hive__add_ticket_note,mcp__hive__convene_council",
  ], {
    cwd: projectPath,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  child.unref();
  await Bun.write(join(runDir, "pid"), String(child.pid));

  // Set up completion handler
  child.on("exit", async (code) => {
    require("fs").closeSync(logFd);
    const status = code === 0 ? "complete" : "failed";
    require("fs").writeFileSync(join(runDir, "status"), status);

    // macOS notification
    try {
      execSync(`osascript -e 'display notification "Run ${runId} ${status}" with title "HIVE" sound name "Glass"'`);
    } catch { /* notification is best-effort */ }
  });

  console.log(`Dispatched ${runId} (${projectId})`);
  console.log(`  Goal: ${goalText.split("\n")[0]!.slice(0, 80)}`);
  console.log(`  Log:  ${logPath}`);
  console.log(`  PID:  ${child.pid}`);
}
