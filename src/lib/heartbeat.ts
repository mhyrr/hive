import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getHivePaths, getProjectPaths, listProjects } from "./paths";
import { parseFrontmatter } from "./frontmatter";
import { assembleHeartbeatIdentity } from "./identity";
import { readLog, readProjectMemorySnapshot, readProjectMemorySection, indexPath } from "./memory";
import { listTickets, type Ticket } from "./ticket";
import { rebuildIndex } from "./memory";
import { shouldInvokeHeartbeat } from "./heartbeat-trigger";

export interface HeartbeatDispatch {
  runId: string;
  ticketId?: string;
  goal: string;
  timestamp: string;
  reason: string;
}

export interface HeartbeatConfig {
  /**
   * Vestigial: prior to TK-024, heartbeat used `--resume` against a long-lived
   * Claude Code session. That model invalidated prompt caching every tick (the
   * system prompt mutated between ticks, the conversation grew unbounded, and
   * cold-cache cost dominated). Heartbeat is now stateless — each tick is a
   * fresh `--print` invocation. The field is kept here only so existing
   * heartbeat.json files on disk parse without modification.
   */
  sessionId?: string;
  /**
   * Vestigial alongside `sessionId`. See note above.
   */
  createdAt?: string;
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

  // TK-025: Deterministic trigger gate. Ask the rules engine whether anything
  // meaningful has changed since lastTick. If not, short-circuit to
  // HEARTBEAT_OK without any LLM invocation. This is the ~90% no-op path.
  const trigger = await shouldInvokeHeartbeat({
    projectId,
    projectPath,
    lastTick: config.lastTick,
    paths,
  });

  if (!trigger.invoke) {
    // Nothing to do. Update counters and exit without touching the LLM.
    config.lastTick = timestamp;
    config.tickCount++;
    config.lastResult = "HEARTBEAT_OK";
    config.consecutiveFailures = 0;
    await writeHeartbeatConfig(projectDir, config);
    return {
      output: "HEARTBEAT_OK (gated — no signals since last tick)",
      exitCode: 0,
      result: "HEARTBEAT_OK",
    };
  }

  // Write deterministic heartbeat identity to a stable temp path. The path is
  // keyed by project (not pid) so subsequent ticks land on the same filename,
  // and the *content* is byte-stable across ticks unless the user edits an
  // identity file. (TK-024)
  const identity = await assembleHeartbeatIdentity(projectId);
  const identityPath = join(tmpdir(), `hive-heartbeat-${projectId}.md`);
  await Bun.write(identityPath, identity);

  // Write the per-tick variable payload (timestamp + context brief) to a file
  // the agent reads on entry. Why a file instead of inlining in the user
  // message: empirically (verified in jsonl from the first stateless ticks),
  // Claude Code's prompt cache breakpoint sits after the user message, so any
  // variable content in the user message — even a 7-token timestamp delta —
  // invalidates the entire 35K cached prefix. By stabilizing both the system
  // prompt AND the user message across ticks, the second tick within the 1h
  // TTL window can finally hit the cache. The file path is keyed by project
  // so each project's heartbeat has its own brief.
  const contextBrief = await buildContextBrief(projectId);
  const briefPath = join(paths.home, "projects", projectId, ".tick-brief.md");
  // Lead the brief with the trigger reasons so the LLM knows *why* it was woken
  // up. This is cheaper than having it rediscover the signals, and reduces the
  // risk of drift between the rules engine's view and the agent's view.
  const reasonsBlock = trigger.reasons.length > 0
    ? `\nTrigger reasons (why this tick fired instead of skipping):\n${trigger.reasons.map((r) => `- ${r}`).join("\n")}\n`
    : "";
  const briefContent = `# Heartbeat tick brief: ${projectId}\n\nGenerated: ${timestamp}\nProject path: ${projectPath}\n${reasonsBlock}${contextBrief}\n`;
  await Bun.write(briefPath, briefContent);

  // Stateless tick: fresh `--print` invocation every time. No `--resume`,
  // no `--session-id`. State that previously lived in conversation history
  // (what the agent did last tick) now comes from inbox.md, git, tickets,
  // and dispatch run records — all surfaced via the brief file the agent
  // reads on its first turn.
  //
  // The user message below is byte-stable across ticks for one project. Both
  // the system prompt (via assembleHeartbeatIdentity) and the user message
  // are invariant, so the prompt cache prefix matches between ticks within
  // the 1h TTL window.
  const args = [
    "--append-system-prompt-file", identityPath,
    "--agent", "maya-heartbeat",
    "--add-dir", hiveHome,
    "--permission-mode", "bypassPermissions",
    "--max-turns", "20",
    "--print",
    `HEARTBEAT_TICK for project ${projectId}. Read ~/.hive/projects/${projectId}/.tick-brief.md for the current state and timestamp, then read ~/.hive/projects/${projectId}/HEARTBEAT.md for your standing orders. Act per your authorized actions.`,
  ];

  const proc = Bun.spawnSync([claude, ...args], {
    cwd: projectPath,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  });

  const output = proc.stdout.toString().trim();
  const exitCode = proc.exitCode ?? 1;

  // Determine result
  const isOk = output.includes("HEARTBEAT_OK");
  const result: TickResult["result"] = exitCode !== 0 ? "ERROR" : isOk ? "HEARTBEAT_OK" : "ACTION_TAKEN";

  // Rebuild memory index — cheap, runs every tick to keep it current.
  // Note: index content does NOT feed back into the next tick's identity
  // prefix (heartbeat identity is deterministic), so this is safe for cache.
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
    lastTick: "",
    tickCount: 0,
    lastResult: "",
    enabled: true,
    intervalMinutes,
    consecutiveFailures: 0,
  };
}
