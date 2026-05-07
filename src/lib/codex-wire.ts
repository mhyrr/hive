// Codex CLI integration: HIVE MCP registration, AGENTS.md identity emission,
// SessionStart hook installation. Mirrors the pattern used for Claude Code.
//
// Codex's extensibility surface (~/.codex/):
//   - config.toml — [mcp_servers.<name>] table for MCP registration
//   - AGENTS.md   — auto-loaded persistent context (Claude Code's CLAUDE.md analog)
//   - hooks.json  — SessionStart / Stop / UserPromptSubmit event handlers
//
// All three plug straight into Codex without any adapter layer.

import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";

export interface CodexHookEntry {
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}
export interface CodexHooksConfig {
  hooks?: Record<string, CodexHookEntry[]>;
}

export function getCodexHome(): string {
  return join(process.env.HOME || "", ".codex");
}

export function isCodexInstalled(): boolean {
  if (process.env.HIVE_CODEX_BIN && existsSync(process.env.HIVE_CODEX_BIN)) return true;
  try {
    execSync("which codex", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return existsSync(join(process.env.HOME || "", ".local", "bin", "codex"));
  }
}

export function findCodexBin(): string | null {
  if (process.env.HIVE_CODEX_BIN && existsSync(process.env.HIVE_CODEX_BIN)) {
    return process.env.HIVE_CODEX_BIN;
  }
  try {
    return execSync("which codex", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    const fallback = join(process.env.HOME || "", ".local", "bin", "codex");
    return existsSync(fallback) ? fallback : null;
  }
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

/**
 * Read codex config.toml and check whether [mcp_servers.hive] is registered.
 * Returns the configured command string if found, else null.
 *
 * We parse config.toml minimally — only the lines we care about — to avoid
 * a TOML dependency for a single-key check.
 */
export async function getRegisteredCodexHiveMcp(): Promise<string | null> {
  const configPath = join(getCodexHome(), "config.toml");
  if (!existsSync(configPath)) return null;
  const raw = await Bun.file(configPath).text();

  const lines = raw.split("\n");
  let inHiveTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inHiveTable = trimmed === "[mcp_servers.hive]";
      continue;
    }
    if (inHiveTable) {
      const match = line.match(/^\s*command\s*=\s*"([^"]+)"/);
      if (match) return match[1] ?? null;
    }
  }
  return null;
}

/**
 * Register HIVE's MCP server with Codex if not already registered.
 * Uses `codex mcp add` to write config.toml so the format matches Codex's
 * own canonical shape.
 */
export async function registerCodexHiveMcp(mcpBinPath: string): Promise<{ added: boolean; alreadyRegistered: boolean }> {
  const existing = await getRegisteredCodexHiveMcp();
  if (existing) return { added: false, alreadyRegistered: true };

  const codex = findCodexBin();
  if (!codex) return { added: false, alreadyRegistered: false };

  execSync(`"${codex}" mcp add hive -- "${mcpBinPath}"`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { added: true, alreadyRegistered: false };
}

// ---------------------------------------------------------------------------
// AGENTS.md emission
// ---------------------------------------------------------------------------

/**
 * Write Codex's AGENTS.md from the current HIVE identity prefix.
 * Skips the write if the content is byte-identical to what's already there
 * (preserves Codex's prefix cache).
 */
export async function writeCodexAgentsMd(identity: string): Promise<{ written: boolean; reason: string }> {
  const codexHome = getCodexHome();
  if (!existsSync(codexHome)) {
    return { written: false, reason: "codex not installed (~/.codex missing)" };
  }
  const agentsPath = join(codexHome, "AGENTS.md");

  if (existsSync(agentsPath)) {
    const current = await Bun.file(agentsPath).text();
    if (current === identity) {
      return { written: false, reason: "unchanged" };
    }
  }

  await Bun.write(agentsPath, identity);
  return { written: true, reason: "wrote ~/.codex/AGENTS.md" };
}

export async function getCodexAgentsMdStatus(identity: string): Promise<{
  exists: boolean;
  empty: boolean;
  current: boolean;
}> {
  const agentsPath = join(getCodexHome(), "AGENTS.md");
  if (!existsSync(agentsPath)) {
    return { exists: false, empty: true, current: false };
  }

  const content = await Bun.file(agentsPath).text();
  return {
    exists: true,
    empty: content.length === 0,
    current: content === identity,
  };
}

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

const CODEX_HOOK_SCRIPT = `#!/bin/bash
# HIVE Codex identity refresher — runs on SessionStart and writes the
# canonical identity prefix into ~/.codex/AGENTS.md so Codex picks it up
# natively. The hive -x launcher refreshes the file before spawning Codex;
# this hook keeps direct codex sessions on the same path.

if command -v hive >/dev/null 2>&1; then
  HIVE_BIN="hive"
elif [ -x "$HOME/.local/bin/hive" ]; then
  HIVE_BIN="$HOME/.local/bin/hive"
else
  exit 0
fi

AGENTS_PATH="$HOME/.codex/AGENTS.md"
TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

if "$HIVE_BIN" identity emit > "$TMP_FILE" 2>/dev/null; then
  if [ -s "$TMP_FILE" ]; then
    if ! [ -f "$AGENTS_PATH" ] || ! cmp -s "$TMP_FILE" "$AGENTS_PATH"; then
      mv "$TMP_FILE" "$AGENTS_PATH"
    fi
  fi
fi

exit 0
`;

export async function installCodexIdentityHook(): Promise<{
  scriptInstalled: boolean;
  hookWired: boolean;
  reason: string;
}> {
  const codexHome = getCodexHome();
  if (!existsSync(codexHome)) {
    return { scriptInstalled: false, hookWired: false, reason: "codex not installed" };
  }

  const hiveHome = join(process.env.HOME || "", ".hive");
  const hookScriptPath = join(hiveHome, "codex-load-identity.sh");

  let scriptInstalled = false;
  if (!existsSync(hookScriptPath) || (await Bun.file(hookScriptPath).text()) !== CODEX_HOOK_SCRIPT) {
    await Bun.write(hookScriptPath, CODEX_HOOK_SCRIPT);
    await chmod(hookScriptPath, 0o755);
    scriptInstalled = true;
  }

  const hooksJsonPath = join(codexHome, "hooks.json");
  let config: CodexHooksConfig = { hooks: {} };
  if (existsSync(hooksJsonPath)) {
    try {
      config = JSON.parse(await Bun.file(hooksJsonPath).text()) as CodexHooksConfig;
    } catch {
      return { scriptInstalled, hookWired: false, reason: "~/.codex/hooks.json is malformed" };
    }
  }

  config.hooks = config.hooks ?? {};
  const sessionStart = config.hooks.SessionStart ?? [];

  const alreadyWired = sessionStart.some((entry) =>
    entry.hooks?.some((h) => h.command === hookScriptPath),
  );

  let hookWired = false;
  if (!alreadyWired) {
    sessionStart.push({
      hooks: [{ type: "command", command: hookScriptPath, timeout: 5 }],
    });
    config.hooks.SessionStart = sessionStart;
    await Bun.write(hooksJsonPath, JSON.stringify(config, null, 2) + "\n");
    hookWired = true;
  }

  return {
    scriptInstalled,
    hookWired,
    reason: scriptInstalled || hookWired ? "wired" : "already wired",
  };
}

// ---------------------------------------------------------------------------
// Top-level wiring entry point used by `hive init` and `hive doctor`
// ---------------------------------------------------------------------------

export interface CodexWireResult {
  detected: boolean;
  mcpAdded: boolean;
  mcpAlreadyRegistered: boolean;
  agentsMdWritten: boolean;
  hookScriptInstalled: boolean;
  hookWired: boolean;
}

export async function wireCodex(opts: {
  identity: string;
  mcpBinPath: string;
}): Promise<CodexWireResult> {
  const result: CodexWireResult = {
    detected: false,
    mcpAdded: false,
    mcpAlreadyRegistered: false,
    agentsMdWritten: false,
    hookScriptInstalled: false,
    hookWired: false,
  };

  if (!isCodexInstalled() || !existsSync(getCodexHome())) {
    return result;
  }
  result.detected = true;

  const mcp = await registerCodexHiveMcp(opts.mcpBinPath);
  result.mcpAdded = mcp.added;
  result.mcpAlreadyRegistered = mcp.alreadyRegistered;

  const agents = await writeCodexAgentsMd(opts.identity);
  result.agentsMdWritten = agents.written;

  const hook = await installCodexIdentityHook();
  result.hookScriptInstalled = hook.scriptInstalled;
  result.hookWired = hook.hookWired;

  return result;
}
