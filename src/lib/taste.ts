import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { resolveHiveHome } from "./paths";

/** Same shape as STACK_NAME_RE — lowercase, hyphenated, leading letter. */
export const TASTE_DOMAIN_RE = /^[a-z][a-z0-9-]*$/;

export type TastePaths = {
  root: string;
  principles: string;
  applicationsDir: string;
};

export function getTastePaths(home: string = resolveHiveHome()): TastePaths {
  const root = join(home, "taste");
  return {
    root,
    principles: join(root, "principles.md"),
    applicationsDir: join(root, "applications"),
  };
}

export function tasteApplicationPath(domain: string, home: string = resolveHiveHome()): string {
  return join(home, "taste", "applications", `${domain}.md`);
}

/**
 * Build the taste layer prefix.
 *
 * Always loads `principles.md` if present (~500 tokens, cache-stable, the canon
 * recognition set). Loads `applications/<domain>.md` when a valid domain hint
 * is supplied AND the file exists. Returns null if `principles.md` is missing
 * — the layer is optional, graceful absence is the contract.
 *
 * Cache discipline: byte-stable per domain hint. Without a hint, the output
 * is byte-stable across all sessions. With a hint, byte-stable per domain.
 */
export async function buildTasteLayer(domainHint?: string | null): Promise<string | null> {
  const paths = getTastePaths();
  if (!existsSync(paths.principles)) return null;

  const parts: string[] = [];

  const principles = (await Bun.file(paths.principles).text()).trim();
  parts.push(principles);

  if (domainHint && TASTE_DOMAIN_RE.test(domainHint)) {
    const appPath = tasteApplicationPath(domainHint);
    if (existsSync(appPath)) {
      const application = (await Bun.file(appPath).text()).trim();
      parts.push("\n---\n");
      parts.push(application);
    }
  }

  return parts.join("\n");
}

/** List domains for which an `applications/<domain>.md` file exists. */
export async function listTasteDomains(): Promise<string[]> {
  const { applicationsDir } = getTastePaths();
  if (!existsSync(applicationsDir)) return [];
  const entries = await readdir(applicationsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name.replace(/\.md$/, ""))
    .sort();
}

export function tasteIsConfigured(): boolean {
  return existsSync(getTastePaths().principles);
}
