import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getHivePaths, getProjectPaths, listProjects } from "./paths";
import { parseFrontmatter } from "./frontmatter";
import { assembleIdentity } from "./identity";
import { readLog, readProjectMemorySnapshot, readProjectMemorySection, indexPath } from "./memory";
import { listTickets, type Ticket } from "./ticket";
import { rebuildIndex } from "./memory";

export interface HeartbeatDispatch {
  runId: string;
  ticketId?: string;
  goal: string;
  timestamp: string;
  reason: string;
}

export interface HeartbeatConfig {
  sessionId: string;
  createdAt: string;
  lastTick: string;
  tickCount: number;
  lastResult: string;
  enabled: boolean;
  intervalMinutes: number;
  consecutiveFailures: number;
  recentDispatches?: HeartbeatDispatch[];
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

/**
 * Assemble a context brief from memory and tickets.
 * This gives the heartbeat agent current project state without
 * spending tool calls to discover it.
 */
async function buildContextBrief(projectId: string): Promise<string> {
  const paths = getHivePaths();
  const sections: string[] = [];

  // Open tickets
  try {
    const open = await listTickets(paths, projectId, { status: "open" as any });
    const inProgress = await listTickets(paths, projectId, { status: "in_progress" as any });
    const all = [...inProgress, ...open];
    if (all.length > 0) {
      sections.push("**Tickets:**");
      for (const t of all) {
        sections.push(`- ${t.id} (${t.status}, P${t.priority}) ${t.title}`);
      }
    }

    // Auto-dispatch tickets — highlighted for heartbeat agent
    const autoDispatch = all.filter((t) => t.tags.includes("auto-dispatch") && t.status === "open");
    if (autoDispatch.length > 0) {
      const closedIds = new Set(
        (await listTickets(paths, projectId, { status: "closed" as any })).map((t) => t.id),
      );
      const allIds = new Set(all.map((t) => t.id));

      sections.push("");
      sections.push("**Auto-dispatch queue** (tagged for autonomous execution):");
      for (const t of autoDispatch) {
        const unresolvedDeps = t.depends.filter((d) => !closedIds.has(d));
        if (unresolvedDeps.length > 0) {
          sections.push(`- ${t.id} (P${t.priority}) ${t.title} — ⛔ BLOCKED by: ${unresolvedDeps.join(", ")}`);
        } else {
          sections.push(`- ${t.id} (P${t.priority}) ${t.title} — ✅ READY to dispatch`);
        }
      }
    }
  } catch { /* no tickets */ }

  // Memory index (lightweight summary)
  try {
    const idxPath = indexPath(paths, projectId);
    if (existsSync(idxPath)) {
      const idx = readFileSync(idxPath, "utf-8");
      // Extract just the summary, open questions, and recent activity
      const summaryMatch = idx.match(/## Summary\n([\s\S]*?)(?=\n##|$)/);
      const questionsMatch = idx.match(/## Open Questions\n([\s\S]*?)(?=\n##|$)/);
      const activityMatch = idx.match(/## Recent Activity\n([\s\S]*?)(?=\n##|$)/);

      if (summaryMatch) sections.push(`**Memory:** ${summaryMatch[1]!.trim()}`);
      if (questionsMatch) {
        const qs = questionsMatch[1]!.trim().split("\n").slice(0, 5);
        if (qs.length > 0) {
          sections.push(`**Open questions:**`);
          for (const q of qs) sections.push(q);
        }
      }
      if (activityMatch) {
        const acts = activityMatch[1]!.trim().split("\n").slice(0, 5);
        if (acts.length > 0) {
          sections.push(`**Recent memory activity:**`);
          for (const a of acts) sections.push(a);
        }
      }
    }
  } catch { /* no index */ }

  // Recent git (last 5 commits, cheap shell call)
  try {
    const projectDir = join(paths.projectsDir, projectId);
    const projectPath = getProjectPath(projectDir);
    const log = execSync("git log --oneline -5 2>/dev/null", { cwd: projectPath, encoding: "utf-8" }).trim();
    if (log) {
      sections.push(`**Recent commits:**`);
      sections.push(log);
    }
  } catch { /* not a git repo or no commits */ }

  // Dispatch runs
  try {
    const runsDir = join(paths.home, "runs");
    if (existsSync(runsDir)) {
      const entries = require("fs").readdirSync(runsDir, { withFileTypes: true })
        .filter((e: any) => e.isDirectory() && e.name.startsWith("RUN-"))
        .map((e: any) => e.name)
        .sort()
        .reverse()
        .slice(0, 3);

      const runSummaries: string[] = [];
      for (const runId of entries) {
        const status = readFileSync(join(runsDir, runId, "status"), "utf-8").trim();
        const goalRaw = readFileSync(join(runsDir, runId, "goal.md"), "utf-8");
        const goalLine = goalRaw.split("\n").find((l: string) => l.trim() && !l.startsWith("#") && !l.startsWith("---"))?.trim().slice(0, 60) || "unknown";
        runSummaries.push(`- ${runId}: ${status} — ${goalLine}`);
      }
      if (runSummaries.length > 0) {
        sections.push(`**Dispatch runs:**`);
        sections.push(runSummaries.join("\n"));
      }
    }
  } catch { /* no runs */ }

  if (sections.length === 0) return "";
  return "\n---\nContext brief (pre-assembled from memory, tickets, git):\n\n" + sections.join("\n") + "\n---";
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

  // Build context brief from memory, tickets, git
  const contextBrief = await buildContextBrief(projectId);

  let args: string[];

  if (config.sessionId) {
    // Resume existing session
    args = [
      "--resume", config.sessionId,
      "--append-system-prompt-file", identityPath,
      "--add-dir", hiveHome,
      "--permission-mode", "bypassPermissions",
      "--max-turns", "20",
      "--print",
      `HEARTBEAT_TICK ${timestamp}${contextBrief}`,
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
      "--max-turns", "20",
      "--print",
      `HEARTBEAT_INIT for project ${projectId} at ${projectPath}. Read ~/.hive/projects/${projectId}/HEARTBEAT.md for your standing orders — especially the Authorized Actions section. You have authority to dispatch work and close tickets. Use it.${contextBrief}`,
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

  // Rebuild memory index — cheap, runs every tick to keep it current
  try {
    await rebuildIndex(paths, projectId);
  } catch {
    // Non-fatal — index rebuild failure shouldn't break heartbeat
  }

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

  // Write to inbox.md when there's something to report
  if (result === "ACTION_TAKEN" && output) {
    const inboxPath = join(projectDir, "inbox.md");
    const header = `## ${timestamp} — Heartbeat\n`;
    const entry = `${header}\n${output}\n\n---\n\n`;
    const existing = existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") : `# Inbox: ${projectId}\n\n`;
    await Bun.write(inboxPath, existing + entry);
  }

  // macOS notification with first meaningful line of output
  if (result === "ACTION_TAKEN" && output) {
    const firstLine = output.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 120) || "Heartbeat found something";
    try {
      const escaped = firstLine.replace(/"/g, '\\"').replace(/'/g, "'");
      execSync(`osascript -e 'display notification "${escaped}" with title "HIVE: ${projectId}" sound name "Glass"'`);
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
