import { accessSync, constants, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface CursorMcpServerConfig {
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

export interface CursorMcpConfig {
  mcpServers?: Record<string, CursorMcpServerConfig>;
  [key: string]: unknown;
}

export type CursorHiveMcpStatus = "ready" | "needs-approval" | "error" | "absent";

export interface CursorWireResult {
  detected: boolean;
  mcpAdded: boolean;
  mcpAlreadyRegistered: boolean;
  mcpApproved: boolean;
}

const SUBPROCESS_TIMEOUT_MS = 10_000;

// Cursor accepts options before or after its variadic prompt, but only the
// first positional argument reliably reaches the model as the initial prompt.
// Split the documented option values from prompt text so HIVE can emit one
// identity-plus-request positional argument without corrupting flags.
const CURSOR_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--api-key",
  "-H",
  "--header",
  "-e",
  "--endpoint",
  "--output-format",
  "--mode",
  "--model",
  "--sandbox",
  "--workspace",
  "--add-dir",
  "--plugin-dir",
  "--worktree-base",
]);

const CURSOR_OPTIONS_WITH_OPTIONAL_VALUE: ReadonlySet<string> = new Set([
  "--resume",
  "-w",
  "--worktree",
]);

function findOnPath(name: string): string | null {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching. `which` semantics exclude non-executable files.
    }
  }
  return null;
}

export function getCursorMcpConfigPath(): string {
  return join(process.env.HOME || "", ".cursor", "mcp.json");
}

/**
 * Find Cursor's CLI without trusting the generic `agent` name until the
 * qualified `cursor-agent` name has been exhausted.
 */
export function findCursorBin(): string | null {
  const override = process.env.HIVE_CURSOR_BIN;
  if (override && existsSync(override)) return override;

  const qualified = findOnPath("cursor-agent");
  if (qualified) return qualified;

  const compatibilityAlias = findOnPath("agent");
  if (compatibilityAlias) return compatibilityAlias;

  const fallback = join(process.env.HOME || "", ".local", "bin", "cursor-agent");
  return existsSync(fallback) ? fallback : null;
}

export function isCursorInstalled(): boolean {
  return findCursorBin() !== null;
}

async function readCursorMcpConfig(): Promise<CursorMcpConfig | null> {
  const path = getCursorMcpConfigPath();
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(await Bun.file(path).text());
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("~/.cursor/mcp.json must contain a JSON object");
  }
  return parsed as CursorMcpConfig;
}

export async function getRegisteredCursorHiveMcp(): Promise<{
  command: string;
  args: string[];
} | null> {
  const config = await readCursorMcpConfig();
  const hive = config?.mcpServers?.hive;
  if (typeof hive?.command !== "string" || hive.command.length === 0) return null;
  return {
    command: hive.command,
    args: Array.isArray(hive.args) ? hive.args.filter((arg): arg is string => typeof arg === "string") : [],
  };
}

export async function registerCursorHiveMcp(
  mcpBinPath: string,
): Promise<{ added: boolean; alreadyRegistered: boolean }> {
  const config = (await readCursorMcpConfig()) ?? {};

  if (
    config.mcpServers !== undefined
    && (config.mcpServers === null || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))
  ) {
    throw new TypeError("~/.cursor/mcp.json has an invalid mcpServers value");
  }

  const servers = config.mcpServers ?? {};
  if (Object.prototype.hasOwnProperty.call(servers, "hive")) {
    return { added: false, alreadyRegistered: true };
  }

  servers.hive = { command: mcpBinPath, args: [] };
  config.mcpServers = servers;

  await mkdir(join(process.env.HOME || "", ".cursor"), { recursive: true });
  await Bun.write(getCursorMcpConfigPath(), JSON.stringify(config, null, 2) + "\n");
  return { added: true, alreadyRegistered: false };
}

/**
 * Cursor stores MCP approval per working directory. Approve only HIVE's
 * server; `--approve-mcps` would also approve unrelated user servers.
 */
export function approveCursorHiveMcp(cursorBin: string, cwd: string): boolean {
  try {
    const result = spawnSync(cursorBin, ["mcp", "enable", "hive"], {
      cwd,
      env: process.env,
      stdio: "ignore",
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return result.status === 0 && result.error === undefined;
  } catch {
    return false;
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function getCursorHiveMcpStatus(cursorBin: string, cwd: string): CursorHiveMcpStatus {
  try {
    const result = spawnSync(cursorBin, ["mcp", "list"], {
      cwd,
      env: process.env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    if (result.status !== 0 || result.error) return "error";

    const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    const hiveLine = output
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:[-*]\s*)?hive\s*:\s*(.+?)\s*$/i)?.[1])
      .find((value): value is string => value !== undefined);

    if (!hiveLine) return "absent";
    if (/\bready\b/i.test(hiveLine)) return "ready";
    if (/needs?[ -]approval|approval required/i.test(hiveLine)) return "needs-approval";
    return "error";
  } catch {
    return "error";
  }
}

/**
 * Cursor has no system-prompt flag. Although its prompt is declared variadic,
 * only the first positional argument reliably reaches the model. Preserve the
 * documented Cursor options, collect the remaining text, and emit one combined
 * identity-plus-request prompt. The `--` delimiter forces all later arguments
 * into the request.
 */
export function buildCursorLaunchArgs(identity: string, args: string[]): string[] {
  const options: string[] = [];
  const requestParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      requestParts.push(...args.slice(i + 1));
      break;
    }

    if (CURSOR_OPTIONS_WITH_VALUE.has(arg)) {
      options.push(arg);
      if (args[i + 1] !== undefined) options.push(args[++i]!);
      continue;
    }

    if (CURSOR_OPTIONS_WITH_OPTIONAL_VALUE.has(arg)) {
      options.push(arg);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) options.push(args[++i]!);
      continue;
    }

    if (arg.startsWith("-")) {
      options.push(arg);
      continue;
    }

    requestParts.push(arg);
  }

  const request = requestParts.join(" ").trim();
  const sessionInstruction = request
    ? `The text above is canonical HIVE session context, not a task. Execute the user request below.\n\n---\n\nUser request:\n${request}`
    : "The text above is canonical HIVE session context, not a task. Start an interactive session, greet the user briefly, then wait for their request.";

  return [...options, `${identity}\n\n---\n\n${sessionInstruction}`];
}

export async function wireCursor(opts: { mcpBinPath: string }): Promise<CursorWireResult> {
  const result: CursorWireResult = {
    detected: false,
    mcpAdded: false,
    mcpAlreadyRegistered: false,
    mcpApproved: false,
  };

  const cursorBin = findCursorBin();
  if (!cursorBin) return result;
  result.detected = true;

  const mcp = await registerCursorHiveMcp(opts.mcpBinPath);
  result.mcpAdded = mcp.added;
  result.mcpAlreadyRegistered = mcp.alreadyRegistered;
  result.mcpApproved = approveCursorHiveMcp(cursorBin, process.cwd());

  return result;
}
