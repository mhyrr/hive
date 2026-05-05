import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import {
  getCodexHome,
  getRegisteredCodexHiveMcp,
  isCodexInstalled,
} from "../lib/codex-wire";
import { LOAD_IDENTITY_HOOK } from "../lib/identity-hook-template";
import { getHivePaths, listProjects } from "../lib/paths";
import {
  getPiMcpConfigPath,
  getRegisteredPiHiveMcp,
  hasPiMcpAdapterConfigured,
  isPiInstalled,
} from "../lib/pi-wire";
import { resolveProjectFromCwd } from "../lib/project";
import { getTastePaths } from "../lib/taste";

type Status = "pass" | "warn" | "fail";
type Check = { status: Status; label: string; detail?: string };

function run(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function binaryVersion(name: string): string | null {
  const path = run(`which ${name}`);
  if (!path) return null;
  const version = run(`${name} --version 2>/dev/null`) ?? run(`${name} -v 2>/dev/null`);
  return version?.split("\n")[0] ?? "found";
}

// ---------------------------------------------------------------------------
// Check groups
// ---------------------------------------------------------------------------

function checkCore(): Check[] {
  const checks: Check[] = [];

  // bun
  const bunV = binaryVersion("bun");
  checks.push(bunV
    ? { status: "pass", label: `bun ${bunV}` }
    : { status: "fail", label: "bun not found", detail: "Install: https://bun.sh/" });

  // claude
  const claudeV = binaryVersion("claude");
  checks.push(claudeV
    ? { status: "pass", label: `claude ${claudeV}` }
    : { status: "fail", label: "claude CLI not found", detail: "Install: https://claude.ai/claude-code" });

  // hive-mcp — check symlink or source file
  const mcpBin = join(process.env.HOME || "", ".local", "bin", "hive-mcp");
  const mcpSource = join(process.cwd(), "src", "mcp-server.ts");
  if (existsSync(mcpBin)) {
    checks.push({ status: "pass", label: "hive-mcp binary" });
  } else if (existsSync(mcpSource)) {
    checks.push({ status: "pass", label: "hive-mcp source" });
  } else {
    checks.push({ status: "warn", label: "hive-mcp not found", detail: `Expected binary at ${mcpBin} or source at ${mcpSource}` });
  }

  // codex (optional — alt harness for `hive -x`)
  const codexV = binaryVersion("codex");
  if (codexV) {
    checks.push({ status: "pass", label: `codex ${codexV}` });
  }

  // pi (optional — alt harness for `hive -3`)
  const piV = binaryVersion("pi");
  if (piV) {
    checks.push({ status: "pass", label: `pi ${piV}` });
  }

  return checks;
}

async function checkPi(): Promise<Check[]> {
  const checks: Check[] = [];

  if (!isPiInstalled()) {
    checks.push({ status: "pass", label: "pi CLI not installed (skipping)", detail: "Optional alt harness; install pi to use `hive -3`." });
    return checks;
  }

  const registered = await getRegisteredPiHiveMcp();
  if (registered) {
    const cmdExists = existsSync(registered.command) || run(`which ${registered.command}`) !== null;
    checks.push(cmdExists
      ? { status: "pass", label: "hive registered in ~/.pi/agent/mcp.json" }
      : { status: "fail", label: `Pi MCP command missing: ${registered.command}` });
  } else {
    checks.push({
      status: "warn",
      label: "hive not registered in ~/.pi/agent/mcp.json",
      detail: `Run: hive init. Config path: ${getPiMcpConfigPath()}`,
    });
  }

  if (await hasPiMcpAdapterConfigured()) {
    checks.push({ status: "pass", label: "pi-mcp-adapter configured" });
  } else {
    checks.push({
      status: "warn",
      label: "pi-mcp-adapter not configured",
      detail: "Run: pi install npm:pi-mcp-adapter",
    });
  }

  return checks;
}

async function checkCodex(): Promise<Check[]> {
  const checks: Check[] = [];

  if (!isCodexInstalled()) {
    checks.push({ status: "pass", label: "codex CLI not installed (skipping)", detail: "Optional alt harness; install codex to use `hive -x`." });
    return checks;
  }

  const codexHome = getCodexHome();
  if (!existsSync(codexHome)) {
    checks.push({ status: "warn", label: "~/.codex/ not found", detail: "Run `codex login` once to initialize, then `hive init`." });
    return checks;
  }

  // MCP registration
  const registered = await getRegisteredCodexHiveMcp();
  if (registered) {
    const cmdExists = existsSync(registered) || run(`which ${registered}`) !== null;
    checks.push(cmdExists
      ? { status: "pass", label: "hive registered in ~/.codex/config.toml" }
      : { status: "fail", label: `Codex MCP command missing: ${registered}` });
  } else {
    checks.push({ status: "warn", label: "hive not registered in ~/.codex/config.toml", detail: "Run: hive init" });
  }

  // AGENTS.md
  const agentsPath = join(codexHome, "AGENTS.md");
  if (existsSync(agentsPath) && statSync(agentsPath).size > 0) {
    checks.push({ status: "pass", label: "~/.codex/AGENTS.md present" });
  } else {
    checks.push({ status: "warn", label: "~/.codex/AGENTS.md missing or empty", detail: "Run: hive init" });
  }

  // Hook script + wiring
  const hookScript = join(process.env.HOME || "", ".hive", "codex-load-identity.sh");
  const hooksJson = join(codexHome, "hooks.json");

  if (!existsSync(hookScript)) {
    checks.push({ status: "warn", label: "Codex identity hook script missing", detail: `Expected at ${hookScript}` });
  } else if (!existsSync(hooksJson)) {
    checks.push({ status: "warn", label: "~/.codex/hooks.json missing", detail: "Run: hive init" });
  } else {
    try {
      const config = JSON.parse(readFileSync(hooksJson, "utf-8"));
      const sessionStart = config.hooks?.SessionStart ?? [];
      const wired = sessionStart.some((entry: { hooks?: Array<{ command?: string }> }) =>
        entry.hooks?.some((h) => h.command === hookScript),
      );
      checks.push(wired
        ? { status: "pass", label: "SessionStart hook wired in ~/.codex/hooks.json" }
        : { status: "warn", label: "Codex SessionStart hook not wired", detail: "Run: hive init" });
    } catch {
      checks.push({ status: "fail", label: "~/.codex/hooks.json is malformed" });
    }
  }

  return checks;
}

function checkIdentity(): Check[] {
  const checks: Check[] = [];
  const paths = getHivePaths();

  if (!existsSync(paths.home)) {
    checks.push({ status: "fail", label: "~/.hive/ not found", detail: "Run: hive init" });
    return checks;
  }
  checks.push({ status: "pass", label: "~/.hive/ scaffold" });

  const identityFiles = [
    { key: "SOUL.md", path: paths.soul },
    { key: "IDENTITY.md", path: paths.identity },
    { key: "SELF.md", path: paths.self },
    { key: "AGENTS.md", path: paths.agents },
    { key: "TRUST.md", path: paths.trust },
  ];

  const present = identityFiles.filter(f => existsSync(f.path));
  const missing = identityFiles.filter(f => !existsSync(f.path));

  if (missing.length === 0) {
    checks.push({ status: "pass", label: "5/5 identity files" });
  } else {
    checks.push({
      status: "fail",
      label: `${present.length}/5 identity files`,
      detail: `Missing: ${missing.map(f => f.key).join(", ")}`,
    });
  }

  // OVERRIDES.md was retired — pre-fetch directive moved into AGENTS.md.
  // If a stale file is still on disk, surface a one-line cleanup nudge.
  if (existsSync(paths.overrides)) {
    checks.push({
      status: "warn",
      label: "OVERRIDES.md present but no longer loaded",
      detail: `Safe to delete: rm ${paths.overrides}`,
    });
  }

  // Canonical SessionStart hook at user level
  const home = process.env.HOME || "";
  const hookPath = join(home, ".claude", "hooks", "load-identity.sh");
  if (existsSync(hookPath)) {
    try {
      const st = statSync(hookPath);
      const isExec = (st.mode & 0o111) !== 0;
      if (isExec) {
        checks.push({ status: "pass", label: "~/.claude/hooks/load-identity.sh" });
      } else {
        checks.push({
          status: "warn",
          label: "load-identity.sh not executable",
          detail: `Run: chmod +x ${hookPath}`,
        });
      }

      // Drift guard: live hook must byte-match the canonical template that
      // ships with this `hive` binary. The hook delegates identity assembly
      // to the binary, so a stale live hook means the install is out of date.
      try {
        const liveContent = readFileSync(hookPath, "utf-8");
        if (liveContent === LOAD_IDENTITY_HOOK) {
          checks.push({ status: "pass", label: "load-identity.sh matches canonical template (no drift)" });
        } else {
          checks.push({
            status: "warn",
            label: "load-identity.sh drifted from canonical template",
            detail: `Live hook differs from this binary's canonical template. Run: hive init --force-hook`,
          });
        }
      } catch {
        checks.push({ status: "warn", label: "could not read live hook for drift check" });
      }
    } catch {
      checks.push({ status: "warn", label: "load-identity.sh unreadable" });
    }
  } else {
    checks.push({
      status: "fail",
      label: "load-identity.sh missing",
      detail: `Expected at ${hookPath}. Run: hive init`,
    });
  }

  // Hook wired in ~/.claude/settings.json for SessionStart + PostCompact
  const settingsPath = join(home, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const events = ["SessionStart", "PostCompact"] as const;
      const missingEvents: string[] = [];
      for (const event of events) {
        const entries = settings.hooks?.[event] ?? [];
        const wired = entries.some((e: { hooks?: Array<{ command?: string }> }) =>
          e.hooks?.some((h) => h.command === hookPath),
        );
        if (!wired) missingEvents.push(event);
      }
      if (missingEvents.length === 0) {
        checks.push({ status: "pass", label: "hook wired in SessionStart + PostCompact" });
      } else {
        checks.push({
          status: "fail",
          label: `hook not wired in ${missingEvents.join(", ")}`,
          detail: "Run: hive init (re-wires hooks without overwriting other settings)",
        });
      }
    } catch {
      checks.push({
        status: "warn",
        label: "~/.claude/settings.json malformed — cannot verify hook wiring",
      });
    }
  } else {
    checks.push({
      status: "warn",
      label: "~/.claude/settings.json absent — hook wiring unverifiable",
    });
  }

  // Claude Code version ≥ 2.1.x (where the hook event set was stabilized)
  const version = run("claude --version 2>/dev/null");
  if (version) {
    const match = version.match(/(\d+)\.(\d+)\.\d+/);
    if (match) {
      const major = parseInt(match[1]!, 10);
      const minor = parseInt(match[2]!, 10);
      const meets = major > 2 || (major === 2 && minor >= 1);
      if (meets) {
        checks.push({ status: "pass", label: `claude-code ${match[0]}` });
      } else {
        checks.push({
          status: "warn",
          label: `claude-code ${match[0]} (pre-2.1.x)`,
          detail: "HIVE identity injection tuned for 2.1.x+ hook events",
        });
      }
    }
  }

  return checks;
}

async function checkStaleClaudeMd(): Promise<Check[]> {
  const checks: Check[] = [];
  const paths = getHivePaths();

  if (!existsSync(paths.projectsDir)) return checks;

  const projects = await listProjects(paths.projectsDir);
  for (const projectId of projects) {
    const configPath = join(paths.projectsDir, projectId, "config.md");
    if (!existsSync(configPath)) continue;

    const config = readFileSync(configPath, "utf-8");
    const pathMatch = config.match(/^path:\s*(.+)$/m);
    if (!pathMatch) continue;
    const projectPath = pathMatch[1]!.trim();

    const claudeMd = join(projectPath, "CLAUDE.md");
    if (!existsSync(claudeMd)) continue;

    const content = readFileSync(claudeMd, "utf-8");
    if (content.includes("Read and internalize") && content.includes("~/.hive/")) {
      checks.push({
        status: "warn",
        label: `${projectId}: stale identity block in CLAUDE.md`,
        detail: `${claudeMd} still has "Read and internalize ~/.hive/" — redundant with canonical hook. Safe to delete.`,
      });
    }
  }

  if (checks.length === 0) {
    checks.push({ status: "pass", label: "no stale identity blocks in registered CLAUDE.md files" });
  }

  return checks;
}

function checkTaste(): Check[] {
  const checks: Check[] = [];
  const paths = getTastePaths();

  if (!existsSync(paths.root)) {
    // Optional layer; absence is not a failure.
    checks.push({
      status: "warn",
      label: "taste/ not configured",
      detail: `Optional. Drop principles into ${paths.principles} to enable.`,
    });
    return checks;
  }

  if (existsSync(paths.principles)) {
    checks.push({ status: "pass", label: "taste/principles.md" });
  } else {
    checks.push({
      status: "warn",
      label: "taste/ exists but principles.md missing",
      detail: `Layer won't load until ${paths.principles} is present.`,
    });
  }


  return checks;
}

function checkMcp(): Check[] {
  const checks: Check[] = [];
  const mcpConfigPath = join(process.env.HOME || "", ".claude.json");

  if (!existsSync(mcpConfigPath)) {
    checks.push({ status: "fail", label: "~/.claude.json not found" });
    return checks;
  }

  try {
    const config = JSON.parse(require("fs").readFileSync(mcpConfigPath, "utf-8"));
    const servers = config.mcpServers ?? {};

    if (!servers.hive) {
      checks.push({ status: "fail", label: "hive not registered in ~/.claude.json", detail: "Run: hive init" });
      return checks;
    }

    checks.push({ status: "pass", label: "hive registered in ~/.claude.json" });

    // Validate the MCP command is resolvable
    const mcpCommand = servers.hive.command as string;
    const mcpArgs = (servers.hive.args ?? []) as string[];
    const cmdExists = mcpCommand && (existsSync(mcpCommand) || run(`which ${mcpCommand}`) !== null);

    if (cmdExists) {
      // If args reference a file, check it exists too
      const firstArg = mcpArgs[0];
      if (firstArg && firstArg.endsWith(".ts") && !existsSync(firstArg)) {
        checks.push({ status: "fail", label: `MCP source missing`, detail: `${firstArg} not found` });
      } else {
        const label = firstArg ? `${mcpCommand} ${firstArg}` : mcpCommand;
        checks.push({ status: "pass", label: `MCP command: ${label}` });
      }
    } else {
      checks.push({ status: "fail", label: `MCP command not found: ${mcpCommand}` });
    }
  } catch {
    checks.push({ status: "fail", label: "~/.claude.json is malformed" });
  }

  return checks;
}

function checkModels(): Check[] {
  const checks: Check[] = [];

  // claude auth — check if claude can respond
  const claudeAuth = run("claude --version");
  checks.push(claudeAuth
    ? { status: "pass", label: "claude" }
    : { status: "warn", label: "claude auth unclear" });

  // codex
  const codexPath = run("which codex");
  checks.push(codexPath
    ? { status: "pass", label: "codex" }
    : { status: "warn", label: "codex not found", detail: "Council will skip OpenAI models" });

  // gemini
  const geminiPath = run("which gemini");
  checks.push(geminiPath
    ? { status: "pass", label: "gemini" }
    : { status: "warn", label: "gemini not found", detail: "Council will skip Gemini models" });

  // ollama
  const ollamaPath = run("which ollama");
  if (ollamaPath) {
    const ollamaRunning = run("ollama list 2>/dev/null");
    checks.push(ollamaRunning
      ? { status: "pass", label: "ollama (running)" }
      : { status: "warn", label: "ollama installed but not running" });
  } else {
    checks.push({ status: "warn", label: "ollama not found", detail: "Council will skip local models" });
  }

  return checks;
}

function checkScheduler(): Check[] {
  const checks: Check[] = [];
  const plists = [
    "com.hive.heartbeat",
    "com.hive.nightly",
    "com.hive.sync",
    "com.hive.dashboard",
  ];

  const launchAgentsDir = join(process.env.HOME || "", "Library", "LaunchAgents");
  const loadedList = run("launchctl list") ?? "";

  for (const plist of plists) {
    const plistFile = join(launchAgentsDir, `${plist}.plist`);
    const installed = existsSync(plistFile);
    const loaded = loadedList.includes(plist);

    if (installed && loaded) {
      checks.push({ status: "pass", label: `${plist} (loaded)` });
    } else if (installed && !loaded) {
      checks.push({ status: "warn", label: `${plist} (installed, not loaded)`, detail: `Run: launchctl load ${plistFile}` });
    } else {
      checks.push({ status: "warn", label: `${plist} not installed`, detail: "Run: hive init" });
    }
  }

  return checks;
}

async function checkProject(): Promise<{ heading: string; checks: Check[] }> {
  const paths = getHivePaths();
  const checks: Check[] = [];
  const cwd = process.cwd();

  if (!existsSync(paths.projectsDir)) {
    return { heading: "Project", checks: [{ status: "warn", label: "No projects directory" }] };
  }

  const projectId = resolveProjectFromCwd();

  if (!projectId) {
    // List registered projects for context
    const projects = await listProjects(paths.projectsDir);
    return {
      heading: "Project",
      checks: [{
        status: "warn",
        label: "No project matches current directory",
        detail: projects.length > 0
          ? `Registered: ${projects.join(", ")}. Run from a project directory.`
          : "No projects registered. Run: hive project add <name> <path>",
      }],
    };
  }

  checks.push({ status: "pass", label: `resolved from ${cwd}` });

  // Memory
  const knowledgePath = join(paths.memoryProjectsDir, projectId, "knowledge.md");
  const indexPath = join(paths.memoryProjectsDir, projectId, "_index.md");
  if (existsSync(knowledgePath)) {
    checks.push({ status: "pass", label: `memory/projects/${projectId}/knowledge.md` });
  } else {
    checks.push({ status: "warn", label: "knowledge.md missing", detail: "Memory won't persist" });
  }
  if (existsSync(indexPath)) {
    checks.push({ status: "pass", label: `_index.md present` });
  } else {
    checks.push({ status: "warn", label: "_index.md missing", detail: "Session start won't have memory summary" });
  }

  // Heartbeat
  const heartbeatJson = join(paths.projectsDir, projectId, "heartbeat.json");
  if (existsSync(heartbeatJson)) {
    try {
      const config = JSON.parse(require("fs").readFileSync(heartbeatJson, "utf-8"));
      const state = config.enabled ? `enabled (${config.intervalMinutes}m)` : "disabled";
      checks.push({ status: "pass", label: `heartbeat ${state}` });
    } catch {
      checks.push({ status: "warn", label: "heartbeat.json malformed" });
    }
  } else {
    checks.push({ status: "warn", label: "no heartbeat config" });
  }

  // HEARTBEAT.md
  const heartbeatMd = join(paths.projectsDir, projectId, "HEARTBEAT.md");
  if (!existsSync(heartbeatMd)) {
    checks.push({ status: "warn", label: "HEARTBEAT.md missing", detail: "Heartbeat has no standing orders" });
  }

  return { heading: `Project (${projectId})`, checks };
}

function checkBuild(): Check[] {
  const checks: Check[] = [];
  const hiveBin = join(process.cwd(), "hive-bin");

  if (!existsSync(hiveBin)) {
    // Not in the hive repo — skip this section
    return [];
  }

  const binStat = statSync(hiveBin);
  const binMtime = binStat.mtimeMs;

  // Find newest source file
  let newestSource = 0;
  let newestFile = "";
  function scanDir(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
          scanDir(full);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const mtime = statSync(full).mtimeMs;
          if (mtime > newestSource) {
            newestSource = mtime;
            newestFile = full;
          }
        }
      }
    } catch { /* skip */ }
  }

  scanDir(join(process.cwd(), "src"));

  if (newestSource > binMtime) {
    const delta = Math.round((newestSource - binMtime) / 60000);
    const unit = delta >= 60 ? `${Math.round(delta / 60)}h` : `${delta}m`;
    checks.push({
      status: "warn",
      label: `hive-bin is stale (source newer by ${unit})`,
      detail: `Newest: ${newestFile.replace(process.cwd() + "/", "")}. Run: bun build src/cli.ts --target bun --outfile hive-bin`,
    });
  } else {
    checks.push({ status: "pass", label: "hive-bin up to date" });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const ICONS: Record<Status, string> = {
  pass: "\x1b[32mPASS\x1b[0m",
  warn: "\x1b[33mWARN\x1b[0m",
  fail: "\x1b[31mFAIL\x1b[0m",
};

function printGroup(heading: string, checks: Check[], verbose: boolean) {
  if (checks.length === 0) return;
  console.log(`\n  ${heading}`);
  for (const check of checks) {
    console.log(`  ${ICONS[check.status]}  ${check.label}`);
    if (verbose && check.detail) {
      console.log(`        ${check.detail}`);
    }
  }
}

export async function doctorCommand(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");

  console.log("hive doctor\n");

  const groups: { heading: string; checks: Check[] }[] = [
    { heading: "Core", checks: checkCore() },
    { heading: "Identity", checks: checkIdentity() },
    { heading: "Taste", checks: checkTaste() },
    { heading: "MCP", checks: checkMcp() },
    { heading: "Codex", checks: await checkCodex() },
    { heading: "Pi", checks: await checkPi() },
    { heading: "Models", checks: checkModels() },
    { heading: "Scheduler", checks: checkScheduler() },
    { heading: "Registered CLAUDE.md", checks: await checkStaleClaudeMd() },
    await checkProject(),
    { heading: "Build", checks: checkBuild() },
  ];

  for (const group of groups) {
    printGroup(group.heading, group.checks, verbose);
  }

  const all = groups.flatMap(g => g.checks);
  const passed = all.filter(c => c.status === "pass").length;
  const warnings = all.filter(c => c.status === "warn").length;
  const failures = all.filter(c => c.status === "fail").length;

  console.log();
  const parts: string[] = [];
  parts.push(`${passed} passed`);
  if (warnings > 0) parts.push(`\x1b[33m${warnings} warning${warnings > 1 ? "s" : ""}\x1b[0m`);
  if (failures > 0) parts.push(`\x1b[31m${failures} failure${failures > 1 ? "s" : ""}\x1b[0m`);
  console.log(`  ${parts.join(", ")}`);

  // Show details hint if there were issues and not verbose
  if (!verbose && (warnings > 0 || failures > 0)) {
    console.log("  Run with --verbose for details");
  }

  console.log();
  process.exit(failures > 0 ? 1 : 0);
}
