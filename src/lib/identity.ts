import { existsSync } from "node:fs";
import { join } from "node:path";

import { getHivePaths } from "./paths";
import { resolveProjectFromCwd } from "./project";
import { buildStackHint, resolveProjectStack, type Harness } from "./stack";
import { buildTasteLayer, getTastePaths } from "./taste";

const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "SELF.md", "AGENTS.md", "TRUST.md"];

const DEFAULT_PERSONA = "dry";

/** Active persona name: explicit (--persona) → HIVE_PERSONA env → default. */
function resolvePersonaName(explicit?: string | null): string {
  return explicit || process.env.HIVE_PERSONA || DEFAULT_PERSONA;
}

/**
 * Load the swappable persona register from ~/.hive/personas/<name>.md.
 * Falls back to the default persona, then to null — a missing or misnamed
 * persona must never block a session, only quietly drop the register slot.
 */
async function loadPersona(home: string, explicit?: string | null): Promise<string | null> {
  const name = resolvePersonaName(explicit);
  const file = join(home, "personas", `${name}.md`);
  if (existsSync(file)) return await Bun.file(file).text();
  const fallback = join(home, "personas", `${DEFAULT_PERSONA}.md`);
  if (name !== DEFAULT_PERSONA && existsSync(fallback)) return await Bun.file(fallback).text();
  return null;
}

export interface CanonicalIdentityOpts {
  /** Project ID for memory + stack hint. Omit for a project-neutral prefix. */
  projectId?: string | null;
  /** Include the project's memory index/knowledge. */
  includeProjectMemory: boolean;
  /** Target harness — affects stack-hint wording (Codex has no Skill tool). Default "claude". */
  harness?: Harness;
  /**
   * Insert the swappable persona register after IDENTITY. Interactive sessions
   * only — non-interactive callers leave this false so their
   * identity stays persona-neutral (scope: interactive, per design 2026-06).
   */
  includePersona?: boolean;
  /** Explicit persona name (from --persona). Falls back to HIVE_PERSONA env, then default. */
  persona?: string | null;
}

/**
 * One resolved section of the identity prefix. `hive context` sizes these
 * individually; buildCanonicalIdentity renders them into the emitted string.
 */
export interface IdentityComponent {
  kind: "soul" | "persona" | "memory" | "stack-hint" | "taste";
  /** Human-readable name: "SOUL.md", "persona: dry", "_index.md", ... */
  label: string;
  /** Source file, when the component is file-backed (stack hint is not). */
  path: string | null;
  content: string;
}

/**
 * Resolve the components of the identity prefix, in emit order.
 * Shared by buildCanonicalIdentity (render) and `hive context` (audit),
 * so what gets measured is exactly what gets emitted.
 */
export async function collectIdentityComponents(
  opts: CanonicalIdentityOpts,
): Promise<IdentityComponent[]> {
  const paths = getHivePaths();
  const components: IdentityComponent[] = [];

  // 1. Soul stack
  for (const file of IDENTITY_FILES) {
    const filePath = join(paths.home, file);
    if (existsSync(filePath)) {
      const content = await Bun.file(filePath).text();
      components.push({ kind: "soul", label: file, path: filePath, content: content.trim() });
    }
  }

  // 2. Project memory — optional for cache-stable non-interactive callers
  if (opts.includeProjectMemory && opts.projectId) {
    const indexFile = join(paths.memoryProjectsDir, opts.projectId, "_index.md");
    const knowledgeFile = join(paths.memoryProjectsDir, opts.projectId, "knowledge.md");
    const memPath = existsSync(indexFile) ? indexFile : knowledgeFile;
    if (existsSync(memPath)) {
      const content = await Bun.file(memPath).text();
      components.push({
        kind: "memory",
        label: memPath === indexFile ? "_index.md" : "knowledge.md",
        path: memPath,
        content: content.trim(),
      });
    }
  }

  // 3. Stack hint (stable per project + harness; safe for cache)
  if (opts.projectId) {
    const stackHint = buildStackHint(resolveProjectStack(opts.projectId), opts.harness ?? "claude");
    if (stackHint) {
      components.push({ kind: "stack-hint", label: "stack hint", path: null, content: stackHint });
    }
  }

  // 4. Taste layer — late so it carries weight in interpretation ties
  const taste = await buildTasteLayer();
  if (taste) {
    components.push({
      kind: "taste",
      label: "taste layer",
      path: getTastePaths().principles,
      content: taste,
    });
  }

  // 5. Persona register — LAST: the voice register loses interpretation ties
  //    when it sits early in the emit, so it gets the loudest slot
  //    (Greg, 2026-08-23). Interactive sessions only.
  if (opts.includePersona) {
    const persona = await loadPersona(paths.home, opts.persona);
    if (persona) {
      components.push({
        kind: "persona",
        label: `persona: ${resolvePersonaName(opts.persona)}`,
        path: null,
        content: persona.trim(),
      });
    }
  }

  return components;
}

/**
 * Single source of truth for the HIVE identity prefix.
 *
 * Emit order (LATER sections carry more weight in system-prompt interpretation):
 *   1. Soul stack — SOUL → IDENTITY → SELF → AGENTS → TRUST
 *      (Session-reflection discipline lives in AGENTS.md, not as a separate section)
 *   2. Project memory — index (lightweight) else full knowledge (skipped if !includeProjectMemory)
 *   3. Stack hint — per-project skill trigger (stable per project)
 *   4. Taste layer — principles.md (last = loudest)
 *
 * Byte-stability: with `includeProjectMemory: false`, the output is stable
 * across invocations for a fixed projectId (soul files + stack hint mutate
 * only on user edits).
 */
async function buildCanonicalIdentity(opts: CanonicalIdentityOpts): Promise<string> {
  const components = await collectIdentityComponents(opts);
  const parts: string[] = [];

  for (const c of components) {
    switch (c.kind) {
      case "soul":
        parts.push(c.content);
        parts.push("\n---\n");
        break;
      case "taste":
      case "persona":
        parts.push("\n---\n");
        parts.push(c.content);
        parts.push("\n");
        break;
      default: // memory, stack-hint
        parts.push(c.content);
        parts.push("\n");
    }
  }

  return parts.join("\n");
}

export async function assembleIdentity(opts?: {
  harness?: Harness;
  includePersona?: boolean;
  persona?: string | null;
}): Promise<string> {
  return buildCanonicalIdentity({
    projectId: resolveProjectFromCwd(),
    includeProjectMemory: true,
    harness: opts?.harness,
    includePersona: opts?.includePersona,
    persona: opts?.persona,
  });
}

export function getIdentityName(): string {
  const paths = getHivePaths();
  const idPath = join(paths.home, "IDENTITY.md");
  if (!existsSync(idPath)) return "Claude";
  try {
    const content = require("fs").readFileSync(idPath, "utf-8");
    const match = content.match(/^- Name:\s*(.+)$/m);
    return match?.[1]?.trim() || "Claude";
  } catch {
    // intentional: IDENTITY.md unreadable — fall back to default name
    return "Claude";
  }
}
