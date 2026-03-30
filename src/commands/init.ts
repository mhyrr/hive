import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureHiveScaffold } from "../lib/paths";

// Write template files if they don't exist
async function writeIfMissing(path: string, templatePath: string): Promise<boolean> {
  if (existsSync(path)) return false;
  const template = await Bun.file(join(dirname(import.meta.dir), "..", "templates", templatePath)).text();
  await Bun.write(path, template);
  return true;
}

export async function initCommand(args: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();

  // Write identity templates
  await writeIfMissing(paths.soul, "SOUL.md");
  await writeIfMissing(paths.identity, "IDENTITY.md");
  await writeIfMissing(paths.self, "SELF.md");
  await writeIfMissing(paths.agents, "AGENTS.md");
  await writeIfMissing(paths.trust, "TRUST.md");
  await writeIfMissing(paths.config, "config.md");

  console.log(`Initialized hive home: ${paths.home}`);
  console.log();
  console.log("Next:");
  console.log(`  Customize ${paths.soul}`);
  console.log(`  Customize ${paths.self}`);
  console.log(`  Customize ${paths.trust}`);
  console.log(`  Register a project: hive project add <name> <path>`);

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
