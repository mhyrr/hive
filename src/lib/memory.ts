import { join } from "node:path";
import { readdir } from "node:fs/promises";

import { ensureDirectory, type HivePaths } from "./paths";
import { toIsoTimestamp, toDateLabel, now } from "./time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemorySection = "fact" | "convention" | "decision" | "question";

export type ProjectDecision = {
  ts: string | null;
  text: string;
  tags: string[];
  superseded?: boolean;
};

export type MemoryEntry = {
  text: string;
  tags: string[];
  superseded?: boolean;
  supersedes?: string;
};

export type ProjectMemorySnapshot = {
  raw: string;
  facts: MemoryEntry[];
  conventions: MemoryEntry[];
  decisions: ProjectDecision[];
  questions: MemoryEntry[];
};

export type LogEntry = {
  time: string;
  type: MemorySection;
  text: string;
};

export type SearchResult = {
  source: "knowledge" | "index" | "log";
  file: string;
  section?: string;
  entry: string;
  tags: string[];
  date?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const sectionHeaders = {
  facts: "## Durable Facts",
  conventions: "## Conventions",
  decisions: "## Decisions",
  questions: "## Open Questions",
} as const;

const sectionToHeader: Record<MemorySection, string> = {
  fact: sectionHeaders.facts,
  convention: sectionHeaders.conventions,
  decision: sectionHeaders.decisions,
  question: sectionHeaders.questions,
};

const expectedSectionOrder = [
  sectionHeaders.facts,
  sectionHeaders.conventions,
  sectionHeaders.decisions,
  sectionHeaders.questions,
] as const;

const MAX_ENTRY_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Paths — project memory is now a directory
// ---------------------------------------------------------------------------

export function memoryProjectDir(paths: HivePaths, projectId: string): string {
  return join(paths.memoryProjectsDir, projectId);
}

export function knowledgePath(paths: HivePaths, projectId: string): string {
  return join(memoryProjectDir(paths, projectId), "knowledge.md");
}

export function indexPath(paths: HivePaths, projectId: string): string {
  return join(memoryProjectDir(paths, projectId), "_index.md");
}

export function logDir(paths: HivePaths, projectId: string): string {
  return join(memoryProjectDir(paths, projectId), "log");
}

export function logFilePath(paths: HivePaths, projectId: string, date: Date = now()): string {
  return join(logDir(paths, projectId), `${toDateLabel(date)}.md`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
// Tag parsing — inline [tag1, tag2] at end of entry
// ---------------------------------------------------------------------------

const TAG_PATTERN = /\s*\[([^\]]+)\]\s*$/;

export function parseTags(text: string): { text: string; tags: string[] } {
  const match = text.match(TAG_PATTERN);
  if (!match) return { text: text.trim(), tags: [] };
  const tags = match[1]!.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  return { text: text.slice(0, match.index).trim(), tags };
}

export function formatTags(tags: string[]): string {
  if (tags.length === 0) return "";
  return ` [${tags.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Supersession — ~~old entry~~ → superseded YYYY-MM-DD
// ---------------------------------------------------------------------------

const SUPERSEDED_PATTERN = /^~~(.+?)~~\s*→\s*superseded\s+(\S+)$/;

function isSuperseded(line: string): boolean {
  return SUPERSEDED_PATTERN.test(line);
}

function formatSuperseded(text: string, date: Date = now()): string {
  return `~~${text}~~ → superseded ${toDateLabel(date)}`;
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

// ---------------------------------------------------------------------------
// Section extraction — shared between knowledge and legacy format
// ---------------------------------------------------------------------------

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

function extractEntries(content: string, header: string): MemoryEntry[] {
  return extractBullets(content, header).map((raw) => {
    if (isSuperseded(raw)) {
      const m = raw.match(SUPERSEDED_PATTERN)!;
      const { text, tags } = parseTags(m[1]!);
      return { text, tags, superseded: true };
    }
    const { text, tags } = parseTags(raw);
    return { text, tags };
  });
}

function extractDecisions(content: string): ProjectDecision[] {
  return extractBullets(content, sectionHeaders.decisions).map((raw) => {
    if (isSuperseded(raw)) {
      const m = raw.match(SUPERSEDED_PATTERN)!;
      const inner = m[1]!;
      const tsMatch = inner.match(/^\[([^\]]+)\]\s+(.*)$/);
      const { text, tags } = parseTags(tsMatch?.[2] ?? inner);
      return { ts: tsMatch?.[1]?.trim() ?? null, text, tags, superseded: true };
    }
    const tsMatch = raw.match(/^\[([^\]]+)\]\s+(.*)$/);
    const { text, tags } = parseTags(tsMatch?.[2] ?? raw);
    return { ts: tsMatch?.[1]?.trim() ?? null, text, tags };
  });
}

// ---------------------------------------------------------------------------
// Section append
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Knowledge file — the compiled project intelligence
// ---------------------------------------------------------------------------

function newKnowledgeFile(projectId: string): string {
  return `# Project Memory: ${projectId}\n\n${sectionHeaders.facts}\n(none yet)\n\n${sectionHeaders.conventions}\n(none yet)\n\n${sectionHeaders.decisions}\n(none yet)\n\n${sectionHeaders.questions}\n(none yet)\n`;
}

export async function ensureProjectMemoryDir(
  paths: HivePaths,
  projectId: string,
): Promise<string> {
  const dir = memoryProjectDir(paths, projectId);
  await ensureDirectory(dir);
  await ensureDirectory(logDir(paths, projectId));

  const kPath = knowledgePath(paths, projectId);
  const file = Bun.file(kPath);
  if (!(await file.exists())) {
    await Bun.write(kPath, newKnowledgeFile(projectId));
  }

  return dir;
}

// Backward compat alias
export const ensureProjectMemoryFile = ensureProjectMemoryDir;

export function memoryFilePath(paths: HivePaths, projectId: string): string {
  return knowledgePath(paths, projectId);
}

// ---------------------------------------------------------------------------
// Read knowledge
// ---------------------------------------------------------------------------

export async function readProjectMemorySnapshot(
  paths: HivePaths,
  projectId: string,
): Promise<ProjectMemorySnapshot> {
  await ensureProjectMemoryDir(paths, projectId);
  const kPath = knowledgePath(paths, projectId);
  const raw = await Bun.file(kPath).text();

  return {
    raw,
    facts: extractEntries(raw, sectionHeaders.facts),
    conventions: extractEntries(raw, sectionHeaders.conventions),
    decisions: extractDecisions(raw),
    questions: extractEntries(raw, sectionHeaders.questions),
  };
}

// ---------------------------------------------------------------------------
// Write to knowledge
// ---------------------------------------------------------------------------

export async function appendProjectMemory(
  paths: HivePaths,
  projectId: string,
  section: MemorySection,
  text: string,
  tags: string[] = [],
): Promise<void> {
  const cleaned = validateMemoryEntry(text);
  await ensureProjectMemoryDir(paths, projectId);
  const filePath = knowledgePath(paths, projectId);

  return enqueue(filePath, async () => {
    const content = await Bun.file(filePath).text();
    const header = sectionToHeader[section];
    const tagStr = formatTags(tags);

    const entry = section === "decision"
      ? `- [${toIsoTimestamp().slice(0, 10)}] ${cleaned}${tagStr}`
      : `- ${cleaned}${tagStr}`;

    const updated = appendToSection(content, header, entry);

    const check = validateMemoryStructure(updated);
    if (!check.valid) {
      throw new Error(`Memory write would corrupt file: ${check.error}`);
    }

    await Bun.write(filePath, updated);
  });
}

// ---------------------------------------------------------------------------
// Supersede an entry in knowledge
// ---------------------------------------------------------------------------

export async function supersedeEntry(
  paths: HivePaths,
  projectId: string,
  section: MemorySection,
  oldText: string,
  newText: string,
  tags: string[] = [],
): Promise<void> {
  const cleanedNew = validateMemoryEntry(newText);
  await ensureProjectMemoryDir(paths, projectId);
  const filePath = knowledgePath(paths, projectId);

  return enqueue(filePath, async () => {
    let content = await Bun.file(filePath).text();

    // Find and mark the old entry as superseded
    const lines = content.split("\n");
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("- ") && line.includes(oldText) && !isSuperseded(line.slice(2).trim())) {
        const rawEntry = line.slice(2).trim();
        lines[i] = `- ${formatSuperseded(rawEntry)}`;
        found = true;
        break;
      }
    }

    if (!found) {
      throw new Error(`Could not find active entry to supersede: "${oldText}"`);
    }

    content = lines.join("\n");

    // Append new entry with supersedes marker
    const header = sectionToHeader[section];
    const tagStr = formatTags(tags);

    const entry = section === "decision"
      ? `- [${toIsoTimestamp().slice(0, 10)}] ${cleanedNew}${tagStr}`
      : `- ${cleanedNew}${tagStr}`;

    const updated = appendToSection(content, header, entry);

    const check = validateMemoryStructure(updated);
    if (!check.valid) {
      throw new Error(`Memory write would corrupt file: ${check.error}`);
    }

    await Bun.write(filePath, updated);
  });
}

// ---------------------------------------------------------------------------
// Read section (formatted output)
// ---------------------------------------------------------------------------

export function readProjectMemorySection(
  snapshot: ProjectMemorySnapshot,
  section: "facts" | "conventions" | "decisions" | "questions" | "all",
  includeSuperseded = true,
): string {
  if (section === "all") {
    if (!includeSuperseded) {
      return filterSupersededFromRaw(snapshot.raw);
    }
    return snapshot.raw;
  }
  if (section === "decisions") {
    const filtered = includeSuperseded
      ? snapshot.decisions
      : snapshot.decisions.filter((d) => !d.superseded);
    return filtered
      .map((d) => {
        const tagStr = formatTags(d.tags);
        const prefix = d.superseded ? "~~" : "";
        const suffix = d.superseded ? `~~ → superseded` : "";
        return `- ${prefix}${d.ts ? `[${d.ts}] ` : ""}${d.text}${tagStr}${suffix}`;
      })
      .join("\n") || "(none yet)";
  }

  const entries = snapshot[section] as MemoryEntry[];
  const filtered = includeSuperseded ? entries : entries.filter((e) => !e.superseded);
  return filtered
    .map((e) => {
      const tagStr = formatTags(e.tags);
      if (e.superseded) return `- ~~${e.text}${tagStr}~~ → superseded`;
      return `- ${e.text}${tagStr}`;
    })
    .join("\n") || "(none yet)";
}

function filterSupersededFromRaw(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !(line.startsWith("- ~~") && line.includes("→ superseded")))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Session Log — raw daily capture (Layer 1)
// ---------------------------------------------------------------------------

export async function appendToLog(
  paths: HivePaths,
  projectId: string,
  entries: Array<{ type: MemorySection; content: string }>,
): Promise<string> {
  await ensureProjectMemoryDir(paths, projectId);
  const filePath = logFilePath(paths, projectId);
  const dateLabel = toDateLabel();

  const file = Bun.file(filePath);
  let existing = "";
  if (await file.exists()) {
    existing = await file.text();
  } else {
    existing = `# ${dateLabel}\n`;
  }

  const timestamp = toIsoTimestamp().slice(11, 16); // HH:MM
  const newLines = entries.map((e) => {
    const cleaned = validateMemoryEntry(e.content);
    return `- ${timestamp} | ${e.type} | ${cleaned}`;
  });

  const updated = `${existing.trimEnd()}\n${newLines.join("\n")}\n`;
  await Bun.write(filePath, updated);

  return filePath;
}

export async function readLog(
  paths: HivePaths,
  projectId: string,
  daysBack = 7,
): Promise<LogEntry[]> {
  const dir = logDir(paths, projectId);
  const entries: LogEntry[] = [];

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort().reverse();
  } catch {
    return entries;
  }

  // Only read recent files
  const cutoff = daysBack > 0 ? files.slice(0, daysBack) : files;

  for (const file of cutoff) {
    const content = await Bun.file(join(dir, file)).text();
    const date = file.replace(".md", "");

    for (const line of content.split("\n")) {
      const m = line.match(/^- (\d{2}:\d{2}) \| (\w+) \| (.+)$/);
      if (m) {
        entries.push({
          time: `${date}T${m[1]}`,
          type: m[2] as MemorySection,
          text: m[3]!.trim(),
        });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Index — auto-maintained summary (Layer 3)
// ---------------------------------------------------------------------------

export async function rebuildIndex(
  paths: HivePaths,
  projectId: string,
): Promise<string> {
  const snapshot = await readProjectMemorySnapshot(paths, projectId);
  const recentLog = await readLog(paths, projectId, 7);

  const activeFacts = snapshot.facts.filter((f) => !f.superseded);
  const activeConventions = snapshot.conventions.filter((c) => !c.superseded);
  const activeDecisions = snapshot.decisions.filter((d) => !d.superseded);
  const openQuestions = snapshot.questions.filter((q) => !q.superseded);

  // Collect all tags for the tag index
  const tagMap = new Map<string, number>();
  for (const entries of [activeFacts, activeConventions, openQuestions]) {
    for (const e of entries) {
      for (const t of e.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
    }
  }
  for (const d of activeDecisions) {
    for (const t of d.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
  }

  const sortedTags = [...tagMap.entries()].sort((a, b) => b[1] - a[1]);

  const recentDecisions = activeDecisions.slice(-5);
  const recentLogEntries = recentLog.slice(0, 10);

  const lines: string[] = [
    `# Index: ${projectId}`,
    ``,
    `> Auto-generated summary of project memory. Loaded at session start.`,
    `> Use search_memory for deeper queries. Edit knowledge.md for corrections.`,
    ``,
    `## Summary`,
    `- ${activeFacts.length} facts, ${activeConventions.length} conventions, ${activeDecisions.length} decisions, ${openQuestions.length} open questions`,
    ``,
  ];

  // Tag index
  if (sortedTags.length > 0) {
    lines.push(`## Tags`);
    lines.push(sortedTags.map(([tag, count]) => `\`${tag}\`(${count})`).join("  "));
    lines.push(``);
  }

  // Recent decisions
  if (recentDecisions.length > 0) {
    lines.push(`## Recent Decisions`);
    for (const d of recentDecisions) {
      lines.push(`- [${d.ts}] ${d.text}${formatTags(d.tags)}`);
    }
    lines.push(``);
  }

  // Open questions
  if (openQuestions.length > 0) {
    lines.push(`## Open Questions`);
    for (const q of openQuestions) {
      lines.push(`- ${q.text}${formatTags(q.tags)}`);
    }
    lines.push(``);
  }

  // Recent log activity
  if (recentLogEntries.length > 0) {
    lines.push(`## Recent Activity`);
    for (const e of recentLogEntries) {
      lines.push(`- ${e.time} | ${e.type} | ${e.text}`);
    }
    lines.push(``);
  }

  // Key facts (all of them — this is the navigational overview)
  if (activeFacts.length > 0) {
    lines.push(`## Key Facts`);
    for (const f of activeFacts) {
      lines.push(`- ${f.text}${formatTags(f.tags)}`);
    }
    lines.push(``);
  }

  // Conventions
  if (activeConventions.length > 0) {
    lines.push(`## Conventions`);
    for (const c of activeConventions) {
      lines.push(`- ${c.text}${formatTags(c.tags)}`);
    }
    lines.push(``);
  }

  const output = lines.join("\n");
  const iPath = indexPath(paths, projectId);
  await Bun.write(iPath, output);

  return output;
}

// ---------------------------------------------------------------------------
// Search — grep across all layers with ranked results
// ---------------------------------------------------------------------------

export async function searchMemory(
  paths: HivePaths,
  projectId: string,
  query: string,
  options: { tag?: string; section?: MemorySection; includeSuperseded?: boolean; logDays?: number } = {},
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const q = query.toLowerCase();
  const tagFilter = options.tag?.toLowerCase();

  // Layer 2: Knowledge (highest priority)
  const snapshot = await readProjectMemorySnapshot(paths, projectId);

  const searchSection = (
    entries: Array<MemoryEntry | ProjectDecision>,
    sectionName: string,
  ) => {
    for (const entry of entries) {
      if (!options.includeSuperseded && entry.superseded) continue;
      if (tagFilter && !entry.tags.some((t) => t === tagFilter)) continue;

      const entryText = "ts" in entry
        ? `[${(entry as ProjectDecision).ts}] ${entry.text}`
        : entry.text;

      if (entryText.toLowerCase().includes(q) || entry.tags.some((t) => t.includes(q))) {
        results.push({
          source: "knowledge",
          file: "knowledge.md",
          section: sectionName,
          entry: entryText,
          tags: entry.tags,
        });
      }
    }
  };

  if (!options.section || options.section === "fact") {
    searchSection(snapshot.facts, "facts");
  }
  if (!options.section || options.section === "convention") {
    searchSection(snapshot.conventions, "conventions");
  }
  if (!options.section || options.section === "decision") {
    searchSection(snapshot.decisions, "decisions");
  }
  if (!options.section || options.section === "question") {
    searchSection(snapshot.questions, "questions");
  }

  // Layer 3: Index
  const iPath = indexPath(paths, projectId);
  try {
    const indexContent = await Bun.file(iPath).text();
    for (const line of indexContent.split("\n")) {
      if (line.toLowerCase().includes(q) && line.startsWith("- ")) {
        // Don't duplicate entries already found in knowledge
        const stripped = line.slice(2).trim();
        if (!results.some((r) => r.entry.includes(stripped) || stripped.includes(r.entry))) {
          results.push({
            source: "index",
            file: "_index.md",
            entry: stripped,
            tags: [],
          });
        }
      }
    }
  } catch {
    // No index yet
  }

  // Layer 1: Log (lowest priority, recent only)
  const logEntries = await readLog(paths, projectId, options.logDays ?? 14);
  for (const entry of logEntries) {
    if (entry.text.toLowerCase().includes(q)) {
      results.push({
        source: "log",
        file: `log/${entry.time.slice(0, 10)}.md`,
        entry: `${entry.time} | ${entry.type} | ${entry.text}`,
        tags: [],
        date: entry.time.slice(0, 10),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Format search results for LLM consumption
// ---------------------------------------------------------------------------

export function formatSearchResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No memory entries found matching "${query}".`;
  }

  const lines: string[] = [
    `Found ${results.length} result(s) for "${query}":`,
    ``,
  ];

  // Group by source
  const knowledge = results.filter((r) => r.source === "knowledge");
  const log = results.filter((r) => r.source === "log");

  if (knowledge.length > 0) {
    lines.push(`### Knowledge (compiled)`);
    // Group by section
    const bySection = new Map<string, SearchResult[]>();
    for (const r of knowledge) {
      const key = r.section ?? "unknown";
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key)!.push(r);
    }
    for (const [section, entries] of bySection) {
      lines.push(`**${section}:**`);
      for (const e of entries) {
        const tagStr = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
        lines.push(`  - ${e.entry}${tagStr}`);
      }
    }
    lines.push(``);
  }

  if (log.length > 0) {
    lines.push(`### Session Log (raw)`);
    for (const e of log) {
      lines.push(`  - ${e.entry}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}
