import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  approveCursorHiveMcp,
  buildCursorLaunchArgs,
  findCursorBin,
  getCursorHiveMcpStatus,
  getCursorMcpConfigPath,
  getRegisteredCursorHiveMcp,
  isCursorInstalled,
  registerCursorHiveMcp,
  wireCursor,
} from "../lib/cursor-wire";

let originalHome: string | undefined;
let originalPath: string | undefined;
let originalOverride: string | undefined;
let originalLogPath: string | undefined;
let originalMode: string | undefined;
let scratch: string;
let binDir: string;

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalOverride = process.env.HIVE_CURSOR_BIN;
  originalLogPath = process.env.CURSOR_TEST_LOG;
  originalMode = process.env.CURSOR_TEST_MODE;

  scratch = await realpath(await mkdtemp(join(tmpdir(), "hive-cursor-wire-")));
  binDir = join(scratch, "bin");
  await mkdir(binDir, { recursive: true });
  process.env.HOME = scratch;
  process.env.PATH = binDir;
  delete process.env.HIVE_CURSOR_BIN;
  delete process.env.CURSOR_TEST_LOG;
  delete process.env.CURSOR_TEST_MODE;
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalPath !== undefined) process.env.PATH = originalPath;
  else delete process.env.PATH;
  if (originalOverride !== undefined) process.env.HIVE_CURSOR_BIN = originalOverride;
  else delete process.env.HIVE_CURSOR_BIN;
  if (originalLogPath !== undefined) process.env.CURSOR_TEST_LOG = originalLogPath;
  else delete process.env.CURSOR_TEST_LOG;
  if (originalMode !== undefined) process.env.CURSOR_TEST_MODE = originalMode;
  else delete process.env.CURSOR_TEST_MODE;
  await rm(scratch, { recursive: true, force: true });
});

describe("Cursor binary discovery", () => {
  test("prefers an existing HIVE_CURSOR_BIN override", async () => {
    const override = join(scratch, "custom cursor");
    await writeExecutable(override, "exit 0");
    await writeExecutable(join(binDir, "cursor-agent"), "exit 0");
    process.env.HIVE_CURSOR_BIN = override;

    expect(findCursorBin()).toBe(override);
    expect(isCursorInstalled()).toBe(true);
  });

  test("ignores a missing override and prefers cursor-agent over agent", async () => {
    const cursorAgent = join(binDir, "cursor-agent");
    await writeExecutable(cursorAgent, "exit 0");
    await writeExecutable(join(binDir, "agent"), "exit 0");
    process.env.HIVE_CURSOR_BIN = join(scratch, "missing");

    expect(findCursorBin()).toBe(cursorAgent);
  });

  test("uses agent only as the PATH compatibility fallback", async () => {
    const agent = join(binDir, "agent");
    await writeExecutable(agent, "exit 0");
    expect(findCursorBin()).toBe(agent);
  });

  test("ignores non-executable PATH entries", async () => {
    await writeFile(join(binDir, "cursor-agent"), "not executable");
    expect(findCursorBin()).toBeNull();
  });

  test("uses ~/.local/bin/cursor-agent after PATH discovery fails", async () => {
    const fallback = join(scratch, ".local", "bin", "cursor-agent");
    await mkdir(join(scratch, ".local", "bin"), { recursive: true });
    await writeExecutable(fallback, "exit 0");
    expect(findCursorBin()).toBe(fallback);
  });

  test("reports Cursor missing when every discovery path fails", () => {
    expect(findCursorBin()).toBeNull();
    expect(isCursorInstalled()).toBe(false);
  });
});

describe("Cursor MCP config", () => {
  test("resolves ~/.cursor/mcp.json from HOME", () => {
    expect(getCursorMcpConfigPath()).toBe(join(scratch, ".cursor", "mcp.json"));
  });

  test("writes a missing config and returns the registered command", async () => {
    const result = await registerCursorHiveMcp("/path/to/hive-mcp");
    expect(result).toEqual({ added: true, alreadyRegistered: false });
    expect(await getRegisteredCursorHiveMcp()).toEqual({ command: "/path/to/hive-mcp", args: [] });
  });

  test("preserves unrelated top-level values and MCP servers", async () => {
    await mkdir(join(scratch, ".cursor"), { recursive: true });
    await writeFile(
      getCursorMcpConfigPath(),
      JSON.stringify({
        version: 1,
        mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp"] } },
      }),
    );

    await registerCursorHiveMcp("/path/to/hive-mcp");
    const config = JSON.parse(await readFile(getCursorMcpConfigPath(), "utf-8"));
    expect(config.version).toBe(1);
    expect(config.mcpServers.playwright).toEqual({ command: "npx", args: ["@playwright/mcp"] });
    expect(config.mcpServers.hive).toEqual({ command: "/path/to/hive-mcp", args: [] });
  });

  test("never clobbers an existing hive entry", async () => {
    await mkdir(join(scratch, ".cursor"), { recursive: true });
    const existing = { command: "/custom/hive", args: ["serve"], env: { MODE: "custom" } };
    await writeFile(
      getCursorMcpConfigPath(),
      JSON.stringify({ mcpServers: { hive: existing } }, null, 2) + "\n",
    );

    const result = await registerCursorHiveMcp("/new/hive-mcp");
    expect(result).toEqual({ added: false, alreadyRegistered: true });
    const config = JSON.parse(await readFile(getCursorMcpConfigPath(), "utf-8"));
    expect(config.mcpServers.hive).toEqual(existing);
  });

  test("does not replace a malformed but user-owned hive entry", async () => {
    await mkdir(join(scratch, ".cursor"), { recursive: true });
    await writeFile(getCursorMcpConfigPath(), JSON.stringify({ mcpServers: { hive: { disabled: true } } }));
    const result = await registerCursorHiveMcp("/new/hive-mcp");
    expect(result).toEqual({ added: false, alreadyRegistered: true });
    expect(await getRegisteredCursorHiveMcp()).toBeNull();
  });

  test("leaves malformed JSON untouched", async () => {
    await mkdir(join(scratch, ".cursor"), { recursive: true });
    const malformed = "{ this belongs to the user";
    await writeFile(getCursorMcpConfigPath(), malformed);
    await expect(registerCursorHiveMcp("/path/to/hive-mcp")).rejects.toThrow();
    expect(await readFile(getCursorMcpConfigPath(), "utf-8")).toBe(malformed);
  });

  test("does not replace a non-object config", async () => {
    await mkdir(join(scratch, ".cursor"), { recursive: true });
    await writeFile(getCursorMcpConfigPath(), "null\n");
    await expect(registerCursorHiveMcp("/path/to/hive-mcp")).rejects.toThrow("JSON object");
    expect(await readFile(getCursorMcpConfigPath(), "utf-8")).toBe("null\n");
  });
});

describe("Cursor MCP subprocesses", () => {
  test("approves only hive with argv-safe spawning in the supplied cwd", async () => {
    const cursor = join(scratch, "cursor agent");
    const cwd = join(scratch, "working directory");
    const log = join(scratch, "approval.log");
    await mkdir(cwd);
    await writeExecutable(
      cursor,
      `printf '%s|%s|%s|%s\\n' "$PWD" "$1" "$2" "$3" > "$CURSOR_TEST_LOG"\nexit 0`,
    );
    process.env.CURSOR_TEST_LOG = log;

    expect(approveCursorHiveMcp(cursor, cwd)).toBe(true);
    expect((await readFile(log, "utf-8")).trim()).toBe(`${cwd}|mcp|enable|hive`);
  });

  test("approval is best-effort", async () => {
    const cursor = join(scratch, "cursor-agent-fail");
    await writeExecutable(cursor, "exit 9");
    expect(approveCursorHiveMcp(cursor, scratch)).toBe(false);
    expect(approveCursorHiveMcp(join(scratch, "missing"), scratch)).toBe(false);
  });

  test("parses ready, needs approval, error, and absent states", async () => {
    const cursor = join(scratch, "cursor-agent-status");
    await writeExecutable(
      cursor,
      [
        `case "$CURSOR_TEST_MODE" in`,
        `  ready) printf 'other: ready\\nhive: ready\\n' ;;`,
        `  approval) printf 'hive: not loaded (needs approval)\\n' ;;`,
        `  error) printf 'hive: error: process exited\\n' ;;`,
        `  absent) printf 'other: ready\\n' ;;`,
        `  ansi) printf '\\033[32mhive: ready\\033[0m\\n' ;;`,
        `esac`,
        `exit 0`,
      ].join("\n"),
    );

    process.env.CURSOR_TEST_MODE = "ready";
    expect(getCursorHiveMcpStatus(cursor, scratch)).toBe("ready");
    process.env.CURSOR_TEST_MODE = "approval";
    expect(getCursorHiveMcpStatus(cursor, scratch)).toBe("needs-approval");
    process.env.CURSOR_TEST_MODE = "error";
    expect(getCursorHiveMcpStatus(cursor, scratch)).toBe("error");
    process.env.CURSOR_TEST_MODE = "absent";
    expect(getCursorHiveMcpStatus(cursor, scratch)).toBe("absent");
    process.env.CURSOR_TEST_MODE = "ansi";
    expect(getCursorHiveMcpStatus(cursor, scratch)).toBe("ready");
  });

  test("reports a failed or missing status process as error", async () => {
    const cursor = join(scratch, "cursor-agent-status-fail");
    await writeExecutable(cursor, "exit 3");
    expect(getCursorHiveMcpStatus(cursor, scratch)).toBe("error");
    expect(getCursorHiveMcpStatus(join(scratch, "missing"), scratch)).toBe("error");
  });
});

describe("buildCursorLaunchArgs", () => {
  test("keeps Cursor options separate and combines identity with the user request", () => {
    const callerArgs = ["--mode", "ask", "Explain this code"];
    const launchArgs = buildCursorLaunchArgs("# HIVE Identity\nGreg", callerArgs);

    expect(launchArgs.slice(0, 2)).toEqual(["--mode", "ask"]);
    expect(launchArgs[2]).toStartWith("# HIVE Identity\nGreg");
    expect(launchArgs[2]).toContain("canonical HIVE session context");
    expect(launchArgs[2]).toContain("User request:\nExplain this code");
    expect(callerArgs).toEqual(["--mode", "ask", "Explain this code"]);
    expect(launchArgs).not.toContain("--plugin-dir");
  });

  test("preserves required option values and boolean flags", () => {
    const launchArgs = buildCursorLaunchArgs("identity", [
      "--model", "gpt-5",
      "--output-format=json",
      "--print",
      "first prompt part",
      "second part",
    ]);
    expect(launchArgs.slice(0, 4)).toEqual([
      "--model", "gpt-5", "--output-format=json", "--print",
    ]);
    expect(launchArgs[4]).toContain("User request:\nfirst prompt part second part");
  });

  test("-- forces flag-shaped text into the user request", () => {
    const launchArgs = buildCursorLaunchArgs("identity", ["--mode", "ask", "--", "--literal", "value"]);
    expect(launchArgs.slice(0, 2)).toEqual(["--mode", "ask"]);
    expect(launchArgs[2]).toContain("User request:\n--literal value");
  });

  test("tells a bare interactive session to wait for the user's request", () => {
    const launchArgs = buildCursorLaunchArgs("identity", ["--model", "gpt-5", "--print"]);
    expect(launchArgs.slice(0, 3)).toEqual(["--model", "gpt-5", "--print"]);
    expect(launchArgs[3]).toContain("not a task");
    expect(launchArgs[3]).toContain("wait for their request");
    expect(launchArgs[3]).not.toContain("User request:");
  });
});

describe("wireCursor", () => {
  test("skips cleanly when Cursor is missing", async () => {
    expect(await wireCursor({ mcpBinPath: "/path/to/hive-mcp" })).toEqual({
      detected: false,
      mcpAdded: false,
      mcpAlreadyRegistered: false,
      mcpApproved: false,
    });
  });

  test("registers MCP and attempts approval when Cursor is present", async () => {
    const cursor = join(binDir, "cursor-agent");
    await writeExecutable(cursor, "exit 0");

    expect(await wireCursor({ mcpBinPath: "/path/to/hive-mcp" })).toEqual({
      detected: true,
      mcpAdded: true,
      mcpAlreadyRegistered: false,
      mcpApproved: true,
    });
    expect(await getRegisteredCursorHiveMcp()).toEqual({ command: "/path/to/hive-mcp", args: [] });
  });
});
