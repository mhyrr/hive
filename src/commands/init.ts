import { existsSync } from "node:fs";
import { chmod, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

import { ensureDirectory, ensureHiveScaffold } from "../lib/paths";

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

async function installSkillDirs(destDir: string): Promise<number> {
  await ensureDirectory(destDir);
  const templatesDir = join(dirname(import.meta.dir), "..", "templates", "skills");
  const entries = await readdir(templatesDir, { withFileTypes: true }).catch(() => []);
  let installed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const destSkillDir = join(destDir, entry.name);
    if (existsSync(destSkillDir)) continue;

    await ensureDirectory(destSkillDir);
    const skillFiles = await readdir(join(templatesDir, entry.name));
    for (const file of skillFiles) {
      const content = await Bun.file(join(templatesDir, entry.name, file)).text();
      await Bun.write(join(destSkillDir, file), content);
    }
    installed++;
  }

  return installed;
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
    return false;
  }
}

export async function initCommand(args: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();

  // Ask for user's name if templates haven't been written yet
  let userName = args.find((a) => a.startsWith("--name="))?.slice(7)?.trim() ?? "";
  if (!userName && !existsSync(paths.identity)) {
    try {
      userName = prompt("Your name (for identity templates): ");
    } catch {
      // non-interactive — leave placeholders
    }
  }
  if (!userName) userName = "your-name-here";

  const replacements = { userName };

  // Write identity templates
  await writeIfMissing(paths.soul, "SOUL.md");
  await writeIfMissing(paths.identity, "IDENTITY.md", replacements);
  await writeIfMissing(paths.self, "SELF.md");
  await writeIfMissing(paths.agents, "AGENTS.md");
  await writeIfMissing(paths.trust, "TRUST.md");
  await writeIfMissing(paths.config, "config.md");

  // Install HIVE agents and skills to ~/.claude/
  const claudeAgentsDir = join(process.env.HOME || "", ".claude", "agents");
  const agentsInstalled = await installTemplateDir("agents", claudeAgentsDir);
  const claudeSkillsDir = join(process.env.HOME || "", ".claude", "skills");
  const skillsInstalled = await installSkillDirs(claudeSkillsDir);
  if (agentsInstalled > 0) {
    console.log(`Installed ${agentsInstalled} HIVE agent(s) to ~/.claude/agents/`);
  }
  if (skillsInstalled > 0) {
    console.log(`Installed ${skillsInstalled} HIVE skill(s) to ~/.claude/skills/`);
  }

  // Install HIVE scripts to ~/.hive/scripts/
  const scriptsDir = join(paths.home, "scripts");
  const scriptsInstalled = await installTemplateDir("scripts", scriptsDir, true);
  if (scriptsInstalled > 0) {
    console.log(`Installed ${scriptsInstalled} HIVE script(s) to ~/.hive/scripts/`);
  }

  // Ensure logs directory
  await ensureDirectory(join(paths.home, "logs"));

  // Install launchd agents for scheduled jobs
  if (installLaunchAgent("com.hive.nightly.plist")) {
    console.log("Installed nightly extraction (2am daily via launchd)");
  }
  if (installLaunchAgent("com.hive.sync.plist")) {
    console.log("Installed hive-sync (2:30am daily via launchd)");
  }
  if (installLaunchAgent("com.hive.morning.plist")) {
    console.log("Installed morning briefing (7am daily via launchd)");
  }
  if (installLaunchAgent("com.hive.heartbeat.plist")) {
    console.log("Installed heartbeat (every 30m via launchd)");
  }
  if (installLaunchAgent("com.hive.dashboard.plist")) {
    console.log("Installed dashboard server (127.0.0.1:7777, KeepAlive, via launchd)");
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
      // non-fatal
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
    if (!servers.hive) {
      servers.hive = {
        command: mcpBin,
        args: [],
      };
      mcpConfig.mcpServers = servers;
      await Bun.write(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n");
      console.log();
      console.log(`Registered HIVE MCP server in ${mcpConfigPath}`);
    }
  } catch {
    console.log();
    console.log(`Note: Could not register MCP server automatically. Add manually to ${mcpConfigPath}`);
  }
}
