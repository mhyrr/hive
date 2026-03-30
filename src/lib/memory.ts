import { join } from "node:path";

import { ensureDirectory, type HivePaths } from "./paths";
import { toIsoTimestamp } from "./time";

export type ProjectDecision = {
  ts: string | null;
  text: string;
};

export type ProjectMemorySnapshot = {
  raw: string;
  facts: string[];
  conventions: string[];
  decisions: ProjectDecision[];
  questions: string[];
};

const sectionHeaders = {
  facts: "## Durable Facts",
  conventions: "## Conventions",
  decisions: "## Decisions",
  questions: "## Open Questions",
} as const;

export type MemorySection = "fact" | "convention" | "decision" | "question";

const sectionToHeader: Record<MemorySection, string> = {
  fact: sectionHeaders.facts,
  convention: sectionHeaders.conventions,
  decision: sectionHeaders.decisions,
  question: sectionHeaders.questions,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_ENTRY_LENGTH = 1000;

const expectedSectionOrder = [
  sectionHeaders.facts,
  sectionHeaders.conventions,
  sectionHeaders.decisions,
  sectionHeaders.questions,
] as const;

export function validateMemoryEntry(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) throw new Error("Memory entry cannot be empty.");

  // Strip leading bullet if the caller included it
  if (cleaned.startsWith("- ")) cleaned = cleaned.slice(2).trim();

  // Reject section header injection
  if (cleaned.includes("## ")) {
    throw new Error("Memory entry cannot contain markdown headers (## ).");
  }

  // Reject runaway output
  if (cleaned.length > MAX_ENTRY_LENGTH) {
    throw new Error(`Memory entry exceeds ${MAX_ENTRY_LENGTH} characters (got ${cleaned.length}).`);
  }

  // Collapse internal newlines — multi-line entries break bullet parsing
  cleaned = cleaned.replace(/\n+/g, " ").trim();

  return cleaned;
}

export function validateMemoryStructure(content: string): { valid: boolean; error?: string } {
  if (!content.startsWith("# Project Memory:")) {
    return { valid: false, error: "File must start with '# Project Memory:'" };
  }

  const positions: number[] = [];
  for (const header of expectedSectionOrder) {
    const idx = content.indexOf(header);
    if (idx === -1) {
      return { valid: false, error: `Missing section: ${header}` };
    }
    // Check for duplicate headers
    if (content.indexOf(header, idx + header.length) !== -1) {
      return { valid: false, error: `Duplicate section: ${header}` };
    }
    positions.push(idx);
  }

  // Check order
  for (let i = 1; i < positions.length; i++) {
    if (positions[i]! <= positions[i - 1]!) {
      return { valid: false, error: "Sections are out of expected order." };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Write queue — serializes concurrent writes per file path
// ---------------------------------------------------------------------------

const writeQueue = new Map<string, Promise<void>>();

function enqueue(path: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueue.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run even if previous rejected
  writeQueue.set(path, next);
  return next;
}

function extractSectionBody(content: string, header: string): string {
  const idx = content.indexOf(header);
  if (idx === -1) return "";
  const after = idx + header.length;
  const next = content.slice(after).search(/\n## /);
  return content.slice(after, next === -1 ? content.length : after + next).trim();
}

function extractBullets(content: string, header: string): string[] {
  const body = extractSectionBody(content, header);
  if (!body || body.includes("(none yet)")) return [];
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

function extractDecisions(content: string): ProjectDecision[] {
  return extractBullets(content, sectionHeaders.decisions).map((entry) => {
    const m = entry.match(/^\[([^\]]+)\]\s+(.*)$/);
    return { ts: m?.[1]?.trim() ?? null, text: m?.[2]?.trim() ?? entry };
  });
}

export function appendToSection(content: string, header: string, entry: string): string {
  const idx = content.indexOf(header);
  if (idx === -1) return `${content.trimEnd()}\n\n${header}\n${entry}\n`;

  const after = idx + header.length;
  const next = content.slice(after).search(/\n## /);
  const end = next === -1 ? content.length : after + next;
  const body = content.slice(after, end);

  const updated = body.includes("(none yet)")
    ? body.replace("(none yet)", entry)
    : `${body.trimEnd()}\n${entry}`;

  return `${content.slice(0, after)}${updated.trimEnd()}\n${content.slice(end)}`;
}

export function memoryFilePath(paths: HivePaths, projectId: string): string {
  return join(paths.memoryProjectsDir, `${projectId}.md`);
}

export async function ensureProjectMemoryFile(
  paths: HivePaths,
  projectId: string,
): Promise<string> {
  const path = memoryFilePath(paths, projectId);
  const file = Bun.file(path);

  if (!(await file.exists())) {
    await ensureDirectory(paths.memoryProjectsDir);
    await Bun.write(path, `# Project Memory: ${projectId}\n\n${sectionHeaders.facts}\n(none yet)\n\n${sectionHeaders.conventions}\n(none yet)\n\n${sectionHeaders.decisions}\n(none yet)\n\n${sectionHeaders.questions}\n(none yet)\n`);
  }

  return path;
}

export async function readProjectMemorySnapshot(
  paths: HivePaths,
  projectId: string,
): Promise<ProjectMemorySnapshot> {
  const path = await ensureProjectMemoryFile(paths, projectId);
  const raw = await Bun.file(path).text();

  return {
    raw,
    facts: extractBullets(raw, sectionHeaders.facts),
    conventions: extractBullets(raw, sectionHeaders.conventions),
    decisions: extractDecisions(raw),
    questions: extractBullets(raw, sectionHeaders.questions),
  };
}

export async function appendProjectMemory(
  paths: HivePaths,
  projectId: string,
  section: MemorySection,
  text: string,
): Promise<void> {
  const cleaned = validateMemoryEntry(text);
  const filePath = await ensureProjectMemoryFile(paths, projectId);

  return enqueue(filePath, async () => {
    const content = await Bun.file(filePath).text();
    const header = sectionToHeader[section];

    const entry = section === "decision"
      ? `- [${toIsoTimestamp().slice(0, 10)}] ${cleaned}`
      : `- ${cleaned}`;

    const updated = appendToSection(content, header, entry);

    const check = validateMemoryStructure(updated);
    if (!check.valid) {
      throw new Error(`Memory write would corrupt file: ${check.error}`);
    }

    await Bun.write(filePath, updated);
  });
}

export function readProjectMemorySection(
  snapshot: ProjectMemorySnapshot,
  section: "facts" | "conventions" | "decisions" | "questions" | "all",
): string {
  if (section === "all") return snapshot.raw;
  if (section === "decisions") {
    return snapshot.decisions
      .map((d) => `- ${d.ts ? `[${d.ts}] ` : ""}${d.text}`)
      .join("\n") || "(none yet)";
  }
  return snapshot[section].map((e) => `- ${e}`).join("\n") || "(none yet)";
}
