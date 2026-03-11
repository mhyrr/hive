import { UsageError } from "../lib/errors";
import { appendFeedEntry } from "../lib/feed";
import {
  ensureHiveScaffold,
  getActiveProject,
} from "../lib/paths";
import { toIsoTimestamp } from "../lib/time";
import { join } from "node:path";
import { renderProjectMemoryTemplate } from "../lib/templates";

const sectionMap: Record<string, string> = {
  fact: "## Durable Facts",
  convention: "## Conventions",
  decision: "## Decisions",
  question: "## Open Questions",
};

/**
 * Insert `entry` at the end of the named section, before the next `## ` heading.
 * If the section body contains `(none yet)`, replace that placeholder.
 */
export function appendToSection(
  content: string,
  sectionHeader: string,
  entry: string,
): string {
  const headerIndex = content.indexOf(sectionHeader);
  if (headerIndex === -1) {
    // Section not found — append it at the end
    return `${content.trimEnd()}\n\n${sectionHeader}\n${entry}\n`;
  }

  const afterHeader = headerIndex + sectionHeader.length;

  // Find the next section heading (## ) after this one
  const nextSectionMatch = content.slice(afterHeader).search(/\n## /);
  const sectionEnd =
    nextSectionMatch === -1
      ? content.length
      : afterHeader + nextSectionMatch;

  const sectionBody = content.slice(afterHeader, sectionEnd);

  let updatedBody: string;
  if (sectionBody.includes("(none yet)")) {
    // Replace placeholder with entry
    updatedBody = sectionBody.replace("(none yet)", entry);
  } else {
    // Append entry at the end of the section
    updatedBody = `${sectionBody.trimEnd()}\n${entry}`;
  }

  const before = content.slice(0, afterHeader);
  const after = content.slice(sectionEnd);

  return `${before}${updatedBody.trimEnd()}\n${after}`;
}

export async function memoryCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const memoryPath = join(paths.memoryProjectsDir, `${activeProject}.md`);

  // Ensure file exists
  const file = Bun.file(memoryPath);
  if (!(await file.exists())) {
    await Bun.write(memoryPath, `${renderProjectMemoryTemplate(activeProject).trim()}\n`);
  }

  const [action, ...rest] = args;

  if (!action) {
    // Show memory
    return await file.text();
  }

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

  return `Recorded ${action}: ${text}`;
}
