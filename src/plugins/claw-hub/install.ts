import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { HubSkillDetail } from "./client";

export type InstalledSkillMeta = {
  skillId: string;
  version: string;
  installed: string;
};

/**
 * Write a hub skill to the skills directory with source-tracking frontmatter.
 */
export async function installSkill(
  skillsDir: string,
  detail: HubSkillDetail,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter = [
    "---",
    `source: claw-hub`,
    `skill-id: ${detail.id}`,
    `version: ${detail.version}`,
    `installed: ${today}`,
    "---",
  ].join("\n");

  const content = `${frontmatter}\n${detail.content.trim()}\n`;
  const filePath = join(skillsDir, `${detail.id}.md`);

  await Bun.write(filePath, content);

  return filePath;
}

/**
 * Parse frontmatter from an installed skill file.
 * Returns null if the file isn't a hub-installed skill.
 */
export function parseSkillFrontmatter(text: string): InstalledSkillMeta | null {
  const match = text.match(/^---\n([\s\S]*?)\n---/);

  if (!match) {
    return null;
  }

  const block = match[1];
  const source = extractField(block, "source");

  if (source !== "claw-hub") {
    return null;
  }

  const skillId = extractField(block, "skill-id");
  const version = extractField(block, "version");
  const installed = extractField(block, "installed");

  if (!skillId || !version || !installed) {
    return null;
  }

  return { skillId, version, installed };
}

function extractField(block: string, key: string): string | null {
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));

  return match ? match[1].trim() : null;
}

/**
 * List all hub-installed skills in the skills directory.
 */
export async function listInstalledHubSkills(
  skillsDir: string,
): Promise<InstalledSkillMeta[]> {
  let entries: string[];

  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const results: InstalledSkillMeta[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }

    const filePath = join(skillsDir, entry);
    const file = Bun.file(filePath);
    const text = await file.text();
    const meta = parseSkillFrontmatter(text);

    if (meta) {
      results.push(meta);
    }
  }

  return results;
}

/**
 * Remove a hub-installed skill by its skill ID.
 * Returns true if the file was found and removed.
 */
export async function removeSkill(
  skillsDir: string,
  skillId: string,
): Promise<boolean> {
  const filePath = join(skillsDir, `${skillId}.md`);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return false;
  }

  // Verify it's actually a hub skill before removing
  const text = await file.text();
  const meta = parseSkillFrontmatter(text);

  if (!meta) {
    return false;
  }

  await unlink(filePath);

  return true;
}
