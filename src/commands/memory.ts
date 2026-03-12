import { UsageError } from "../lib/errors";
import { appendEvent } from "../lib/events";
import { appendFeedEntry } from "../lib/feed";
import {
  appendToSection,
  ensureProjectMemoryFile,
  extractMemory,
  readEntityMemory,
  updateEntityMemory,
} from "../lib/memory";
import { ensureHiveScaffold, getActiveProject } from "../lib/paths";
import { toIsoTimestamp } from "../lib/time";

const sectionMap: Record<string, string> = {
  fact: "## Durable Facts",
  convention: "## Conventions",
  decision: "## Decisions",
  question: "## Open Questions",
};

export async function memoryCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();
  const [action, ...rest] = args;

  if (!action) {
    const activeProject = await getActiveProject(paths);

    if (!activeProject) {
      throw new UsageError("No active project. Run `hive work <project>` first.");
    }

    const memoryPath = await ensureProjectMemoryFile(paths, activeProject);
    return Bun.file(memoryPath).text();
  }

  if (action === "extract") {
    const extracted = await extractMemory({ paths });

    return `Extracted memory
Journal: ${extracted.journalPath}
Summary: ${extracted.memorySummaryPath}
Heat: ${extracted.memoryHeatPath}
Recent decisions: ${extracted.recentDecisionsPath}`;
  }

  if (action === "entity") {
    const [entityType, entityId, entityAction, ...textParts] = rest;

    if (!entityType || !entityId) {
      throw new UsageError(
        "Usage: hive memory entity <person|company> <id> [summary|fact|note <text>]",
      );
    }

    if (entityType !== "person" && entityType !== "company") {
      throw new UsageError("Entity type must be `person` or `company`.");
    }

    if (!entityAction) {
      return readEntityMemory(paths, entityType, entityId);
    }

    if (entityAction !== "summary" && entityAction !== "fact" && entityAction !== "note") {
      throw new UsageError("Entity action must be `summary`, `fact`, or `note`.");
    }

    const text = textParts.join(" ").trim();

    if (!text) {
      throw new UsageError(
        "Usage: hive memory entity <person|company> <id> [summary|fact|note <text>]",
      );
    }

    return updateEntityMemory({
      paths,
      type: entityType,
      id: entityId,
      action: entityAction,
      text,
    });
  }

  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const memoryPath = await ensureProjectMemoryFile(paths, activeProject);
  const file = Bun.file(memoryPath);

  const text = rest.join(" ").trim();
  if (!text) {
    throw new UsageError(`Usage: hive memory ${action} <text>`);
  }

  const sectionHeader = sectionMap[action];
  if (!sectionHeader) {
    throw new UsageError(
      `Unknown memory section: ${action}. Use: fact, convention, decision, question`,
    );
  }

  const content = await file.text();
  const entry =
    action === "decision" ? `- [${toIsoTimestamp()}] ${text}` : `- ${text}`;

  const updated = appendToSection(content, sectionHeader, entry);
  await Bun.write(memoryPath, updated);

  // Log to feed for visibility
  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Memory updated: ${action}`,
    details: [text],
  });
  await appendEvent({
    paths,
    kind: "memory.project.updated",
    source: "memory",
    project: activeProject,
    summary: text,
    details: [`section: ${action}`],
    data: {
      section: action,
    },
  });

  return `Recorded ${action}: ${text}`;
}
