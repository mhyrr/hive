import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureHiveScaffold } from "../lib/paths";

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
