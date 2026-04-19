import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getHivePaths } from "./paths";
import { resolveProjectFromCwd } from "./project";
import { buildStackHint, resolveProjectStack } from "./stack";

const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "SELF.md", "AGENTS.md", "TRUST.md"];

const REFLECTION_PROTOCOL = `
## Session Reflection Protocol
Before ending any substantive session, review what you learned and call
reflect_session (or individual write_hive_memory calls) for:
- New durable facts about the project (architecture, constraints, gotchas)
- Conventions discovered or established
- Decisions made with their rationale
- Open questions that remain unresolved
Only record genuinely durable, non-obvious information.
Skip if the session was trivial (quick question, no new learnings).
`;

interface CanonicalIdentityOpts {
  /** Project ID for memory + stack hint. Omit for a project-neutral prefix. */
  projectId?: string | null;
  /** Include the project's memory index/knowledge. Heartbeat sets false for cache stability. */
  includeProjectMemory: boolean;
  /** Include ~/.hive/OVERRIDES.md at the very end (platform counter-weights). */
  includeOverrides: boolean;
}

/**
 * Single source of truth for the HIVE identity prefix.
 *
 * Emit order (LATER sections carry more weight in system-prompt interpretation):
 *   1. Soul stack — SOUL → IDENTITY → SELF → AGENTS → TRUST
 *   2. Project memory — index (lightweight) else full knowledge (skipped if !includeProjectMemory)
 *   3. Stack hint — per-project skill trigger (stable per project)
 *   4. Reflection protocol — session-end discipline
 *   5. OVERRIDES.md — platform counter-weights (last = loudest)
 *
 * Byte-stability: with `includeProjectMemory: false`, the output is stable
 * across invocations for a fixed projectId (soul files + stack hint + reflection
 * protocol + overrides all mutate only on user edits). This is what heartbeat
 * relies on for TK-024 cache discipline.
 */
async function buildCanonicalIdentity(opts: CanonicalIdentityOpts): Promise<string> {
  const paths = getHivePaths();
  const parts: string[] = [];

  // 1. Soul stack
  for (const file of IDENTITY_FILES) {
    const filePath = join(paths.home, file);
    if (existsSync(filePath)) {
      const content = await Bun.file(filePath).text();
      parts.push(content.trim());
      parts.push("\n---\n");
    }
  }

  // 2. Project memory — heartbeat skips for cache stability
  if (opts.includeProjectMemory && opts.projectId) {
    const indexFile = join(paths.memoryProjectsDir, opts.projectId, "_index.md");
    const knowledgeFile = join(paths.memoryProjectsDir, opts.projectId, "knowledge.md");
    const memPath = existsSync(indexFile) ? indexFile : knowledgeFile;
    if (existsSync(memPath)) {
      const content = await Bun.file(memPath).text();
      parts.push(content.trim());
      parts.push("\n");
    }
  }

  // 3. Stack hint (stable per project; safe for cache)
  if (opts.projectId) {
    const stackHint = buildStackHint(resolveProjectStack(opts.projectId));
    if (stackHint) {
      parts.push(stackHint);
      parts.push("\n");
    }
  }

  // 4. Reflection protocol
  parts.push(REFLECTION_PROTOCOL);

  // 5. Platform counter-weights — LAST so they carry the most weight
  if (opts.includeOverrides && existsSync(paths.overrides)) {
    const content = await Bun.file(paths.overrides).text();
    parts.push("\n---\n");
    parts.push(content.trim());
    parts.push("\n");
  }

  return parts.join("\n");
}

export async function assembleIdentity(): Promise<string> {
  return buildCanonicalIdentity({
    projectId: resolveProjectFromCwd(),
    includeProjectMemory: true,
    includeOverrides: true,
  });
}

/**
 * Assemble a deterministic identity prefix for the heartbeat agent.
 *
 * Byte-stable across ticks: skips project memory (which rebuilds on every tick).
 * Includes OVERRIDES.md because it's user-edited only — still cache-safe.
 * Project-specific state (memory index, tickets, git, dispatch runs) is
 * delivered via the per-tick context brief in the user message, below the
 * cached system prompt.
 */
export async function assembleHeartbeatIdentity(projectId?: string): Promise<string> {
  return buildCanonicalIdentity({
    projectId: projectId ?? null,
    includeProjectMemory: false,
    includeOverrides: true,
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
    return "Claude";
  }
}

export async function writeIdentityTempFile(): Promise<string> {
  const content = await assembleIdentity();
  const tempPath = join(tmpdir(), `hive-identity-${process.pid}.md`);
  await Bun.write(tempPath, content);
  return tempPath;
}

export function cleanupIdentityTempFile(): void {
  const tempPath = join(tmpdir(), `hive-identity-${process.pid}.md`);
  try {
    require("fs").unlinkSync(tempPath);
  } catch { /* already gone */ }
}
