import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

import { UsageError } from "../lib/errors";
import { getHivePaths, getProjectPaths, listProjects } from "../lib/paths";
import { parseFrontmatter } from "../lib/frontmatter";
import { writeIdentityTempFile, cleanupIdentityTempFile } from "../lib/identity";
import {
  readHeartbeatConfig,
  writeHeartbeatConfig,
  shouldTickNow,
  runTick,
  defaultConfig,
} from "../lib/heartbeat";

function resolveProjectFromCwd(): string | null {
  const paths = getHivePaths();
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
    } catch {}
  }

  return projects[0] ?? null;
}

function parseProjectFlag(args: string[]): { projectId: string; remaining: string[] } {
  const remaining: string[] = [];
  let projectId = "";

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--project" || args[i] === "-p") && args[i + 1]) {
      projectId = args[++i]!;
    } else {
      remaining.push(args[i]!);
    }
  }

  if (!projectId) {
    projectId = resolveProjectFromCwd() ?? "";
  }

  return { projectId, remaining };
}

async function heartbeatStart(projectId: string, args: string[]): Promise<void> {
  const paths = getHivePaths();
  const projectDir = join(paths.projectsDir, projectId);

  if (!existsSync(projectDir)) {
    throw new UsageError(`Project not found: ${projectId}`);
  }

  // Parse interval
  let interval = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--interval" && args[i + 1]) {
      interval = parseInt(args[++i]!, 10);
      if (isNaN(interval) || interval < 5) interval = 30;
    }
  }

  // Check for existing config
  const existing = readHeartbeatConfig(projectDir);
  if (existing?.enabled) {
    console.log(`Heartbeat already enabled for ${projectId} (interval: ${existing.intervalMinutes}m).`);
    return;
  }

  // Write config (reuse existing if just re-enabling)
  const config = existing ?? defaultConfig(interval);
  config.enabled = true;
  config.intervalMinutes = interval;
  await writeHeartbeatConfig(projectDir, config);

  // Write HEARTBEAT.md template if missing
  const projectPaths = getProjectPaths(paths, projectId);
  if (!existsSync(projectPaths.heartbeatOrders)) {
    const templatePath = join(dirname(import.meta.dir), "..", "templates", "heartbeat", "HEARTBEAT.md");
    if (existsSync(templatePath)) {
      let template = readFileSync(templatePath, "utf-8");
      template = template.replaceAll("{{projectName}}", projectId);
      await Bun.write(projectPaths.heartbeatOrders, template);
      console.log(`Created standing orders: ${projectPaths.heartbeatOrders}`);
    }
  }

  console.log(`Heartbeat enabled for ${projectId} (interval: ${interval}m).`);
  console.log(`Run \`hive heartbeat tick\` to test, or wait for launchd.`);
}

async function heartbeatStop(projectId: string): Promise<void> {
  const paths = getHivePaths();
  const projectDir = join(paths.projectsDir, projectId);
  const config = readHeartbeatConfig(projectDir);

  if (!config) {
    console.log(`No heartbeat configured for ${projectId}.`);
    return;
  }

  config.enabled = false;
  await writeHeartbeatConfig(projectDir, config);
  console.log(`Heartbeat disabled for ${projectId}.`);
}

async function heartbeatStatus(projectId?: string): Promise<void> {
  const paths = getHivePaths();
  const projects = projectId ? [projectId] : await listProjects(paths.projectsDir);

  let found = false;
  for (const pid of projects) {
    const projectDir = join(paths.projectsDir, pid);
    const config = readHeartbeatConfig(projectDir);
    if (!config) continue;
    found = true;

    const enabled = config.enabled ? "✅ enabled" : "⏸️  disabled";
    const lastTick = config.lastTick
      ? `${Math.round((Date.now() - new Date(config.lastTick).getTime()) / 60000)}m ago`
      : "never";

    console.log(`${pid}:`);
    console.log(`  Status:     ${enabled}`);
    console.log(`  Interval:   ${config.intervalMinutes}m`);
    console.log(`  Last tick:  ${lastTick}`);
    console.log(`  Last result: ${config.lastResult || "n/a"}`);
    console.log(`  Ticks:      ${config.tickCount}`);
    console.log(`  Failures:   ${config.consecutiveFailures}`);
    console.log();
  }

  if (!found) {
    console.log("No projects have heartbeat configured.");
    console.log("Run `hive heartbeat start` from a project directory to enable.");
  }
}

async function heartbeatTickCmd(projectId: string): Promise<void> {
  const paths = getHivePaths();
  const projectDir = join(paths.projectsDir, projectId);
  const config = readHeartbeatConfig(projectDir);

  if (!config || !config.enabled) {
    console.log(`Heartbeat not enabled for ${projectId}.`);
    return;
  }

  console.log(`Running heartbeat tick for ${projectId}...`);
  const result = await runTick(projectId);
  console.log(`Result: ${result.result}`);
  if (result.output) {
    console.log(`Output:\n${result.output}`);
  }
}

async function heartbeatReset(projectId: string): Promise<void> {
  const paths = getHivePaths();
  const projectDir = join(paths.projectsDir, projectId);
  const config = readHeartbeatConfig(projectDir);

  if (!config) {
    throw new UsageError(`No heartbeat configured for ${projectId}.`);
  }

  // Clear vestigial session fields if present (pre-TK-024 configs may have them).
  delete config.sessionId;
  delete config.createdAt;
  config.tickCount = 0;
  config.consecutiveFailures = 0;
  config.lastResult = "";
  await writeHeartbeatConfig(projectDir, config);
  console.log(`Heartbeat counters reset for ${projectId}.`);
}

async function heartbeatChat(_projectId: string, _initialMessage?: string): Promise<void> {
  // The pre-TK-024 chat workflow attached an interactive Claude session to the
  // long-lived heartbeat session via `--resume <sessionId>`. Heartbeat is now
  // stateless — there is no persistent session to resume. See TK-028 for the
  // replacement design (interactive session that reads/writes the same project
  // state as ticks via inbox.md and tickets, instead of via conversation history).
  throw new UsageError(
    `\`hive heartbeat chat\` is unavailable after the TK-024 stateless-tick refactor.\n` +
    `\n` +
    `Heartbeat ticks no longer share a Claude Code session, so there is nothing\n` +
    `to resume. For now, use \`hive\` directly for an interactive session, or file\n` +
    `goals as tickets / write them to the project's inbox.md — the next tick will\n` +
    `pick them up.\n` +
    `\n` +
    `Replacement design tracked in TK-028.`
  );
}

// Used by heartbeat.sh to check if a project should tick now
async function heartbeatCheckInterval(projectId: string): Promise<void> {
  const paths = getHivePaths();
  const projectDir = join(paths.projectsDir, projectId);
  const config = readHeartbeatConfig(projectDir);

  if (!config || !config.enabled || !shouldTickNow(config)) {
    console.log("skip");
  } else {
    console.log("tick");
  }
}

export async function heartbeatCommand(args: string[]): Promise<void> {
  const usage = `Usage: hive heartbeat <subcommand> [--project <name>]

Subcommands:
  start [--interval <min>]  Enable heartbeat for a project (default 30m)
  stop                      Disable heartbeat for a project
  status                    Show heartbeat status for all projects
  tick                      Run one heartbeat tick manually
  chat                      Interactive session with the heartbeat agent
  reset                     Reset session (creates fresh on next tick)
  check-interval            Internal: prints "tick" or "skip" for shell script`;

  const { projectId, remaining } = parseProjectFlag(args);
  const subcommand = remaining[0];

  if (!subcommand || subcommand === "--help") {
    throw new UsageError(usage);
  }

  switch (subcommand) {
    case "start":
      if (!projectId) throw new UsageError("No project found. Use --project or run from a project directory.");
      await heartbeatStart(projectId, remaining.slice(1));
      break;
    case "stop":
      if (!projectId) throw new UsageError("No project found.");
      await heartbeatStop(projectId);
      break;
    case "status":
      await heartbeatStatus(projectId || undefined);
      break;
    case "tick":
      if (!projectId) throw new UsageError("No project found.");
      await heartbeatTickCmd(projectId);
      break;
    case "chat":
      if (!projectId) throw new UsageError("No project found.");
      await heartbeatChat(projectId, remaining.slice(1).join(" ").trim() || undefined);
      break;
    case "reset":
      if (!projectId) throw new UsageError("No project found.");
      await heartbeatReset(projectId);
      break;
    case "check-interval":
      if (!projectId) { console.log("skip"); break; }
      await heartbeatCheckInterval(projectId);
      break;
    default:
      throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }
}
