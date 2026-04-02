import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getHivePaths } from "../lib/paths";
import { UsageError } from "../lib/errors";

export async function killCommand(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    throw new UsageError("Usage: hive kill <run-id>\n       hive kill RUN-001");
  }

  const paths = getHivePaths();

  // Normalize: accept "1", "001", "RUN-001"
  const normalized = runId.toUpperCase().startsWith("RUN-")
    ? runId.toUpperCase()
    : `RUN-${String(parseInt(runId, 10)).padStart(3, "0")}`;

  const runDir = join(paths.runsDir, normalized);
  if (!existsSync(runDir)) {
    throw new UsageError(`Run not found: ${normalized}`);
  }

  const statusPath = join(runDir, "status");
  const status = readFileSync(statusPath, "utf-8").trim();

  if (status !== "running") {
    console.log(`${normalized} is already ${status}.`);
    return;
  }

  const pidPath = join(runDir, "pid");
  if (!existsSync(pidPath)) {
    throw new UsageError(`No PID file for ${normalized}`);
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  // Check if process is alive
  try {
    process.kill(pid, 0);
  } catch {
    // Already dead — update status
    await Bun.write(statusPath, "crashed");
    console.log(`${normalized} process (${pid}) already dead. Marked as crashed.`);
    return;
  }

  // Send SIGTERM to the process group (negative PID kills the group)
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // If group kill fails, try the process directly
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      console.log(`${normalized} could not be killed (PID ${pid}).`);
      return;
    }
  }

  await Bun.write(statusPath, "killed");
  console.log(`${normalized} killed (PID ${pid}).`);
}
