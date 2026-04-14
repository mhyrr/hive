import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { UsageError } from "./errors";
import { resolveHiveHome } from "./paths";

export type StackPaths = {
  stacksRoot: string;
  userSkillsDir: string;
};

function resolveHome(): string {
  // Prefer env var so tests can redirect to a temp dir. `os.homedir()` ignores
  // $HOME on macOS (reads the passwd database), which makes it impossible to
  // sandbox in tests without this escape hatch.
  return process.env.HOME || homedir();
}

export function getStackPaths(): StackPaths {
  return {
    stacksRoot: join(resolveHiveHome(), "stacks"),
    userSkillsDir: join(resolveHome(), ".claude", "skills"),
  };
}

/** Resolve templates/stacks/ relative to this module. Matches how the project
 * command resolves its HEARTBEAT.md template. */
export function resolveTemplatesStacksDir(): string {
  return join(dirname(import.meta.dir), "..", "templates", "stacks");
}

export async function listCannedStacks(): Promise<string[]> {
  const dir = resolveTemplatesStacksDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

export type InstallResult = {
  stack: string;
  source: string;
  target: string;
  overwrote: boolean;
};

export async function installStack(
  name: string,
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  const source = join(resolveTemplatesStacksDir(), name);
  if (!existsSync(source)) {
    const available = await listCannedStacks();
    const hint = available.length > 0
      ? ` Available templates: ${available.join(", ")}.`
      : " No canned stacks available in this HIVE build.";
    throw new UsageError(`No template for stack '${name}'.${hint}`);
  }

  const target = stackSourceDir(name);
  const existed = existsSync(target);

  if (existed && !opts.force) {
    throw new UsageError(
      `Stack already installed at ${target}. Pass --force to overwrite (destroys local edits).`,
    );
  }

  if (existed) {
    await rm(target, { recursive: true, force: true });
  }

  await mkdir(getStackPaths().stacksRoot, { recursive: true });
  await cp(source, target, { recursive: true });

  return { stack: name, source, target, overwrote: existed };
}

export function stackSourceDir(stack: string): string {
  return join(getStackPaths().stacksRoot, stack);
}

export function stackSkillsSourceDir(stack: string): string {
  return join(stackSourceDir(stack), "skills");
}

export async function listSourceStacks(): Promise<string[]> {
  const { stacksRoot } = getStackPaths();
  if (!existsSync(stacksRoot)) return [];
  const entries = await readdir(stacksRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

export async function listSourceSkills(stack: string): Promise<string[]> {
  const skillsDir = stackSkillsSourceDir(stack);
  if (!existsSync(skillsDir)) return [];
  const entries = await readdir(skillsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function listSyncedSkills(stack: string): Promise<string[]> {
  const { userSkillsDir } = getStackPaths();
  if (!existsSync(userSkillsDir)) return [];

  const prefix = `${stack}-`;
  const entries = await readdir(userSkillsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name.slice(prefix.length))
    .sort();
}

export async function initStack(name: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new UsageError(`Invalid stack name '${name}'. Use lowercase letters, digits, and hyphens; start with a letter.`);
  }

  const target = stackSourceDir(name);
  if (existsSync(target)) {
    throw new UsageError(`Stack already exists at ${target}`);
  }

  await mkdir(join(target, "skills"), { recursive: true });
  await Bun.write(
    join(target, "README.md"),
    `# ${name} Stack\n\nDescribe what this stack covers.\n\nAdd skills under \`skills/<topic>/SKILL.md\`, then:\n\n    hive stack sync ${name}\n`,
  );

  return target;
}

/**
 * Rewrite SKILL.md frontmatter for deployment:
 *   - Set `name:` to the stack-prefixed skill name.
 *   - Strip block-list keys (e.g. `paths:` with indented `- value` lines).
 *     Claude Code's skill loader chokes on nested YAML and silently drops
 *     skills that use it; the path-scoping these fields expressed only had
 *     meaning inside the source plugin's own workflow machinery, which we
 *     intentionally don't import.
 *
 * Returns the original string if no frontmatter or no `name:` key.
 */
export function rewriteSkillName(content: string, newName: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return content;

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) return content;

  const frontmatter = normalized.slice(4, closingIndex);
  const rest = normalized.slice(closingIndex);

  const source = frontmatter.split("\n");
  const output: string[] = [];
  let replacedName = false;
  let skippingBlock = false;

  const isBlockListItem = (line: string): boolean => /^\s+-\s/.test(line);

  for (let i = 0; i < source.length; i++) {
    const line = source[i]!;

    if (skippingBlock) {
      if (line.length === 0 || /^\s/.test(line)) continue;
      skippingBlock = false;
    }

    if (/^name:\s*/.test(line)) {
      replacedName = true;
      output.push(`name: ${newName}`);
      continue;
    }

    // Key with no inline value. Could be a block list (drop) or a block map
    // (keep) — distinguish by peeking at the next non-empty line. `- item`
    // dashes mean block list.
    const blockKeyMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (blockKeyMatch) {
      const lookahead = source.slice(i + 1).find((peek) => peek.length > 0);
      if (lookahead && isBlockListItem(lookahead)) {
        skippingBlock = true;
        continue;
      }
    }

    output.push(line);
  }

  if (!replacedName) return content;

  return `---\n${output.join("\n")}${rest}`;
}

export type SyncResult = {
  stack: string;
  target: string;
  copied: string[];
  removed: string[];
};

export async function syncStack(stack: string): Promise<SyncResult> {
  const skillsSrc = stackSkillsSourceDir(stack);
  if (!existsSync(skillsSrc)) {
    throw new UsageError(`Stack '${stack}' not found at ${stackSourceDir(stack)}`);
  }

  const { userSkillsDir } = getStackPaths();
  await mkdir(userSkillsDir, { recursive: true });

  const sourceSkills = await listSourceSkills(stack);
  const existing = await listSyncedSkills(stack);

  const copied: string[] = [];
  for (const topic of sourceSkills) {
    const skillName = `${stack}-${topic}`;
    const targetDir = join(userSkillsDir, skillName);
    const sourceDir = join(skillsSrc, topic);

    await rm(targetDir, { recursive: true, force: true });
    await cp(sourceDir, targetDir, { recursive: true });

    const skillFile = join(targetDir, "SKILL.md");
    if (existsSync(skillFile)) {
      const original = await Bun.file(skillFile).text();
      const rewritten = rewriteSkillName(original, skillName);
      if (rewritten !== original) {
        await Bun.write(skillFile, rewritten);
      }
    }

    copied.push(skillName);
  }

  const removed: string[] = [];
  const sourceSet = new Set(sourceSkills);
  for (const topic of existing) {
    if (sourceSet.has(topic)) continue;
    const skillName = `${stack}-${topic}`;
    await rm(join(userSkillsDir, skillName), { recursive: true, force: true });
    removed.push(skillName);
  }

  return { stack, target: userSkillsDir, copied, removed };
}
