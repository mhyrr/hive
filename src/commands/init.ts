import { existsSync } from "node:fs";
import { chmod, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

import { wireCodex } from "../lib/codex-wire";
import { wireCursor } from "../lib/cursor-wire";
import { assembleIdentity } from "../lib/identity";
import { ensureDirectory, ensureHiveScaffold } from "../lib/paths";
import { wirePi } from "../lib/pi-wire";
import { discoverWatches, rewriteWatchFrontmatter } from "../lib/watch";

type SettingsHookEntry = { hooks?: Array<{ type?: string; command?: string }> };
type SettingsShape = { hooks?: Record<string, SettingsHookEntry[]> };

async function readTemplate(templatePath: string): Promise<string> {
  return Bun.file(join(dirname(import.meta.dir), "..", "templates", templatePath)).text();
}

async function writeIfMissing(path: string, templatePath: string, replacements?: Record<string, string>): Promise<boolean> {
  if (existsSync(path)) return false;
  let content = await readTemplate(templatePath);
  if (replacements) {
    for (const [key, value] of Object.entries(replacements)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }
  }
  await Bun.write(path, content);
  return true;
}

async function preserveRetiredFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  let retired = `${path}.retired`;
  let suffix = 1;
  while (existsSync(retired)) retired = `${path}.retired-${suffix++}`;
  await rename(path, retired);
  return retired;
}

function prompt(question: string): string {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  const fd = require("fs").openSync("/dev/tty", "r");
  const n = require("fs").readSync(fd, buf, 0, buf.length, null);
  require("fs").closeSync(fd);
  return buf.toString("utf-8", 0, n).trim();
}

async function installTemplateDir(templateSubdir: string, destDir: string, executable = false): Promise<number> {
  await ensureDirectory(destDir);

  const templatesDir = join(dirname(import.meta.dir), "..", "templates", templateSubdir);
  const entries = await readdir(templatesDir).catch(() => []);
  let installed = 0;

  for (const entry of entries) {
    const dest = join(destDir, entry);
    if (!existsSync(dest)) {
      const content = await Bun.file(join(templatesDir, entry)).text();
      await Bun.write(dest, content);
      if (executable) await chmod(dest, 0o755);
      installed++;
    }
  }

  return installed;
}

async function retireLegacyWatch(path: string): Promise<string> {
  let target = path.replace(/\.md$/, ".legacy");
  let suffix = 1;
  while (existsSync(target)) target = path.replace(/\.md$/, `.legacy-${suffix++}`);
  await rename(path, target);
  return target;
}

/** One-time Bets/Muse → Propose/Observe migration. The old files are retained
 * with a non-.md suffix, so custom edits remain recoverable without running a
 * duplicate cycle. State cursors move with the identity; audit logs stay put.
 * The same pass rewrites the old Act venue name in place. */
export async function migrateLegacyWatches(paths: Awaited<ReturnType<typeof ensureHiveScaffold>>): Promise<number> {
  const aliases = [["bets", "propose"], ["muse", "observe"]] as const;
  let migrated = 0;
  const statePath = join(paths.watchesDir, "state.json");
  let state: { watches?: Record<string, unknown> } | null = null;
  if (existsSync(statePath)) {
    state = await Bun.file(statePath).json().catch(() => null) as { watches?: Record<string, unknown> } | null;
  }

  for (const [legacy, current] of aliases) {
    const legacyPath = join(paths.watchesDir, `${legacy}.md`);
    const retired = existsSync(legacyPath) ? await retireLegacyWatch(legacyPath) : null;
    let changed = retired !== null;
    if (state?.watches?.[legacy] && !state.watches[current]) {
      state.watches[current] = state.watches[legacy];
      changed = true;
    }
    if (state?.watches?.[legacy]) {
      delete state.watches[legacy];
      changed = true;
    }
    if (changed) {
      console.log(retired
        ? `Retired legacy watch ${legacy} → ${retired}; ${current} replaces it`
        : `Migrated legacy watch state ${legacy} → ${current}`);
      migrated++;
    }
  }
  const { watches } = await discoverWatches(paths);
  const seenFiles = new Set<string>();
  for (const watch of watches) {
    if (watch.venue !== "act") continue;
    if (seenFiles.has(watch.filePath)) continue;
    const content = await Bun.file(watch.filePath).text();
    if (!/^venue:\s*dispatch\s*$/m.test(content)) continue;
    seenFiles.add(watch.filePath);
    await rewriteWatchFrontmatter(watch.filePath, { venue: "act" });
    console.log(`Migrated watch venue dispatch → act (${watch.name})`);
    migrated++;
  }
  if (migrated > 0 && state) await Bun.write(statePath, JSON.stringify(state, null, 2) + "\n");
  return migrated;
}

// Skills may carry subdirectories (references/, scripts/), so install by
// recursive copy rather than a flat file loop.
async function copyDirRecursive(srcDir: string, destDir: string): Promise<void> {
  await ensureDirectory(destDir);
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(src, dest);
    } else {
      await Bun.write(dest, await Bun.file(src).text());
    }
  }
}

async function installSkillDirs(destDir: string): Promise<number> {
  await ensureDirectory(destDir);
  const templatesDir = join(dirname(import.meta.dir), "..", "templates", "skills");
  const entries = await readdir(templatesDir, { withFileTypes: true }).catch(() => []);
  let installed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const destSkillDir = join(destDir, entry.name);
    if (existsSync(destSkillDir)) continue;

    await copyDirRecursive(join(templatesDir, entry.name), destSkillDir);
    installed++;
  }

  return installed;
}

async function installIdentityHook(opts: { forceHook?: boolean } = {}): Promise<{ hookInstalled: boolean; hookUpdated: boolean; wired: boolean }> {
  const home = process.env.HOME || "";
  const claudeDir = join(home, ".claude");
  const hooksDir = join(claudeDir, "hooks");
  await ensureDirectory(hooksDir);

  const hookDest = join(hooksDir, "load-identity.sh");
  const hookExisted = existsSync(hookDest);
  const hookInstalled = await writeIfMissing(hookDest, "hooks/load-identity.sh");
  let hookUpdated = false;

  if (hookInstalled) {
    await chmod(hookDest, 0o755);
  } else if (hookExisted && opts.forceHook) {
    // Force-rewrite: the hook is a thin delegating wrapper; user customization
    // belongs in ~/.hive/*.md, not the hook itself. --force-hook restores the
    // canonical wrapper when it has drifted.
    const { LOAD_IDENTITY_HOOK } = await import("../lib/identity-hook-template");
    await Bun.write(hookDest, LOAD_IDENTITY_HOOK);
    await chmod(hookDest, 0o755);
    hookUpdated = true;
  }

  const settingsPath = join(claudeDir, "settings.json");
  let settings: SettingsShape = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await Bun.file(settingsPath).text()) as SettingsShape;
    } catch {
      // intentional: malformed settings.json — can't wire hook
      return { hookInstalled, wired: false };
    }
  }

  settings.hooks = settings.hooks ?? {};
  let wired = false;
  for (const event of ["SessionStart", "PostCompact"] as const) {
    const entries = settings.hooks[event] ?? [];
    const alreadyWired = entries.some((entry) =>
      entry.hooks?.some((h) => h.command === hookDest),
    );
    if (!alreadyWired) {
      entries.push({ hooks: [{ type: "command", command: hookDest }] });
      settings.hooks[event] = entries;
      wired = true;
    }
  }

  if (wired) {
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  return { hookInstalled, hookUpdated, wired };
}

function installLaunchAgent(plistName: string): boolean {
  const home = process.env.HOME || "";
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const dest = join(launchAgentsDir, plistName);

  if (existsSync(dest)) return false;

  try {
    const templatesDir = join(dirname(import.meta.dir), "..", "templates", "launchd");
    const content = require("fs").readFileSync(join(templatesDir, plistName), "utf-8");
    require("fs").mkdirSync(launchAgentsDir, { recursive: true });
    require("fs").writeFileSync(dest, content);
    execSync(`launchctl load ${dest}`, { encoding: "utf-8" });
    return true;
  } catch {
    // intentional: launchctl load failed — non-fatal
    return false;
  }
}

/** Stop a scheduler whose command no longer exists and preserve its plist for
 * inspection. The next `hive init` performs the upgrade; this code never
 * touches user-authored launch agents. */
async function retireShippedLaunchAgent(plistName: string): Promise<string | null> {
  const dest = join(process.env.HOME || "", "Library", "LaunchAgents", plistName);
  if (!existsSync(dest)) return null;
  try {
    execSync(`launchctl unload ${dest}`, { encoding: "utf-8" });
  } catch {
    // Already unloaded is a successful retirement state.
  }
  return preserveRetiredFile(dest);
}

/** Older watch installs invoked the CLI directly, which left detached model
 * calls dependent on GUI Keychain access. Upgrade only that exact shipped
 * command; custom launchd definitions remain untouched. */
function migrateWatchesLaunchAgent(): boolean {
  const home = process.env.HOME || "";
  const dest = join(home, "Library", "LaunchAgents", "com.hive.watches.plist");
  if (!existsSync(dest)) return false;
  const legacy = "\"${HIVE_BIN:-$HOME/.local/bin/hive}\" watch run --due";
  const current = require("fs").readFileSync(dest, "utf-8") as string;
  if (!current.includes(legacy)) return false;
  const template = join(dirname(import.meta.dir), "..", "templates", "launchd", "com.hive.watches.plist");
  require("fs").writeFileSync(dest, require("fs").readFileSync(template, "utf-8"));
  try {
    execSync(`launchctl unload ${dest}`, { encoding: "utf-8" });
  } catch {
    // It may not currently be loaded; load below is the meaningful operation.
  }
  try {
    execSync(`launchctl load ${dest}`, { encoding: "utf-8" });
  } catch {
    // Non-fatal, matching first-install launchd behavior.
  }
  return true;
}

export async function initCommand(args: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();

  // Ask for user's name if templates haven't been written yet
  let userName = args.find((a) => a.startsWith("--name="))?.slice(7)?.trim() ?? "";
  if (!userName && !existsSync(paths.identity)) {
    try {
      userName = prompt("Your name (for identity templates): ");
    } catch {
      // intentional: non-interactive terminal — leave placeholders
    }
  }
  if (!userName) userName = "your-name-here";

  const replacements = { userName };

  // Write identity templates
  await writeIfMissing(paths.soul, "SOUL.md", replacements);
  await writeIfMissing(paths.identity, "IDENTITY.md", replacements);
  await writeIfMissing(paths.self, "SELF.md");
  await writeIfMissing(paths.agents, "AGENTS.md", replacements);
  await writeIfMissing(paths.trust, "TRUST.md", replacements);
  await writeIfMissing(paths.config, "config.md");

  // Default swappable persona register (user-editable; non-clobbering).
  // Installs made before the rename hold the register at personas/greg-dry.md.
  // Move it to personas/dry.md so an edited register survives. Otherwise
  // DEFAULT_PERSONA resolves to "dry", finds nothing, and drops the slot.
  const personaPath = join(paths.home, "personas", "dry.md");
  const legacyPersonaPath = join(paths.home, "personas", "greg-dry.md");
  if (existsSync(legacyPersonaPath) && !existsSync(personaPath)) {
    await rename(legacyPersonaPath, personaPath);
    console.log("Renamed persona register: greg-dry.md -> dry.md");
  }
  await writeIfMissing(personaPath, "personas/dry.md", replacements);

  // Install HIVE agents and skills to ~/.claude/
  const claudeAgentsDir = join(process.env.HOME || "", ".claude", "agents");
  for (const retiredAgent of ["maya-executor.md", "maya-heartbeat.md", "maya-coder.md"]) {
    const retired = await preserveRetiredFile(join(claudeAgentsDir, retiredAgent));
    if (retired) console.log(`Retired obsolete Claude agent (${retired})`);
  }
  const agentsInstalled = await installTemplateDir("agents", claudeAgentsDir);
  const claudeSkillsDir = join(process.env.HOME || "", ".claude", "skills");
  const skillsInstalled = await installSkillDirs(claudeSkillsDir);
  if (agentsInstalled > 0) {
    console.log(`Installed ${agentsInstalled} HIVE agent(s) to ~/.claude/agents/`);
  }
  if (skillsInstalled > 0) {
    console.log(`Installed ${skillsInstalled} HIVE skill(s) to ~/.claude/skills/`);
  }

  // Install identity hook at user level and wire SessionStart + PostCompact
  const forceHook = args.includes("--force-hook");
  const identityHook = await installIdentityHook({ forceHook });
  if (identityHook.hookInstalled) {
    console.log("Installed identity hook at ~/.claude/hooks/load-identity.sh");
  }
  if (identityHook.hookUpdated) {
    console.log("Updated identity hook to current template (--force-hook)");
  }
  if (identityHook.wired) {
    console.log("Wired SessionStart + PostCompact hooks in ~/.claude/settings.json");
  }

  // Install HIVE scripts to ~/.hive/scripts/
  const scriptsDir = join(paths.home, "scripts");
  const scriptsInstalled = await installTemplateDir("scripts", scriptsDir, true);
  if (scriptsInstalled > 0) {
    console.log(`Installed ${scriptsInstalled} HIVE script(s) to ~/.hive/scripts/`);
  }

  // Ensure logs directory
  await ensureDirectory(join(paths.home, "logs"));

  // Install template watches (idempotent — existing files never overwritten)
  await migrateLegacyWatches(paths);
  const watchesInstalled = await installTemplateDir("watches", paths.watchesDir);
  if (watchesInstalled > 0) {
    console.log(`Installed ${watchesInstalled} template watch(es) to ~/.hive/watches/`);
  }

  // Install launchd agents for scheduled jobs
  const retiredHeartbeat = await retireShippedLaunchAgent("com.hive.heartbeat.plist");
  if (retiredHeartbeat) {
    console.log(`Retired obsolete heartbeat scheduler (${retiredHeartbeat})`);
  }
  if (installLaunchAgent("com.hive.nightly.plist")) {
    console.log("Installed nightly extraction (2am daily via launchd)");
  }
  if (installLaunchAgent("com.hive.sync.plist")) {
    console.log("Installed hive-sync (2:30am daily via launchd)");
  }
  if (installLaunchAgent("com.hive.dashboard.plist")) {
    console.log("Installed dashboard server (127.0.0.1:7777, KeepAlive, via launchd)");
  }
  if (migrateWatchesLaunchAgent()) {
    console.log("Updated watches tick for detached OAuth + sleep prevention");
  } else if (installLaunchAgent("com.hive.watches.plist")) {
    console.log("Installed watches tick (hourly via launchd)");
  }
  if (installLaunchAgent("com.hive.taste-review.plist")) {
    console.log("Installed weekly taste review reminder (Sunday 7pm via launchd)");
  }

  // Symlink binaries to ~/.local/bin/
  const localBin = join(process.env.HOME || "", ".local", "bin");
  await ensureDirectory(localBin);

  const hiveCliSource = join(process.cwd(), "hive-bin");
  const hiveCliBin = join(localBin, "hive");
  if (existsSync(hiveCliSource) && !existsSync(hiveCliBin)) {
    try {
      require("fs").symlinkSync(hiveCliSource, hiveCliBin);
      console.log(`Linked hive to ${hiveCliBin}`);
    } catch {
      // intentional: symlink failed (permissions, existing file) — warn and continue
      console.log(`Note: Could not link hive to ${hiveCliBin}. Add manually to PATH.`);
    }
  }

  const hiveMcpSource = join(process.cwd(), "hive-mcp");
  const hiveMcpBin = join(localBin, "hive-mcp");
  if (existsSync(hiveMcpSource)) {
    try {
      if (existsSync(hiveMcpBin)) require("fs").unlinkSync(hiveMcpBin);
      require("fs").symlinkSync(hiveMcpSource, hiveMcpBin);
    } catch {
      // intentional: MCP binary symlink failed — non-fatal
    }
  }

  console.log(`Initialized hive home: ${paths.home}`);
  console.log();
  console.log("Next:");
  console.log(`  1. Edit ${paths.self} — tell the AI who you are`);
  console.log(`  2. Edit ${paths.identity} — shape who the AI is`);
  console.log(`  3. Configure models in ${paths.config}`);
  console.log(`  4. Register a project: hive project add <name> <path>`);
  console.log(`  5. Run \`hive\` from anywhere to start a session`);

  // Register MCP server in Claude Code config (~/.claude.json is canonical)
  const mcpConfigPath = join(process.env.HOME || "", ".claude.json");

  try {
    let mcpConfig: Record<string, unknown> = {};

    if (existsSync(mcpConfigPath)) {
      mcpConfig = JSON.parse(await Bun.file(mcpConfigPath).text());
    }

    const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
    const mcpBin = join(localBin, "hive-mcp");
    let mcpChanged = false;
    if (!servers.hive) {
      servers.hive = {
        command: mcpBin,
        args: [],
      };
      mcpConfig.mcpServers = servers;
      mcpChanged = true;
      console.log();
      console.log(`Registered HIVE MCP server in ${mcpConfigPath}`);
    } else {
      // HIVE tools defer behind ToolSearch: AGENTS.md names each tool and its
      // trigger, so eager schemas (~17KB) would only add session-start weight.
      // Strip alwaysLoad from entries written by earlier versions.
      const hiveEntry = servers.hive as Record<string, unknown>;
      if (hiveEntry.alwaysLoad) {
        delete hiveEntry.alwaysLoad;
        mcpChanged = true;
        console.log();
        console.log(`Removed alwaysLoad from HIVE MCP server in ${mcpConfigPath} (tools defer behind ToolSearch)`);
      }
    }
    if (mcpChanged) {
      mcpConfig.mcpServers = servers;
      await Bun.write(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    }
  } catch {
    // intentional: MCP config write failed — warn user
    console.log();
    console.log(`Note: Could not register MCP server automatically. Add manually to ${mcpConfigPath}`);
  }

  // Codex CLI integration: register MCP, emit AGENTS.md, install SessionStart hook.
  // Best-effort — silent skip if codex isn't installed. TK-114: pass harness=codex
  // so the AGENTS.md uses the direct-read variant of the stack hint.
  try {
    const codexMcpBin = join(localBin, "hive-mcp");
    const identity = await assembleIdentity({ harness: "codex" });
    const codex = await wireCodex({ identity, mcpBinPath: codexMcpBin });

    if (codex.detected) {
      console.log();
      if (codex.mcpAdded) {
        console.log("Registered HIVE MCP server in ~/.codex/config.toml");
      } else if (codex.mcpAlreadyRegistered) {
        console.log("HIVE MCP already registered in ~/.codex/config.toml");
      }
      if (codex.agentsMdWritten) {
        console.log("Wrote ~/.codex/AGENTS.md from current identity");
      }
      if (codex.hookScriptInstalled) {
        console.log("Installed Codex identity hook at ~/.hive/codex-load-identity.sh");
      }
      if (codex.hookWired) {
        console.log("Wired SessionStart hook in ~/.codex/hooks.json");
      }
    }
  } catch {
    // intentional: codex integration is optional — skip on failure
  }

  // Pi CLI integration: register HIVE MCP for pi-mcp-adapter.
  // Best-effort — silent skip if Pi isn't installed.
  try {
    const piMcpBin = join(localBin, "hive-mcp");
    const pi = await wirePi({ mcpBinPath: piMcpBin });

    if (pi.detected) {
      console.log();
      if (pi.mcpAdded) {
        console.log("Registered HIVE MCP server in ~/.pi/agent/mcp.json");
      } else if (pi.mcpAlreadyRegistered) {
        console.log("HIVE MCP already registered in ~/.pi/agent/mcp.json");
      }
    }
  } catch {
    // intentional: Pi integration is optional — skip on failure
  }

  // Cursor CLI integration: register HIVE MCP at user scope. Cursor stores
  // approval per project directory, so wireCursor also approves this cwd as a
  // convenience; every `hive -a` launch repeats that best-effort approval.
  try {
    const cursorMcpBin = join(localBin, "hive-mcp");
    const cursor = await wireCursor({ mcpBinPath: cursorMcpBin });

    if (cursor.detected) {
      console.log();
      if (cursor.mcpAdded) {
        console.log("Registered HIVE MCP server in ~/.cursor/mcp.json");
      } else if (cursor.mcpAlreadyRegistered) {
        console.log("HIVE MCP already registered in ~/.cursor/mcp.json");
      }
      if (cursor.mcpApproved) {
        console.log("Approved HIVE MCP server for this Cursor workspace");
      }
    }
  } catch {
    // intentional: Cursor integration is optional — skip on failure
  }
}
