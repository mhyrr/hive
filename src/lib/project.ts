import { UsageError } from "./errors";

export type ModelPoolEntry = {
  name: string;
  runtime: string;
  model: string;
  description: string;
};

export function normalizeProjectName(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new UsageError("Project name must contain letters or numbers.");
  }

  return normalized;
}

export function extractRepoPath(projectConfig: string): string | null {
  const match = projectConfig.match(/^path:\s*(.+)$/m);

  return match ? match[1].trim() : null;
}

/**
 * Parse the `## Models` section from a project config.
 * Format: `- <name>: <runtime>, <model-id>, <description>`
 */
export function parseModelPool(config: string): ModelPoolEntry[] {
  const normalized = config.replace(/\r\n/g, "\n");
  const sectionHeading = normalized.match(/^## (?:Models|Model Pool)\s*$/m);

  if (!sectionHeading || sectionHeading.index === undefined) {
    return [];
  }

  const sectionStart = sectionHeading.index + sectionHeading[0].length + 1;
  const remainder = normalized.slice(sectionStart);
  const nextHeadingIndex = remainder.search(/^##\s+/m);
  const section =
    nextHeadingIndex === -1 ? remainder.trim() : remainder.slice(0, nextHeadingIndex).trim();

  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && !line.startsWith("- #"))
    .map((line) => line.slice(2))
    .map((line) => {
      const colonIndex = line.indexOf(":");

      if (colonIndex === -1) {
        return null;
      }

      const name = line.slice(0, colonIndex).trim();
      const rest = line.slice(colonIndex + 1).trim();
      const parts = rest.split(",").map((part) => part.trim());

      if (parts.length < 2) {
        return null;
      }

      return {
        name,
        runtime: parts[0],
        model: parts[1],
        description: parts.slice(2).join(",").trim() || name,
      };
    })
    .filter((entry): entry is ModelPoolEntry => Boolean(entry));
}

/**
 * Look up a model pool entry by name.
 */
export function findModelPoolEntry(config: string, modelName: string): ModelPoolEntry | null {
  return parseModelPool(config).find((entry) => entry.name === modelName) ?? null;
}
