import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { councilCommand } from "./commands/council";
import { dashboardCommand } from "./commands/dashboard";
import { dispatchCommand } from "./commands/dispatch";
import { doctorCommand } from "./commands/doctor";
import { heartbeatCommand } from "./commands/heartbeat";
import { identityCommand } from "./commands/identity";
import { inboxCommand } from "./commands/inbox";
import { initCommand } from "./commands/init";
import { killCommand } from "./commands/kill";
import { memoryCommand } from "./commands/memory";
import { projectCommand } from "./commands/project";
import { psCommand } from "./commands/ps";
import { stackCommand } from "./commands/stack";
import { ticketCommand } from "./commands/ticket";
import { UsageError } from "./lib/errors";
import { resolveHarness, type Harness } from "./lib/harness";
import {
  writeIdentityTempFile,
  cleanupIdentityTempFile,
  getIdentityName,
} from "./lib/identity";

const hiveCommands: Record<string, (args: string[]) => Promise<void>> = {
  init: initCommand,
  doctor: doctorCommand,
  project: projectCommand,
  stack: stackCommand,
  council: councilCommand,
  memory: memoryCommand,
  ticket: ticketCommand,
  dispatch: dispatchCommand,
  heartbeat: heartbeatCommand,
  identity: identityCommand,
  inbox: inboxCommand,
  kill: killCommand,
  ps: psCommand,
  dashboard: dashboardCommand,
};

function getUsage(): string {
  const name = getIdentityName();
  return `Usage: hive [command] [args]

When called with a HIVE command, runs that command directly.
When called with anything else (or no args), launches Claude as ${name}.

HIVE Commands:
  init                       Set up ~/.hive and register MCP server
  doctor                     Validate installation health
  project add <name> <path>  Register a project
  stack list|install|sync    Manage language/framework skill stacks
  council "<question>"       Multi-model council deliberation
  memory [view|fact|...]     View or add project memory
  ticket [create|list|...]   Project ticket tracker
  dispatch "<goal>" [opts]   Dispatch autonomous goal execution
  heartbeat start|stop|...   Periodic project awareness
  identity emit              Print canonical identity prefix (used by SessionStart hook)
  inbox                      Show project inbox (clear with: inbox clear)
  kill <run-id>              Kill a running dispatch
  ps                         Show active and recent dispatch runs
  dashboard [build|open]     Build or open the Morning Edition dashboard

${name} (Claude with identity):
  hive                       Interactive ${name} session
  hive "fix the auth bug"    ${name} with a prompt
  hive --agent maya-coder    ${name} with a specific agent
  hive [any claude flags]    Passed through to claude with identity

Alt harness:
  hive -x [prompt]           Route through Codex CLI (ChatGPT subscription)
  HIVE_HARNESS=codex hive    Same, via env (use --claude to override)`;
}

function findClaude(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
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
    const fallback = join(process.env.HOME || "", ".local", "bin", "codex");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not find codex CLI. Is it installed?");
  }
}


async function launchClaude(args: string[]): Promise<void> {
  const identityFile = await writeIdentityTempFile();

  // Clean up on exit
  process.on("exit", cleanupIdentityTempFile);
  process.on("SIGINT", () => { cleanupIdentityTempFile(); process.exit(130); });
  process.on("SIGTERM", () => { cleanupIdentityTempFile(); process.exit(143); });

  const claude = findClaude();

  // Build claude args: identity injection + user args
  const claudeArgs = [
    "--append-system-prompt-file", identityFile,
    "--add-dir", join(process.env.HOME || "", ".hive"),
    ...args,
  ];

  // Replace this process with claude
  const result = Bun.spawnSync([claude, ...claudeArgs], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: undefined, // force subscription
    },
  });

  cleanupIdentityTempFile();
  process.exit(result.exitCode ?? 0);
}

async function launchCodex(args: string[]): Promise<void> {
  const codex = findCodex();

  // Identity flows through ~/.codex/AGENTS.md (written by `hive init` and
  // refreshed by the SessionStart hook at ~/.hive/codex-load-identity.sh).
  // Codex auto-loads AGENTS.md natively — no per-invocation injection needed,
  // which preserves Codex's prefix cache across sessions.

  const result = Bun.spawnSync([codex, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      OPENAI_API_KEY: undefined, // force ChatGPT subscription
    },
  });

  process.exit(result.exitCode ?? 0);
}

async function launchAgent(harness: Harness, args: string[]): Promise<void> {
  if (harness === "codex") {
    await launchCodex(args);
    return;
  }
  await launchClaude(args);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // No args → interactive session via default harness
  if (!command) {
    const { harness, remainingArgs } = resolveHarness([]);
    await launchAgent(harness, remainingArgs);
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
  const { harness, remainingArgs } = resolveHarness(args);
  await launchAgent(harness, remainingArgs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
