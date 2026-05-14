/**
 * Locate the `hive` CLI binary so the dashboard server can spawn it
 * from any runtime (terminal, launchd, test).
 *
 * Resolution order:
 *   1. `HIVE_BIN` environment variable
 *   2. `~/.hive/scripts/hive-bin` (installed by install.sh)
 *   3. `which hive` on PATH
 *
 * Throws if nothing is found. The server returns a 500 with an
 * actionable message pointing at install.sh or HIVE_BIN.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

export class HiveBinNotFoundError extends Error {
  constructor() {
    super(
      "hive CLI not found. Set HIVE_BIN, install via install.sh, or put `hive` on PATH.",
    );
    this.name = "HiveBinNotFoundError";
  }
}

export type Resolver = {
  /** For tests: override env.HIVE_BIN lookup. */
  env?: NodeJS.ProcessEnv;
  /** For tests: override filesystem lookup. */
  existsSync?: (p: string) => boolean;
  /** For tests: override `which hive` resolution. */
  which?: (cmd: string) => string | null;
  /** For tests: override home directory. */
  homedir?: () => string;
};

export function resolveHiveBin(r: Resolver = {}): string {
  const env = r.env ?? process.env;
  const exists = r.existsSync ?? existsSync;
  const which = r.which ?? defaultWhich;
  const home = r.homedir ?? homedir;

  const fromEnv = env.HIVE_BIN?.trim();
  if (fromEnv && exists(fromEnv)) return fromEnv;

  const fromScripts = join(home(), ".hive", "scripts", "hive-bin");
  if (exists(fromScripts)) return fromScripts;

  const fromPath = which("hive");
  if (fromPath) return fromPath;

  throw new HiveBinNotFoundError();
}

function defaultWhich(cmd: string): string | null {
  try {
    return execSync(`command -v ${cmd}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim() || null;
  } catch {
    // intentional: command not found — return null
    return null;
  }
}
