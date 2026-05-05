import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getPiHome,
  getPiMcpConfigPath,
  getPiSettingsPath,
  getRegisteredPiHiveMcp,
  hasPiMcpAdapterConfigured,
  registerPiHiveMcp,
} from "../lib/pi-wire";

let originalHome: string | undefined;
let scratch: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  scratch = await mkdtemp(join(tmpdir(), "hive-pi-wire-"));
  process.env.HOME = scratch;
  await mkdir(join(scratch, ".pi", "agent"), { recursive: true });
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(scratch, { recursive: true, force: true });
});

describe("getPiHome", () => {
  test("returns ~/.pi relative to HOME", () => {
    expect(getPiHome()).toBe(join(scratch, ".pi"));
  });
});

describe("getRegisteredPiHiveMcp", () => {
  test("returns null when mcp.json is missing", async () => {
    expect(await getRegisteredPiHiveMcp()).toBeNull();
  });

  test("returns null when mcp.json has no hive server", async () => {
    await writeFile(
      getPiMcpConfigPath(),
      JSON.stringify({ mcpServers: { other: { command: "/bin/other", args: [] } } }),
    );
    expect(await getRegisteredPiHiveMcp()).toBeNull();
  });

  test("returns command and args when hive server is present", async () => {
    await writeFile(
      getPiMcpConfigPath(),
      JSON.stringify({ mcpServers: { hive: { command: "/path/to/hive-mcp", args: ["--debug"] } } }),
    );
    expect(await getRegisteredPiHiveMcp()).toEqual({ command: "/path/to/hive-mcp", args: ["--debug"] });
  });
});

describe("hasPiMcpAdapterConfigured", () => {
  test("returns false when settings.json is missing", async () => {
    await rm(getPiSettingsPath(), { force: true });
    expect(await hasPiMcpAdapterConfigured()).toBe(false);
  });

  test("returns false when pi-mcp-adapter is not listed", async () => {
    await writeFile(getPiSettingsPath(), JSON.stringify({ packages: ["npm:other"] }));
    expect(await hasPiMcpAdapterConfigured()).toBe(false);
  });

  test("returns true when pi-mcp-adapter is listed", async () => {
    await writeFile(getPiSettingsPath(), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }));
    expect(await hasPiMcpAdapterConfigured()).toBe(true);
  });
});

describe("registerPiHiveMcp", () => {
  test("writes mcp.json when missing", async () => {
    await rm(getPiMcpConfigPath(), { force: true });
    const result = await registerPiHiveMcp("/path/to/hive-mcp");
    expect(result.added).toBe(true);
    expect(existsSync(getPiMcpConfigPath())).toBe(true);
    expect(await getRegisteredPiHiveMcp()).toEqual({ command: "/path/to/hive-mcp", args: [] });
  });

  test("preserves existing servers", async () => {
    await writeFile(
      getPiMcpConfigPath(),
      JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp"] } } }),
    );
    await registerPiHiveMcp("/path/to/hive-mcp");
    const raw = JSON.parse(await Bun.file(getPiMcpConfigPath()).text());
    expect(raw.mcpServers.playwright.command).toBe("npx");
    expect(raw.mcpServers.hive.command).toBe("/path/to/hive-mcp");
  });

  test("is idempotent when hive already exists", async () => {
    await registerPiHiveMcp("/path/to/hive-mcp");
    const result = await registerPiHiveMcp("/other/path");
    expect(result.added).toBe(false);
    expect(result.alreadyRegistered).toBe(true);
    expect(await getRegisteredPiHiveMcp()).toEqual({ command: "/path/to/hive-mcp", args: [] });
  });
});
