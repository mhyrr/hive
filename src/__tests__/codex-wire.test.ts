import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCodexAgentsMdStatus,
  getCodexHome,
  getCodexHooksFeatureStatus,
  getRegisteredCodexHiveMcp,
  installCodexIdentityHook,
  writeCodexAgentsMd,
} from "../lib/codex-wire";

let originalHome: string | undefined;
let scratch: string;

beforeEach(async () => {
  originalHome = process.env.HOME;
  scratch = await mkdtemp(join(tmpdir(), "hive-codex-wire-"));
  process.env.HOME = scratch;
  await mkdir(join(scratch, ".codex"), { recursive: true });
  await mkdir(join(scratch, ".hive"), { recursive: true });
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  await rm(scratch, { recursive: true, force: true });
});

describe("getCodexHome", () => {
  test("returns ~/.codex relative to HOME", () => {
    expect(getCodexHome()).toBe(join(scratch, ".codex"));
  });
});

describe("getRegisteredCodexHiveMcp", () => {
  test("returns null when config.toml missing", async () => {
    expect(await getRegisteredCodexHiveMcp()).toBeNull();
  });

  test("returns null when config.toml has no [mcp_servers.hive] table", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      `model = "gpt-5.4"\n[mcp_servers.other]\ncommand = "/bin/foo"\n`,
    );
    expect(await getRegisteredCodexHiveMcp()).toBeNull();
  });

  test("returns command when [mcp_servers.hive] is present", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      `[mcp_servers.hive]\ncommand = "/path/to/hive-mcp"\nargs = []\n`,
    );
    expect(await getRegisteredCodexHiveMcp()).toBe("/path/to/hive-mcp");
  });

  test("ignores command keys in other tables", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      [
        `[mcp_servers.tidewave]`,
        `command = "/wrong/path"`,
        `[mcp_servers.hive]`,
        `command = "/right/path"`,
        `[other]`,
        `command = "/also/wrong"`,
      ].join("\n"),
    );
    expect(await getRegisteredCodexHiveMcp()).toBe("/right/path");
  });
});

describe("writeCodexAgentsMd", () => {
  test("writes new AGENTS.md when missing", async () => {
    const result = await writeCodexAgentsMd("# Identity\nhello");
    expect(result.written).toBe(true);
    const path = join(scratch, ".codex", "AGENTS.md");
    expect(existsSync(path)).toBe(true);
    expect(await Bun.file(path).text()).toBe("# Identity\nhello");
  });

  test("skips write when content is byte-identical", async () => {
    await writeFile(join(scratch, ".codex", "AGENTS.md"), "# Identity\nsame");
    const result = await writeCodexAgentsMd("# Identity\nsame");
    expect(result.written).toBe(false);
    expect(result.reason).toBe("unchanged");
  });

  test("rewrites when content differs", async () => {
    await writeFile(join(scratch, ".codex", "AGENTS.md"), "old");
    const result = await writeCodexAgentsMd("new");
    expect(result.written).toBe(true);
    expect(await Bun.file(join(scratch, ".codex", "AGENTS.md")).text()).toBe("new");
  });

  test("skips when ~/.codex doesn't exist", async () => {
    await rm(join(scratch, ".codex"), { recursive: true });
    const result = await writeCodexAgentsMd("anything");
    expect(result.written).toBe(false);
    expect(result.reason).toContain("codex not installed");
  });
});

describe("getCodexAgentsMdStatus", () => {
  test("reports missing AGENTS.md", async () => {
    const result = await getCodexAgentsMdStatus("identity");
    expect(result).toEqual({ exists: false, empty: true, current: false });
  });

  test("reports byte-current AGENTS.md", async () => {
    await writeFile(join(scratch, ".codex", "AGENTS.md"), "identity");
    const result = await getCodexAgentsMdStatus("identity");
    expect(result).toEqual({ exists: true, empty: false, current: true });
  });

  test("reports stale AGENTS.md", async () => {
    await writeFile(join(scratch, ".codex", "AGENTS.md"), "old identity");
    const result = await getCodexAgentsMdStatus("new identity");
    expect(result).toEqual({ exists: true, empty: false, current: false });
  });
});

describe("installCodexIdentityHook", () => {
  test("installs script and wires SessionStart on a fresh codex setup", async () => {
    const result = await installCodexIdentityHook();
    expect(result.scriptInstalled).toBe(true);
    expect(result.hookWired).toBe(true);

    const scriptPath = join(scratch, ".hive", "codex-load-identity.sh");
    expect(existsSync(scriptPath)).toBe(true);
    const script = await Bun.file(scriptPath).text();
    expect(script).toContain("identity emit");
    // TK-114: hook must pass --harness codex so AGENTS.md gets the Codex-direct
    // stack hint variant (no Skill tool conditional).
    expect(script).toContain("identity emit --harness codex");
    expect(script).toContain("$HOME/.codex/AGENTS.md");

    const hooksPath = join(scratch, ".codex", "hooks.json");
    const config = JSON.parse(await Bun.file(hooksPath).text());
    const sessionStart = config.hooks.SessionStart;
    expect(Array.isArray(sessionStart)).toBe(true);
    const wired = sessionStart.some((entry: { hooks?: Array<{ command?: string }> }) =>
      entry.hooks?.some((h) => h.command === scriptPath),
    );
    expect(wired).toBe(true);
  });

  test("preserves existing hooks from other tools", async () => {
    const otherCmd = "/path/to/other-tool-bridge";
    await writeFile(
      join(scratch, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: otherCmd, timeout: 5 }] }],
          Stop: [{ hooks: [{ type: "command", command: otherCmd }] }],
        },
      }),
    );

    await installCodexIdentityHook();

    const config = JSON.parse(await Bun.file(join(scratch, ".codex", "hooks.json")).text());

    const otherStillThere = config.hooks.SessionStart.some((e: { hooks?: Array<{ command?: string }> }) =>
      e.hooks?.some((h) => h.command === otherCmd),
    );
    expect(otherStillThere).toBe(true);
    expect(config.hooks.Stop).toBeDefined();
    expect(config.hooks.SessionStart.length).toBe(2); // existing + ours
  });

  test("is idempotent — second run reports already wired", async () => {
    await installCodexIdentityHook();
    const second = await installCodexIdentityHook();
    expect(second.scriptInstalled).toBe(false);
    expect(second.hookWired).toBe(false);
    expect(second.reason).toBe("already wired");
  });

  test("returns malformed reason if hooks.json is invalid JSON", async () => {
    await writeFile(join(scratch, ".codex", "hooks.json"), "{ not json");
    const result = await installCodexIdentityHook();
    expect(result.hookWired).toBe(false);
    expect(result.reason).toContain("malformed");
  });

  test("skips when ~/.codex doesn't exist", async () => {
    await rm(join(scratch, ".codex"), { recursive: true });
    const result = await installCodexIdentityHook();
    expect(result.scriptInstalled).toBe(false);
    expect(result.hookWired).toBe(false);
  });
});

describe("getCodexHooksFeatureStatus", () => {
  test("returns null when config.toml is missing", async () => {
    expect(await getCodexHooksFeatureStatus()).toBeNull();
  });

  test("returns enabled: true for [features] hooks = true (0.129+)", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      `model = "gpt-5.5"\n\n[features]\nhooks = true\n`,
    );
    const result = await getCodexHooksFeatureStatus();
    expect(result).toEqual({ enabled: true, key: "hooks" });
  });

  test("returns enabled: true for [features] codex_hooks = true (0.128)", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      `model = "gpt-5.5"\n\n[features]\ncodex_hooks = true\n`,
    );
    const result = await getCodexHooksFeatureStatus();
    expect(result).toEqual({ enabled: true, key: "codex_hooks" });
  });

  test("prefers hooks over codex_hooks when both present", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      `[features]\ncodex_hooks = true\nhooks = true\n`,
    );
    const result = await getCodexHooksFeatureStatus();
    expect(result).toEqual({ enabled: true, key: "hooks" });
  });

  test("returns enabled: false when hooks = false", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      `[features]\nhooks = false\n`,
    );
    const result = await getCodexHooksFeatureStatus();
    expect(result).toEqual({ enabled: false, key: "hooks", reason: "[features] hooks = false" });
  });

  test("returns enabled: false when [features] section exists but no hooks key", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      `[features]\nsome_other_flag = true\n`,
    );
    const result = await getCodexHooksFeatureStatus();
    expect(result).toEqual({ enabled: false, reason: "no hooks or codex_hooks key in [features]" });
  });

  test("returns enabled: false when no [features] section at all", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      `model = "gpt-5.5"\n[mcp_servers.hive]\ncommand = "/bin/foo"\n`,
    );
    const result = await getCodexHooksFeatureStatus();
    expect(result).toEqual({ enabled: false, reason: "no hooks or codex_hooks key in [features]" });
  });

  test("handles hooks key nested among other [features] keys", async () => {
    await writeFile(
      join(scratch, ".codex", "config.toml"),
      [
        `[features]`,
        `apps = true`,
        `hooks = true`,
        `plugins = true`,
        ``,
        `[mcp_servers.hive]`,
        `command = "/bin/foo"`,
      ].join("\n"),
    );
    const result = await getCodexHooksFeatureStatus();
    expect(result).toEqual({ enabled: true, key: "hooks" });
  });
});
