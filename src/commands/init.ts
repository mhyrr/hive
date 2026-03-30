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

function installCron(scriptPath: string, schedule: string, logPath: string): boolean {
  try {
    const cronLine = `${schedule} ${scriptPath} >> ${logPath} 2>&1`;
    const existing = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8" });

    if (existing.includes(scriptPath)) return false;

    const updated = existing.trimEnd() + "\n" + cronLine + "\n";
    execSync(`echo ${JSON.stringify(updated)} | crontab -`, { encoding: "utf-8" });
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

  // Install HIVE agents to ~/.claude/agents/
  const claudeAgentsDir = join(process.env.HOME || "", ".claude", "agents");
  const agentsInstalled = await installTemplateDir("agents", claudeAgentsDir);
  if (agentsInstalled > 0) {
    console.log(`Installed ${agentsInstalled} HIVE agent(s) to ~/.claude/agents/`);
  }

  // Install HIVE scripts to ~/.hive/scripts/
  const scriptsDir = join(paths.home, "scripts");
  const scriptsInstalled = await installTemplateDir("scripts", scriptsDir, true);
  if (scriptsInstalled > 0) {
    console.log(`Installed ${scriptsInstalled} HIVE script(s) to ~/.hive/scripts/`);
  }

  // Ensure logs directory
  await ensureDirectory(join(paths.home, "logs"));

  // Install cron jobs
  const nightlyScript = join(scriptsDir, "nightly.sh");
  const nightlyLog = join(paths.home, "logs", "nightly.log");
  if (existsSync(nightlyScript)) {
    if (installCron(nightlyScript, "0 2 * * *", nightlyLog)) {
      console.log("Installed nightly extraction cron (2am daily)");
    }
  }

  const syncScript = join(scriptsDir, "hive-sync.sh");
  const syncLog = join(paths.home, "logs", "hive-sync.log");
  if (existsSync(syncScript)) {
    if (installCron(syncScript, "30 2 * * *", syncLog)) {
      console.log("Installed hive-sync cron (2:30am daily)");
    }
  }

  console.log(`Initialized hive home: ${paths.home}`);
  console.log();
  console.log("Next:");
  console.log(`  1. Edit ${paths.self} — tell the AI who you are`);
  console.log(`  2. Edit ${paths.identity} — shape who the AI is`);
  console.log(`  3. Configure models in ${paths.config}`);
  console.log(`  4. Register a project: hive project add <name> <path>`);

  // Register MCP server in Claude Code config
  const claudeDir = join(process.env.HOME || "", ".claude");
  const mcpConfigPath = join(claudeDir, ".mcp.json");

  try {
    let mcpConfig: Record<string, unknown> = {};

    if (existsSync(mcpConfigPath)) {
      mcpConfig = JSON.parse(await Bun.file(mcpConfigPath).text());
    }

    const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
    if (!servers.hive) {
      servers.hive = {
        command: "bun",
        args: [join(process.cwd(), "src", "mcp-server.ts")],
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
