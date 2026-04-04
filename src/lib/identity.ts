import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getHivePaths } from "./paths";
import { parseFrontmatter } from "./frontmatter";

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

function detectProject(paths: ReturnType<typeof getHivePaths>): string | null {
  const cwd = process.cwd();
  if (!existsSync(paths.projectsDir)) return null;

  try {
    const entries = require("fs").readdirSync(paths.projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = join(paths.projectsDir, entry.name, "config.md");
      if (!existsSync(configPath)) continue;
      const raw = require("fs").readFileSync(configPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      const projectPath = parsed.attributes?.path as string | undefined;
      if (projectPath && cwd.startsWith(projectPath)) return entry.name;
    }
  } catch { /* skip */ }

  return null;
}

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
  const projectId = detectProject(paths);
  if (projectId) {
    const indexFile = join(paths.memoryProjectsDir, projectId, "_index.md");
    const knowledgeFile = join(paths.memoryProjectsDir, projectId, "knowledge.md");
    const memPath = existsSync(indexFile) ? indexFile : knowledgeFile;
    if (existsSync(memPath)) {
      const content = await Bun.file(memPath).text();
      parts.push(content.trim());
      parts.push("\n");
    }
  }

  // Load recent reflections (last 3 days) if any exist
  if (existsSync(paths.reflectionsDir)) {
    try {
      const files = readdirSync(paths.reflectionsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 3);

      if (files.length > 0) {
        const reflectionParts: string[] = [];
        for (const file of files) {
          const content = await Bun.file(join(paths.reflectionsDir, file)).text();
          if (content.trim()) reflectionParts.push(content.trim());
        }
        if (reflectionParts.length > 0) {
          parts.push("## Recent Self-Reflections\n");
          parts.push("> Extracted by nightly review. Pending promotion to identity files.\n");
          parts.push(reflectionParts.join("\n\n"));
          parts.push("\n---\n");
        }
      }
    } catch { /* no reflections yet */ }
  }

  // Append reflection protocol
  parts.push(REFLECTION_PROTOCOL);

  return parts.join("\n");
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
