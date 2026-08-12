import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import { campaignCommand } from "./commands/campaign";
import { contextCommand } from "./commands/context";
import { councilCommand } from "./commands/council";
import { dashboardCommand } from "./commands/dashboard";
import { dispatchCommand } from "./commands/dispatch";
import { doctorCommand } from "./commands/doctor";
import { goalCommand } from "./commands/goal";
import { heartbeatCommand } from "./commands/heartbeat";
import { identityCommand } from "./commands/identity";
import { inboxCommand } from "./commands/inbox";
import { initCommand } from "./commands/init";
import { killCommand } from "./commands/kill";
import { memoryCommand } from "./commands/memory";
import { tasteCommand } from "./commands/taste";
import { projectCommand } from "./commands/project";
import { psCommand } from "./commands/ps";
import { stackCommand } from "./commands/stack";
import { ticketCommand } from "./commands/ticket";
import { watchCommand } from "./commands/watch";
import { UsageError } from "./lib/errors";
import { resolveHarness, type ClaudeMode, type Harness } from "./lib/harness";
import { writeCodexAgentsMd } from "./lib/codex-wire";
import { getIdentityName, assembleIdentity } from "./lib/identity";
import { findPiBin } from "./lib/pi-wire";

const hiveCommands: Record<string, (args: string[]) => Promise<void>> = {
  init: initCommand,
  doctor: doctorCommand,
  context: contextCommand,
  prompts: contextCommand,
  project: projectCommand,
  stack: stackCommand,
  campaign: campaignCommand,
  council: councilCommand,
  memory: memoryCommand,
  taste: tasteCommand,
  ticket: ticketCommand,
  goal: goalCommand,
  dispatch: dispatchCommand,
  heartbeat: heartbeatCommand,
  identity: identityCommand,
  inbox: inboxCommand,
  kill: killCommand,
  ps: psCommand,
  dashboard: dashboardCommand,
  watch: watchCommand,
};

function getUsage(): string {
  const name = getIdentityName();
  return `Usage: hive [command] [args]

When called with a HIVE command, runs that command directly.
When called with anything else (or no args), launches an interactive harness as ${name}.

HIVE Commands:
  init                       Set up ~/.hive and register MCP server
  doctor                     Validate installation health
  context                    Audit session-start context size vs budgets (alias: prompts)
  project add <name> <path>  Register a project (--bootstrap to scan)
  project bootstrap [name]   Scan repo and seed candidate facts
  stack list|install|sync    Manage language/framework skill stacks
  council "<question>"       Multi-model council deliberation
  memory [view|fact|...]     View or add project memory
  taste extract [opts]       Mine taste candidates from transcripts (phase 1)
  ticket [create|list|...]   Project ticket tracker
  goal "<rough goal>"        Decompose a rough goal into epic + child tickets
  campaign run|list|show     Long-horizon campaign orchestration
  dispatch "<goal>" [opts]   Dispatch autonomous goal execution
  heartbeat start|stop|...   Periodic project awareness
  watch list|status|run|...  Standing-question watches (ambient passes)
  identity emit              Print canonical identity prefix (used by SessionStart hook)
  inbox                      Show project inbox (clear with: inbox clear)
  kill <run-id>              Kill a running dispatch
  ps                         Show active and recent dispatch runs
  dashboard [build|open]     Build or open the Morning Edition dashboard

${name} (default: Claude Code with identity):
  hive                       Interactive ${name} session
  hive "fix the auth bug"    ${name} with a prompt
  hive --agent maya-coder    ${name} with a specific agent
  hive [any claude flags]    Passed through to claude with identity

Claude Code identity modes:
  (default)                  Append HIVE identity after Claude Code's base prompt (OAuth)
  hive --owned [prompt]      Replace base prompt with HIVE identity; keep hooks/MCP/OAuth
  hive --bare [prompt]       Full --bare; HIVE owns prompt, MCP rewired explicitly.
                             Requires ANTHROPIC_API_KEY (no subscription OAuth in --bare).
  HIVE_CLAUDE_MODE=owned     Set --owned via env
  HIVE_CLAUDE_MODE=bare      Set --bare via env

Alt harness:
  hive -3 [prompt]          Route through Pi CLI (Pi owns provider/model selection)
  hive -x [prompt]           Route through Codex CLI (ChatGPT subscription)
  HIVE_HARNESS=pi hive       Same as -3, via env
  HIVE_HARNESS=codex hive    Same as -x, via env (use --claude to override)

Persona (swappable register/voice, interactive only):
  hive --persona <name>      Load ~/.hive/personas/<name>.md (default: greg-dry)
  HIVE_PERSONA=<name> hive    Same, via env`;
}

function findClaude(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    // intentional: `which claude` not on PATH — try known fallback
    const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not find claude CLI. Is it installed?");
  }
}

function findCodex(): string {
  if (process.env.HIVE_CODEX_BIN) return process.env.HIVE_CODEX_BIN;
  try {
    return execSync("which codex", { encoding: "utf-8" }).trim();
  } catch {
    // intentional: `which codex` not on PATH — try known fallback
    const fallback = join(process.env.HOME || "", ".local", "bin", "codex");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not find codex CLI. Is it installed?");
  }
}

function findPi(): string {
  const pi = findPiBin();
  if (pi) return pi;
  throw new Error("Could not find pi CLI. Install Pi or set HIVE_PI_BIN.");
}

async function writePiIdentityExtensionTempFile(persona?: string): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `hive-pi-ext-${process.pid}-`));
  const identity = await assembleIdentity({ includePersona: true, persona });
  const identityB64 = Buffer.from(identity, "utf-8").toString("base64");
  const source = [
    "// Generated by hive launcher. Do not edit.",
    'import { Buffer } from "node:buffer";',
    "",
    `const IDENTITY_B64 = "${identityB64}";`,
    'const identityText = Buffer.from(IDENTITY_B64, "base64").toString("utf-8");',
    "",
    "export default function hiveIdentityExtension(pi) {",
    '  pi.on("before_agent_start", async (event) => ({',
    '    systemPrompt: identityText + "\\n\\n---\\n\\n" + event.systemPrompt,',
    "  }));",
    "}",
    "",
  ].join("\n");

  const path = join(dir, "identity.ts");
  await writeFile(path, source, "utf-8");
  return { path, dir };
}

async function cleanupPiIdentityExtensionTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* intentional: best-effort temp dir cleanup */
  }
}

async function writeBareMcpConfigTempFile(): Promise<{ path: string; dir: string }> {
  // In --bare mode Claude Code skips MCP auto-discovery from ~/.claude.json.
  // Re-register HIVE MCP (and only HIVE MCP) via --mcp-config so HIVE tools
  // remain reachable. Path matches the canonical registration in init.ts.
  const dir = await mkdtemp(join(tmpdir(), `hive-bare-mcp-${process.pid}-`));
  const repoRoot = join(import.meta.dir, "..");
  const config = {
    mcpServers: {
      hive: {
        type: "stdio",
        command: "bun",
        args: [join(repoRoot, "src", "mcp-server.ts")],
      },
    },
  };
  const path = join(dir, "mcp.json");
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
  return { path, dir };
}

async function launchClaude(mode: ClaudeMode, args: string[], persona?: string): Promise<void> {
  const identity = await assembleIdentity({ includePersona: true, persona });

  let bareMcpDir: string | null = null;
  const cleanup = () => {
    if (bareMcpDir) {
      try { require("fs").rmSync(bareMcpDir, { recursive: true, force: true }); } catch { /* intentional: best-effort temp dir cleanup */ }
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  const claude = findClaude();

  // Build claude args based on mode.
  const claudeArgs: string[] = [];
  const env: Record<string, string | undefined> = { ...process.env };
  // Propagate the chosen persona so any SessionStart hook re-emit matches the
  // identity we just built (the hook reads HIVE_PERSONA).
  if (persona) env.HIVE_PERSONA = persona;

  if (mode === "bare") {
    // --bare requires ANTHROPIC_API_KEY (OAuth + keychain are never read).
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        "hive --bare: ANTHROPIC_API_KEY is required.\n" +
        "  --bare mode skips OAuth/keychain entirely (Claude Code's design).\n" +
        "  Set ANTHROPIC_API_KEY or drop --bare to use subscription OAuth."
      );
      cleanup();
      process.exit(1);
    }
    const bareMcp = await writeBareMcpConfigTempFile();
    bareMcpDir = bareMcp.dir;
    claudeArgs.push(
      "--bare",
      "--system-prompt", identity,
      "--mcp-config", bareMcp.path,
      "--add-dir", join(process.env.HOME || "", ".hive"),
    );
  } else if (mode === "owned") {
    // Replace the default system prompt; keep hooks/plugins/MCP/OAuth.
    claudeArgs.push(
      "--system-prompt", identity,
      "--add-dir", join(process.env.HOME || "", ".hive"),
    );
    env.ANTHROPIC_API_KEY = undefined; // force subscription
    // Identity is already in the system prompt above; tell the SessionStart/
    // PostCompact hook to skip its context emit so we don't duplicate ~63KB
    // every turn. A plain claude session (no env var) still gets the hook.
    env.HIVE_IDENTITY_IN_PROMPT = "1";
  } else {
    // append: legacy default — HIVE identity sits AFTER the base system prompt.
    claudeArgs.push(
      "--append-system-prompt", identity,
      "--add-dir", join(process.env.HOME || "", ".hive"),
    );
    env.ANTHROPIC_API_KEY = undefined; // force subscription
    // Identity is already in the system prompt above; tell the SessionStart/
    // PostCompact hook to skip its context emit so we don't duplicate ~63KB
    // every turn. A plain claude session (no env var) still gets the hook.
    env.HIVE_IDENTITY_IN_PROMPT = "1";
  }

  claudeArgs.push(...args);

  const result = Bun.spawnSync([claude, ...claudeArgs], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  cleanup();
  process.exit(result.exitCode ?? 0);
}

async function launchCodex(args: string[], persona?: string): Promise<void> {
  const codex = findCodex();

  // Codex auto-loads ~/.codex/AGENTS.md natively. Refresh it from the current
  // cwd before spawning so project memory/stack context cannot lag behind the
  // last direct Codex session.
  const identity = await assembleIdentity({ includePersona: true, persona });
  const agents = await writeCodexAgentsMd(identity);
  if (!agents.written && agents.reason !== "unchanged") {
    console.error(`hive: could not refresh Codex AGENTS.md (${agents.reason})`);
  }

  const result = Bun.spawnSync([codex, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      OPENAI_API_KEY: undefined, // force ChatGPT subscription
      HIVE_PERSONA: persona ?? process.env.HIVE_PERSONA,
    },
  });

  process.exit(result.exitCode ?? 0);
}

async function launchPi(args: string[], persona?: string): Promise<void> {
  const pi = findPi();
  const extension = await writePiIdentityExtensionTempFile(persona);

  const cleanup = () => {
    void cleanupPiIdentityExtensionTempDir(extension.dir);
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  const result = Bun.spawnSync([pi, "-e", extension.path, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
    },
  });

  await cleanupPiIdentityExtensionTempDir(extension.dir);
  process.exit(result.exitCode ?? 0);
}

async function launchAgent(harness: Harness, claudeMode: ClaudeMode, args: string[], persona?: string): Promise<void> {
  if (harness === "pi") {
    if (claudeMode !== "append") {
      console.error("hive: --owned/--bare only apply to Claude Code; ignored for Pi.");
    }
    await launchPi(args, persona);
    return;
  }
  if (harness === "codex") {
    if (claudeMode !== "append") {
      console.error("hive: --owned/--bare only apply to Claude Code; ignored for Codex.");
    }
    await launchCodex(args, persona);
    return;
  }
  await launchClaude(claudeMode, args, persona);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // No args → interactive session via default harness
  if (!command) {
    const { harness, claudeMode, persona, remainingArgs } = resolveHarness([]);
    await launchAgent(harness, claudeMode, remainingArgs, persona);
    return;
  }

  // Help
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(getUsage());
    return;
  }

  // Known HIVE command → handle directly
  const handler = hiveCommands[command];
  if (handler) {
    try {
      await handler(args.slice(1));
    } catch (error) {
      if (error instanceof UsageError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  // Everything else → pass through to a harness with identity.
  const { harness, claudeMode, persona, remainingArgs } = resolveHarness(args);
  await launchAgent(harness, claudeMode, remainingArgs, persona);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
