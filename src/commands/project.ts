import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

import { UsageError } from "../lib/errors";
import { ensureDirectory, ensureHiveScaffold } from "../lib/paths";
import { normalizeProjectName } from "../lib/project";
import { ensureProjectMemoryFile } from "../lib/memory";

const HIVE_CLAUDE_MD_BLOCK = (projectId: string) => `
# HIVE

Read and internalize these files at the start of every session:
- ~/.hive/SOUL.md — your values and craft standards
- ~/.hive/IDENTITY.md — who you are
- ~/.hive/SELF.md — who you're working with
- ~/.hive/TRUST.md — action classification and approval rules
- ~/.hive/AGENTS.md — operational doctrine

Read your project memory:
- ~/.hive/memory/projects/${projectId}.md — accumulated facts, conventions, decisions

You have HIVE MCP tools:
- \`convene_council\` — Multi-model analysis. Sends a question to multiple AI models in parallel. You act as chair — synthesize agreement and disagreement.
- \`read_hive_memory\` — Read accumulated project intelligence.
- \`write_hive_memory\` — Record new facts, conventions, or decisions.
- \`create_ticket\` — Create a ticket (bug, feature, task, epic, chore) with priority, tags, and dependencies.
- \`list_tickets\` — List and filter project tickets by status, type, or tags.
- \`show_ticket\` — Show full ticket details including notes.
- \`update_ticket\` — Update ticket status, priority, tags, or other fields.
- \`add_ticket_note\` — Add a timestamped note to a ticket.
`.trim();

export async function projectCommand(args: string[]): Promise<void> {
  const usage = "Usage: hive project add <name> <path>";

  if (args[0] !== "add" || args.length < 3) {
    throw new UsageError(usage);
  }

  const rawName = args[1]!;
  const rawPath = args[2]!;
  const projectId = normalizeProjectName(rawName);
  const repoPath = resolve(rawPath);

  if (!existsSync(repoPath)) {
    throw new UsageError(`Path does not exist: ${repoPath}`);
  }

  const paths = await ensureHiveScaffold();

  // Create project directory and config
  const projectDir = join(paths.projectsDir, projectId);
  await ensureDirectory(projectDir);
  await Bun.write(
    join(projectDir, "config.md"),
    `---\nname: ${projectId}\npath: ${repoPath}\n---\n`,
  );

  // Create memory file
  await ensureProjectMemoryFile(paths, projectId);

  // Append HIVE reference to project's CLAUDE.md
  const claudeMdPath = join(repoPath, "CLAUDE.md");
  const block = HIVE_CLAUDE_MD_BLOCK(projectId);

  if (existsSync(claudeMdPath)) {
    const existing = await Bun.file(claudeMdPath).text();
    if (!existing.includes("# HIVE")) {
      await Bun.write(claudeMdPath, `${existing.trimEnd()}\n\n${block}\n`);
      console.log(`Appended HIVE reference to ${claudeMdPath}`);
    } else {
      console.log(`HIVE reference already present in ${claudeMdPath}`);
    }
  } else {
    await Bun.write(claudeMdPath, `${block}\n`);
    console.log(`Created ${claudeMdPath} with HIVE reference`);
  }

  console.log(`Project '${projectId}' registered at ${repoPath}`);
  console.log(`Memory: ~/.hive/memory/projects/${projectId}.md`);
}
