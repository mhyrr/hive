import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { UsageError } from "./errors";
import { resolveHiveHome } from "./paths";
import { parseFrontmatter } from "./frontmatter";

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

/** Resolve templates/stacks/ relative to this module. */
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

// ---------------------------------------------------------------------------
// Stack detection + binding
// ---------------------------------------------------------------------------

/** Marker files at a project root → stack name. First match wins. */
const AUTO_DETECT_TABLE: [string, string][] = [
  ["mix.exs", "elixir"],
  ["package.json", "typescript"],
  ["Cargo.toml", "rust"],
  ["pyproject.toml", "python"],
];

/** Regex for valid stack names — same as initStack uses. */
export const STACK_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Read the explicit stack binding for a project.
 * Returns the stack name, "none" (opt-out), or null (no binding file).
 */
export function readStackBinding(projectId: string): string | null {
  const bindingPath = join(resolveHiveHome(), "projects", projectId, "stack");
  if (!existsSync(bindingPath)) return null;
  try {
    return readFileSync(bindingPath, "utf-8").trim() || null;
  } catch {
    // intentional: stack binding file unreadable — treat as unbound
    return null;
  }
}

/**
 * Auto-detect the stack from marker files at the project root.
 * Returns the stack name or null if nothing matches.
 */
export function autoDetectStack(projectPath: string): string | null {
  for (const [file, stack] of AUTO_DETECT_TABLE) {
    if (existsSync(join(projectPath, file))) return stack;
  }
  return null;
}

/**
 * Resolve the project path from a HIVE project config.
 */
function resolveProjectPath(projectId: string): string | null {
  const configPath = join(resolveHiveHome(), "projects", projectId, "config.md");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseFrontmatter(raw);
    return (parsed.attributes?.path as string) || null;
  } catch {
    // intentional: malformed project config — no path available
    return null;
  }
}

/**
 * Resolve the effective stack for a project.
 * Priority: explicit binding > auto-detect > null.
 * Returns null if no stack detected or explicitly opted out ("none").
 */
export function resolveProjectStack(projectId: string): string | null {
  const binding = readStackBinding(projectId);
  if (binding === "none") return null;
  if (binding) return binding;

  const projectPath = resolveProjectPath(projectId);
  if (!projectPath) return null;

  return autoDetectStack(projectPath);
}

/**
 * Named trigger surfaces per stack — the domains where a skill exists and
 * carries more than the model would reason out from memory.
 *
 * These ride in the cache-stable session-start prefix (see TK-024), so every
 * token persists forever. Keep each phrase short. Add stacks here as they
 * gain skill coverage; unknown stacks fall back to a generic phrasing.
 *
 * Exported so the tests can pin the surfaces themselves (TK-134) rather than
 * only the sentence they sit in.
 */
export const STACK_TRIGGERS: Record<string, string> = {
  elixir: "Phoenix contexts, Ecto, LiveView, OTP, or security patterns",
  typescript: "React components, Next.js routing, or TypeScript types",
};

/** Harness emitting the stack hint. Affects wording, not content. */
export type Harness = "claude" | "codex" | "pi";

/**
 * Build the session-start hint line for a detected stack.
 * Returns empty string if no stack.
 *
 * Two things could go in this sentence, and only one earns its place.
 *
 * TRIGGER CONDITION — kept. Naming the surfaces ("React components, Next.js
 * routing, TypeScript types") tells the model WHEN a skill is relevant, which
 * is information it can't recover from the skill's own name. TK-042 added
 * these after observing the soft prior phrasing ("Prefer X-* skills when they
 * apply") fail as a trigger, and Anthropic's Opus 4.8 guidance points the same
 * way: prescriptive "reach for this when X" beats a description that only says
 * what a thing is.
 *
 * MANDATED PROCEDURE — dropped (TK-134). The old tail ("Self-flagging a domain
 * concern without loading the skill is the anti-pattern") carried nothing the
 * named surfaces don't already carry. It's the always-do-X-before-Y shape,
 * which newer models follow as ritual even where it's wrong for the task.
 *
 * One wording serves both concerns, so the hint stays a pure function of
 * (stack, harness) — no model-conditional branch, and byte-stable for the
 * TK-024 cache-stable prefix.
 *
 * Codex harness: the Skill tool doesn't exist in Codex, so the conditional
 * "if the Skill tool is unavailable" wording is dead weight. TK-114 names the
 * skill file directly instead — same skills, same trigger, no Claude Code
 * tooling reference.
 */
export function buildStackHint(stack: string | null, harness: Harness = "claude"): string {
  if (!stack) return "";
  // Stacks without named surfaces (rust, python, ...) simply omit the clause —
  // there is nothing specific to say, and "canon for this stack's domain" is
  // a redundancy, not a trigger.
  const triggers = STACK_TRIGGERS[stack];
  const scope = triggers ? ` for ${triggers}` : "";
  const canon = `Project stack: ${stack}. The ${stack}-* skills carry this project's domain canon${scope}`;

  if (harness === "codex") {
    return `${canon} — read the matching ~/.claude/skills/${stack}-*/SKILL.md when the work calls for it.`;
  }

  return `${canon} — load the matching skill when the work calls for it. If the Skill tool is unavailable (e.g. Codex or --agent mode), read it directly: ~/.claude/skills/${stack}-*/SKILL.md`;
}

/**
 * Write a stack binding file. Pass "none" to opt out, or a stack name.
 */
export async function writeStackBinding(projectId: string, value: string): Promise<void> {
  const dir = join(resolveHiveHome(), "projects", projectId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "stack"), value + "\n");
}

/**
 * Remove the stack binding file (revert to auto-detection).
 */
export async function clearStackBinding(projectId: string): Promise<void> {
  const bindingPath = join(resolveHiveHome(), "projects", projectId, "stack");
  if (existsSync(bindingPath)) {
    await unlink(bindingPath);
  }
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
