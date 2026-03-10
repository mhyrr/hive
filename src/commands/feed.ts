import { spawn } from "node:child_process";

import { UsageError } from "../lib/errors";
import { formatFeed } from "../lib/feed";
import { ensureHiveScaffold } from "../lib/paths";

function parseLimit(arg: string | undefined, command: string): number {
  if (!arg) {
    return 10;
  }

  const value = Number(arg);

  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`Usage: hive ${command} [count]`);
  }

  return value;
}

export async function feedCommand(args: string[]): Promise<string> {
  const limit = parseLimit(args[0], "feed");
  const paths = await ensureHiveScaffold();
  const feedText = await Bun.file(paths.feed).text();

  return formatFeed(feedText, limit);
}

export async function watchCommand(args: string[]): Promise<string> {
  const limit = parseLimit(args[0], "watch");
  const paths = await ensureHiveScaffold();
  const child = spawn("tail", ["-n", String(limit), "-f", paths.feed], {
    stdio: "inherit",
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode));
  });

  if (code && code !== 0) {
    throw new UsageError(`tail exited with status ${code}`);
  }

  return "";
}
