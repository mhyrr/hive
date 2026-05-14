import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface PiMcpConfig {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

export function getPiHome(): string {
  return join(process.env.HOME || "", ".pi");
}

export function getPiAgentDir(): string {
  return join(getPiHome(), "agent");
}

export function getPiMcpConfigPath(): string {
  return join(getPiAgentDir(), "mcp.json");
}

export function getPiSettingsPath(): string {
  return join(getPiAgentDir(), "settings.json");
}

export function isPiInstalled(): boolean {
  if (process.env.HIVE_PI_BIN && existsSync(process.env.HIVE_PI_BIN)) return true;
  try {
    execSync("which pi", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    // intentional: `which pi` not on PATH — check fallback location
    return existsSync(join(process.env.HOME || "", ".local", "bin", "pi"));
  }
}

export function findPiBin(): string | null {
  if (process.env.HIVE_PI_BIN && existsSync(process.env.HIVE_PI_BIN)) {
    return process.env.HIVE_PI_BIN;
  }
  try {
    return execSync("which pi", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // intentional: `which pi` not on PATH — try known fallback
    const fallback = join(process.env.HOME || "", ".local", "bin", "pi");
    return existsSync(fallback) ? fallback : null;
  }
}

export async function readPiMcpConfig(): Promise<PiMcpConfig | null> {
  const path = getPiMcpConfigPath();
  if (!existsSync(path)) return null;
  return JSON.parse(await Bun.file(path).text()) as PiMcpConfig;
}

export async function getRegisteredPiHiveMcp(): Promise<{ command: string; args: string[] } | null> {
  const config = await readPiMcpConfig();
  const hive = config?.mcpServers?.hive;
  if (!hive?.command) return null;
  return { command: hive.command, args: hive.args ?? [] };
}

export async function hasPiMcpAdapterConfigured(): Promise<boolean> {
  const path = getPiSettingsPath();
  if (!existsSync(path)) return false;

  const settings = JSON.parse(await Bun.file(path).text()) as { packages?: unknown };
  return Array.isArray(settings.packages) && settings.packages.includes("npm:pi-mcp-adapter");
}

export async function registerPiHiveMcp(mcpBinPath: string): Promise<{ added: boolean; alreadyRegistered: boolean }> {
  const existing = await getRegisteredPiHiveMcp();
  if (existing) return { added: false, alreadyRegistered: true };

  const config = (await readPiMcpConfig()) ?? {};
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers.hive = { command: mcpBinPath, args: [] };

  await mkdir(getPiAgentDir(), { recursive: true });
  await Bun.write(getPiMcpConfigPath(), JSON.stringify(config, null, 2) + "\n");
  return { added: true, alreadyRegistered: false };
}

export interface PiWireResult {
  detected: boolean;
  mcpAdded: boolean;
  mcpAlreadyRegistered: boolean;
}

export async function wirePi(opts: { mcpBinPath: string }): Promise<PiWireResult> {
  const result: PiWireResult = {
    detected: false,
    mcpAdded: false,
    mcpAlreadyRegistered: false,
  };

  if (!isPiInstalled()) return result;
  result.detected = true;

  const mcp = await registerPiHiveMcp(opts.mcpBinPath);
  result.mcpAdded = mcp.added;
  result.mcpAlreadyRegistered = mcp.alreadyRegistered;

  return result;
}
