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

export async function assembleIdentity(): Promise<string> {
  const paths = getHivePaths();
  const parts: string[] = [];

  // Load identity stack
  for (const file of IDENTITY_FILES) {
    const filePath = join(paths.home, file);
    if (existsSync(filePath)) {
      const content = await Bun.file(filePath).text();
      parts.push(content.trim());
      parts.push("\n---\n");
    }
  }

  // Detect and load project memory (prefer index, fall back to knowledge)
  const projectId = resolveProjectFromCwd();
  if (projectId) {
    const indexFile = join(paths.memoryProjectsDir, projectId, "_index.md");
    const knowledgeFile = join(paths.memoryProjectsDir, projectId, "knowledge.md");
    const memPath = existsSync(indexFile) ? indexFile : knowledgeFile;
    if (existsSync(memPath)) {
      const content = await Bun.file(memPath).text();
      parts.push(content.trim());
      parts.push("\n");
    }

    // Stack hint — stable per project, adds ~1 line
    const stackHint = buildStackHint(resolveProjectStack(projectId));
    if (stackHint) {
      parts.push(stackHint);
      parts.push("\n");
    }
  }

  // Append reflection protocol
  parts.push(REFLECTION_PROTOCOL);

  return parts.join("\n");
}

/**
 * Assemble a deterministic identity prefix for the heartbeat agent.
 *
 * Unlike `assembleIdentity()`, this is byte-stable across ticks: it loads
 * only the static identity stack (SOUL/IDENTITY/SELF/AGENTS/TRUST) plus the
 * reflection protocol and an optional stack hint. No project memory index,
 * no reflections — those mutate between ticks and would invalidate the
 * prompt cache.
 *
 * The stack hint is stable for a given project (stack binding doesn't change
 * between ticks), so including it preserves byte-stability. The heartbeat
 * temp file is already per-project, so per-project content is fine — cache
 * keying is per-path.
 *
 * Project-specific state (memory index, tickets, git, dispatch runs) is
 * delivered via the per-tick context brief in the user message, which sits
 * below the cached system prompt and doesn't break the cache.
 */
export async function assembleHeartbeatIdentity(projectId?: string): Promise<string> {
  const paths = getHivePaths();
  const parts: string[] = [];

  for (const file of IDENTITY_FILES) {
    const filePath = join(paths.home, file);
    if (existsSync(filePath)) {
      const content = await Bun.file(filePath).text();
      parts.push(content.trim());
      parts.push("\n---\n");
    }
  }

  // Stack hint — stable per project, safe for cache
  if (projectId) {
    const stackHint = buildStackHint(resolveProjectStack(projectId));
    if (stackHint) {
      parts.push(stackHint);
      parts.push("\n");
    }
  }

  parts.push(REFLECTION_PROTOCOL);

  return parts.join("\n");
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
