import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getHivePaths, getProjectPaths, listProjects } from "./paths";
import { parseFrontmatter } from "./frontmatter";
import { assembleIdentity } from "./identity";

export interface HeartbeatConfig {
  sessionId: string;
  createdAt: string;
  lastTick: string;
  tickCount: number;
  lastResult: string;
  enabled: boolean;
  intervalMinutes: number;
  consecutiveFailures: number;
}

export function readHeartbeatConfig(projectDir: string): HeartbeatConfig | null {
  const configPath = join(projectDir, "heartbeat.json");
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

export async function writeHeartbeatConfig(projectDir: string, config: HeartbeatConfig): Promise<void> {
  await Bun.write(join(projectDir, "heartbeat.json"), JSON.stringify(config, null, 2) + "\n");
}

export function shouldTickNow(config: HeartbeatConfig): boolean {
  if (!config.enabled) return false;
  if (!config.lastTick) return true;

  const elapsed = Date.now() - new Date(config.lastTick).getTime();
  const intervalMs = config.intervalMinutes * 60 * 1000;
  return elapsed >= intervalMs;
}

function findClaude(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not find claude CLI. Is it installed?");
  }
}

function getProjectPath(projectDir: string): string {
  try {
    const raw = readFileSync(join(projectDir, "config.md"), "utf-8");
    const parsed = parseFrontmatter(raw);
    return (parsed.attributes?.path as string) || process.cwd();
  } catch {
    return process.cwd();
  }
}

export interface TickResult {
  output: string;
  exitCode: number;
  result: "HEARTBEAT_OK" | "ACTION_TAKEN" | "SESSION_DEAD" | "ERROR";
}

export async function runTick(projectId: string): Promise<TickResult> {
  const paths = getHivePaths();
  const projectDir = join(paths.projectsDir, projectId);
  let config = readHeartbeatConfig(projectDir);

  if (!config || !config.enabled) {
    return { output: "Heartbeat not enabled", exitCode: 1, result: "ERROR" };
  }

  const projectPath = getProjectPath(projectDir);
  const claude = findClaude();
  const timestamp = new Date().toISOString();
  const hiveHome = join(process.env.HOME || "", ".hive");

  // Write fresh identity to temp file
  const identity = await assembleIdentity();
  const identityPath = join(tmpdir(), `hive-heartbeat-${process.pid}.md`);
  await Bun.write(identityPath, identity);

  let args: string[];

  if (config.sessionId) {
    // Resume existing session
    args = [
      "--resume", config.sessionId,
      "--append-system-prompt-file", identityPath,
      "--add-dir", hiveHome,
      "--permission-mode", "bypassPermissions",
      "--max-turns", "15",
      "--print",
      `HEARTBEAT_TICK ${timestamp}`,
    ];
  } else {
    // Create new session
    const sessionId = crypto.randomUUID();
    config.sessionId = sessionId;
    config.createdAt = timestamp;
    args = [
      "--session-id", sessionId,
      "--append-system-prompt-file", identityPath,
      "--agent", "maya-heartbeat",
      "--add-dir", hiveHome,
      "--permission-mode", "bypassPermissions",
      "--max-turns", "15",
      "--print",
      `HEARTBEAT_INIT for project ${projectId} at ${projectPath}. Read ~/.hive/projects/${projectId}/HEARTBEAT.md for your standing orders.`,
    ];
  }

  const proc = Bun.spawnSync([claude, ...args], {
    cwd: projectPath,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  });

  // Clean up identity temp file
  try { require("fs").unlinkSync(identityPath); } catch {}

  const output = proc.stdout.toString().trim();
  const exitCode = proc.exitCode ?? 1;

  // Detect session death
  if (exitCode !== 0 && (output.includes("session not found") || output.includes("Session not found"))) {
    config.sessionId = "";
    config.lastResult = "SESSION_DEAD";
    config.consecutiveFailures++;
    config.lastTick = timestamp;
    await writeHeartbeatConfig(projectDir, config);
    return { output, exitCode, result: "SESSION_DEAD" };
  }

  // Determine result
  const isOk = output.includes("HEARTBEAT_OK");
  const result: TickResult["result"] = exitCode !== 0 ? "ERROR" : isOk ? "HEARTBEAT_OK" : "ACTION_TAKEN";

  // Update config
  config.lastTick = timestamp;
  config.tickCount++;
  config.lastResult = result;
  config.consecutiveFailures = exitCode === 0 ? 0 : config.consecutiveFailures + 1;

  // Check session age — recreate if > 7 days
  const ageMs = Date.now() - new Date(config.createdAt).getTime();
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    config.sessionId = ""; // Will create new on next tick
  }

  await writeHeartbeatConfig(projectDir, config);

  // macOS notification on significant actions
  if (result === "ACTION_TAKEN") {
    try {
      execSync(`osascript -e 'display notification "Heartbeat found something in ${projectId}" with title "HIVE" sound name "Glass"'`);
    } catch {}
  }

  return { output, exitCode, result };
}

export function defaultConfig(intervalMinutes: number = 30): HeartbeatConfig {
  return {
    sessionId: "",
    createdAt: "",
    lastTick: "",
    tickCount: 0,
    lastResult: "",
    enabled: true,
    intervalMinutes,
    consecutiveFailures: 0,
  };
}
