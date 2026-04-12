import { UsageError } from "../lib/errors";
import { ensureHiveScaffold, listProjects } from "../lib/paths";
import {
  appendProjectMemory,
  appendToLog,
  readProjectMemorySnapshot,
  readProjectMemorySection,
  searchMemory,
  formatSearchResults,
  rebuildIndex,
  type MemorySection,
} from "../lib/memory";
import { writeDailySessions } from "../lib/sessions";
import { promoteReflections } from "../lib/reflections";

function resolveProjectFromCwd(projects: string[]): string | null {
  const cwd = process.cwd();
  // Simple heuristic: find a project whose name appears in the cwd path
  return projects.find((p) => cwd.toLowerCase().includes(p.toLowerCase())) ?? projects[0] ?? null;
}

function parseFlagsAndArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--project" || arg === "-p") {
      flags.project = args[++i] ?? "";
    } else if (arg === "--tag" || arg === "-t") {
      flags.tag = args[++i] ?? "";
    } else if (arg === "--section" || arg === "-s") {
      flags.section = args[++i] ?? "";
    } else if (arg === "--no-superseded") {
      flags.noSuperseded = "true";
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

export async function memoryCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive memory                              View all project memory
  hive memory view [facts|conventions|decisions|questions]
  hive memory fact <text> [--tag <tag>]    Add a durable fact
  hive memory convention <text>            Add a convention
  hive memory decision <text>              Add a decision
  hive memory question <text>              Add an open question
  hive memory search <query> [--tag t] [--section s]  Search across all memory layers
  hive memory index                        Rebuild the project memory index
  hive memory reflect                      Batch-write learnings from stdin (JSON)
  hive memory promote                      Promote unprocessed reflections to memory
  hive memory --project <name> ...         Specify project`;

  const paths = await ensureHiveScaffold();
  const { flags, positional } = parseFlagsAndArgs(args);

  const projects = await listProjects(paths.projectsDir);
  const projectId = flags.project ?? resolveProjectFromCwd(projects);

  if (!projectId) {
    throw new UsageError("No project found. Register one with: hive project add <name> <path>");
  }

  const subcommand = positional[0];

  if (subcommand === "promote") {
    const result = await promoteReflections(paths, projectId);
    console.log(`Reflection promotion for ${projectId}:`);
    console.log(`  ${result.promoted} promoted to knowledge`);
    console.log(`  ${result.skipped} skipped (duplicate)`);
    console.log(`  ${result.proposed} proposed to inbox`);
    if (result.details.length > 0) {
      console.log("");
      for (const d of result.details) console.log(`  ${d}`);
    }
    return;
  }

  if (subcommand === "extract-sessions") {
    const outputPath = await writeDailySessions();
    console.log(`Sessions extracted to: ${outputPath}`);
    return;
  }

  // Search
  if (subcommand === "search") {
    const query = positional.slice(1).join(" ").trim();
    if (!query) {
      throw new UsageError("No search query provided.\n\nhive memory search <query>");
    }
    const results = await searchMemory(paths, projectId, query, {
      tag: flags.tag,
      section: flags.section as MemorySection | undefined,
      includeSuperseded: flags.noSuperseded !== "true",
    });
    console.log(formatSearchResults(results, query));
    return;
  }

  // Rebuild index
  if (subcommand === "index") {
    const output = await rebuildIndex(paths, projectId);
    console.log(`Index rebuilt for ${projectId}:\n`);
    console.log(output);
    return;
  }

  if (!subcommand || subcommand === "view") {
    const section = (positional[1] ?? "all") as "all" | "facts" | "conventions" | "decisions" | "questions";
    const snapshot = await readProjectMemorySnapshot(paths, projectId);
    console.log(`Project: ${projectId}\n`);
    console.log(readProjectMemorySection(snapshot, section, flags.noSuperseded !== "true"));
    return;
  }

  if (subcommand === "reflect") {
    const stdin = await Bun.stdin.text();
    let learnings: Array<{ type: string; content: string; tags?: string[] }>;
    try {
      learnings = JSON.parse(stdin.trim());
    } catch {
      throw new UsageError("Invalid JSON on stdin. Expected: [{\"type\":\"fact\",\"content\":\"...\"},...]");
    }
    if (!Array.isArray(learnings) || learnings.length === 0) {
      throw new UsageError("Expected a non-empty JSON array of learnings.");
    }

    const validTypes = ["fact", "convention", "decision", "question"];

    // Write to log first
    const logEntries = learnings
      .filter((item) => validTypes.includes(item.type))
      .map((item) => ({ type: item.type as MemorySection, content: item.content }));
    if (logEntries.length > 0) {
      await appendToLog(paths, projectId, logEntries);
    }

    // Write to knowledge
    let recorded = 0;
    for (const item of learnings) {
      if (!validTypes.includes(item.type)) {
        console.error(`Skipping invalid type: ${item.type}`);
        continue;
      }
      try {
        await appendProjectMemory(paths, projectId, item.type as MemorySection, item.content, item.tags ?? []);
        recorded++;
      } catch (err) {
        console.error(`Skipping ${item.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Rebuild index
    await rebuildIndex(paths, projectId);

    console.log(`Recorded ${recorded} learning(s) in ${projectId} memory (knowledge + log). Index rebuilt.`);
    return;
  }

  const validSections: MemorySection[] = ["fact", "convention", "decision", "question"];
  if (!validSections.includes(subcommand as MemorySection)) {
    throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }

  const text = positional.slice(1).join(" ").trim();
  if (!text) {
    throw new UsageError(`No text provided.\n\n${usage}`);
  }

  const tags = flags.tag ? flags.tag.split(",").map((t) => t.trim().toLowerCase()) : [];

  try {
    await appendProjectMemory(paths, projectId, subcommand as MemorySection, text, tags);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  console.log(`Added ${subcommand} to ${projectId} memory.`);
}
