import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

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
 * Resolve symlinks so a repo reached through one path still matches a config
 * registered under the other — /tmp vs /private/tmp on macOS, or a symlinked
 * worktree. A registered path that no longer exists resolves to itself rather
 * than throwing; it simply won't match anything.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `dir` is `base` or sits underneath it, respecting path boundaries. */
function isWithin(dir: string, base: string): boolean {
  if (dir === base) return true;
  return dir.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Resolve which registered project owns the current working directory.
 * Matches cwd against the `path` field in each project's config.md frontmatter.
 *
 * Returns null when nothing matches. It used to fall back to the first project
 * directory alphabetically, which meant running from an unregistered directory
 * silently adopted an unrelated project's identity — memory writes and tickets
 * landed in whichever project sorted first. A wrong project is worse than none:
 * callers already handle null, and none of them can detect the wrong answer.
 *
 * The deepest matching path wins, so a subproject registered inside a monorepo
 * beats the repo root instead of resolving by readdir order.
 */
export function resolveProjectFromCwd(): string | null {
  const paths = getHivePaths();
  if (!existsSync(paths.projectsDir)) return null;
  const cwd = canonical(process.cwd());

  let best: { projectId: string; depth: number } | null = null;

  for (const entry of readdirSync(paths.projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = readFileSync(join(paths.projectsDir, entry.name, "config.md"), "utf-8");
      const configured = parseFrontmatter(raw).attributes?.path as string | undefined;
      if (!configured) continue;

      const projectPath = canonical(configured);
      if (!isWithin(cwd, projectPath)) continue;
      if (!best || projectPath.length > best.depth) {
        best = { projectId: entry.name, depth: projectPath.length };
      }
    } catch { /* intentional: skip unreadable project config */ }
  }

  return best?.projectId ?? null;
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
