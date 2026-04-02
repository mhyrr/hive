import { UsageError } from "../lib/errors";
import { ensureHiveScaffold, listProjects } from "../lib/paths";
import {
  appendProjectMemory,
  readProjectMemorySnapshot,
  readProjectMemorySection,
  type MemorySection,
} from "../lib/memory";
import { writeDailySessions } from "../lib/sessions";

function resolveProjectFromCwd(projects: string[]): string | null {
  const cwd = process.cwd();
  // Simple heuristic: find a project whose name appears in the cwd path
  return projects.find((p) => cwd.toLowerCase().includes(p.toLowerCase())) ?? projects[0] ?? null;
}

export async function memoryCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive memory                              View all project memory
  hive memory view [facts|conventions|decisions|questions]
  hive memory fact <text>                  Add a durable fact
  hive memory convention <text>            Add a convention
  hive memory decision <text>              Add a decision
  hive memory question <text>              Add an open question
  hive memory reflect                      Batch-write learnings from stdin (JSON)
  hive memory --project <name> ...         Specify project`;

  const paths = await ensureHiveScaffold();

  // Parse --project flag
  let projectOverride: string | null = null;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" || args[i] === "-p") {
      projectOverride = args[++i] ?? null;
      continue;
    }
    filtered.push(args[i]!);
  }

  const projects = await listProjects(paths.projectsDir);
  const projectId = projectOverride ?? resolveProjectFromCwd(projects);

  if (!projectId) {
    throw new UsageError("No project found. Register one with: hive project add <name> <path>");
  }

  const subcommand = filtered[0];

  if (subcommand === "extract-sessions") {
    const outputPath = await writeDailySessions();
    console.log(`Sessions extracted to: ${outputPath}`);
    return;
  }

  if (!subcommand || subcommand === "view") {
    const section = (filtered[1] ?? "all") as "all" | "facts" | "conventions" | "decisions" | "questions";
    const snapshot = await readProjectMemorySnapshot(paths, projectId);
    console.log(`Project: ${projectId}\n`);
    console.log(readProjectMemorySection(snapshot, section));
    return;
  }

  if (subcommand === "reflect") {
    const stdin = await Bun.stdin.text();
    let learnings: Array<{ type: string; content: string }>;
    try {
      learnings = JSON.parse(stdin.trim());
    } catch {
      throw new UsageError("Invalid JSON on stdin. Expected: [{\"type\":\"fact\",\"content\":\"...\"},...]");
    }
    if (!Array.isArray(learnings) || learnings.length === 0) {
      throw new UsageError("Expected a non-empty JSON array of learnings.");
    }

    const validTypes = ["fact", "convention", "decision", "question"];
    let recorded = 0;
    for (const item of learnings) {
      if (!validTypes.includes(item.type)) {
        console.error(`Skipping invalid type: ${item.type}`);
        continue;
      }
      try {
        await appendProjectMemory(paths, projectId, item.type as MemorySection, item.content);
        recorded++;
      } catch (err) {
        console.error(`Skipping ${item.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`Recorded ${recorded} learning(s) in ${projectId} memory.`);
    return;
  }

  const validSections: MemorySection[] = ["fact", "convention", "decision", "question"];
  if (!validSections.includes(subcommand as MemorySection)) {
    throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }

  const text = filtered.slice(1).join(" ").trim();
  if (!text) {
    throw new UsageError(`No text provided.\n\n${usage}`);
  }

  try {
    await appendProjectMemory(paths, projectId, subcommand as MemorySection, text);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  console.log(`Added ${subcommand} to ${projectId} memory.`);
}
