import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getHivePaths } from "../lib/paths";
import { formatRelativeTime } from "../lib/time";

interface RunInfo {
  id: string;
  status: string;
  goal: string;
  project: string;
  dispatched: string;
  pid: string;
  alive: boolean;
}

function isProcessAlive(pid: string): boolean {
  try {
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false; // intentional: ESRCH/EPERM — process not alive
  }
}

function readRunInfo(runsDir: string, runId: string): RunInfo | null {
  const runDir = join(runsDir, runId);

  try {
    const status = readFileSync(join(runDir, "status"), "utf-8").trim();
    const goalRaw = readFileSync(join(runDir, "goal.md"), "utf-8");

    // Extract first meaningful line as goal summary
    const goalLines = goalRaw.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
    const goal = goalLines[0]?.trim().slice(0, 70) ?? "unknown";

    // Extract project from goal metadata
    const projectMatch = goalRaw.match(/^Project:\s*(.+)$/m);
    const project = projectMatch?.[1]?.trim() ?? "unknown";

    // Extract dispatch time
    const timeMatch = goalRaw.match(/^Dispatched:\s*(.+)$/m);
    const dispatched = timeMatch?.[1]?.trim() ?? "";

    // Check if process is alive
    let pid = "";
    let alive = false;
    const pidPath = join(runDir, "pid");
    if (existsSync(pidPath)) {
      pid = readFileSync(pidPath, "utf-8").trim();
      alive = isProcessAlive(pid);
    }

    // If status says running but process is dead, figure out what happened
    let effectiveStatus = status;
    if (status === "running" && !alive) {
      // Check plan for completion
      const planPath = join(runDir, "plan.md");
      if (existsSync(planPath)) {
        const plan = readFileSync(planPath, "utf-8");
        const unchecked = (plan.match(/\[ \]/g) || []).length;
        const checked = (plan.match(/\[x\]/gi) || []).length;
        if (checked > 0 && unchecked === 0) {
          effectiveStatus = "complete";
        } else if (plan.toLowerCase().includes("blocked")) {
          effectiveStatus = "blocked";
        } else if (checked > 0) {
          effectiveStatus = "partial";
        } else {
          effectiveStatus = "crashed";
        }
      } else {
        effectiveStatus = "crashed";
      }
      // Fix the status file for next time
      require("fs").writeFileSync(join(runDir, "status"), effectiveStatus);
    }

    return { id: runId, status: effectiveStatus, goal, project, dispatched, pid, alive };
  } catch {
    // intentional: run directory unreadable — skip
    return null;
  }
}

export async function psCommand(_args: string[]): Promise<void> {
  const paths = getHivePaths();

  if (!existsSync(paths.runsDir)) {
    console.log("No runs found.");
    return;
  }

  const entries = readdirSync(paths.runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("RUN-"))
    .map((e) => e.name)
    .sort()
    .reverse();

  if (entries.length === 0) {
    console.log("No runs found.");
    return;
  }

  const runs = entries
    .map((id) => readRunInfo(paths.runsDir, id))
    .filter((r): r is RunInfo => r !== null);

  if (runs.length === 0) {
    console.log("No runs found.");
    return;
  }

  // Show last 10 runs
  const display = runs.slice(0, 10);

  const statusIcon: Record<string, string> = {
    running: "🔵",
    complete: "✅",
    partial: "🟠",
    failed: "❌",
    blocked: "🟡",
    crashed: "💀",
    killed: "🛑",
    timed_out: "⏰",
  };

  const failureStatuses = new Set(["failed", "crashed", "timed_out", "killed"]);

  for (const run of display) {
    const icon = statusIcon[run.status] ?? "⚪";
    const time = run.dispatched ? formatRelativeTime(new Date(run.dispatched)) : "";
    console.log(`${icon} ${run.id}  ${run.status.padEnd(10)}  ${run.project.padEnd(12)}  "${run.goal}"  ${time}`);

    if (failureStatuses.has(run.status)) {
      const logPath = join(paths.runsDir, run.id, "output.log");
      if (existsSync(logPath)) {
        const log = readFileSync(logPath, "utf-8").trimEnd();
        const lines = log.split("\n").filter((l) => l.trim());
        const tail = lines.slice(-3);
        for (const line of tail) {
          console.log(`     ${line.slice(0, 100)}`);
        }
      }
    }
  }
}
