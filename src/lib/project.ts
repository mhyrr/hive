import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { UsageError } from "./errors";
import { getHivePaths } from "./paths";
import { parseFrontmatter } from "./frontmatter";

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

/**
 * Resolve which registered project owns the current working directory.
 * Matches cwd against the `path` field in each project's config.md frontmatter.
 * Falls back to the first registered project if no path matches.
 */
export function resolveProjectFromCwd(): string | null {
  const paths = getHivePaths();
  const cwd = process.cwd();
  if (!existsSync(paths.projectsDir)) return null;

  const projects = readdirSync(paths.projectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const projectId of projects) {
    try {
      const configPath = join(paths.projectsDir, projectId, "config.md");
      const raw = readFileSync(configPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      const projectPath = parsed.attributes?.path as string | undefined;
      if (projectPath && cwd.startsWith(projectPath)) return projectId;
    } catch { /* skip */ }
  }

  return projects[0] ?? null;
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
