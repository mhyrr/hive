import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

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
  score: number;
};

// Metadata sidecar types — decay & retrieval strengthening
export type EntryMeta = {
  createdAt: string;
  lastRecalled: string | null;
  recallCount: number;
  halfLife: number;
};

export type MetaSidecar = {
  entries: Record<string, EntryMeta>;
  version: number;
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

// Index budget: approximate token cap per section (facts, conventions).
// ~4 chars per token is a rough heuristic. This replaces a fixed entry count
// so short entries pack more densely and verbose ones naturally limit themselves.
const INDEX_SECTION_TOKEN_BUDGET = 3000;

// BM25 parameters
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Decay parameters
const KNOWLEDGE_HALF_LIFE = 30; // days
const RETRIEVAL_BOOST = 7; // days added per searchMemory recall
const AUTOLOAD_BOOST = 1; // days added per index auto-load (damped)
const AUTOLOAD_RECALL_INCREMENT = 0.25; // fractional recall bump for auto-load
const MAX_HALF_LIFE = 90; // cap

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// BM25 Scoring
// ---------------------------------------------------------------------------

export type BM25Corpus = {
  docCount: number;
  avgDocLen: number;
  df: Map<string, number>; // document frequency per term
};

export function buildCorpus(documents: string[]): BM25Corpus {
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of documents) {
    const tokens = tokenize(doc);
    totalLen += tokens.length;
    const seen = new Set(tokens);
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  return {
    docCount: documents.length,
    avgDocLen: documents.length > 0 ? totalLen / documents.length : 1,
    df,
  };
}

export function bm25Score(query: string, document: string, corpus: BM25Corpus): number {
  const queryTerms = tokenize(query);
  const docTokens = tokenize(document);
  if (queryTerms.length === 0 || docTokens.length === 0) return 0;

  const docLen = docTokens.length;

  // Count term frequencies in this document
  const tf = new Map<string, number>();
  for (const t of docTokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    const termFreq = tf.get(term) ?? 0;
    if (termFreq === 0) continue;

    const docFreq = corpus.df.get(term) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log(
      (corpus.docCount - docFreq + 0.5) / (docFreq + 0.5) + 1,
    );

    // TF saturation with length normalization
    const tfNorm =
      (termFreq * (BM25_K1 + 1)) /
      (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / corpus.avgDocLen)));

    score += idf * tfNorm;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Entry Hashing — stable identity for metadata linkage
// ---------------------------------------------------------------------------

export function entryHash(text: string): string {
  const cleaned = parseTags(text).text;
  return createHash("sha256").update(cleaned).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Metadata Sidecar — _meta.json
// ---------------------------------------------------------------------------

export function metaPath(paths: HivePaths, projectId: string): string {
  return join(memoryProjectDir(paths, projectId), "_meta.json");
}

async function readMeta(paths: HivePaths, projectId: string): Promise<MetaSidecar> {
  const file = Bun.file(metaPath(paths, projectId));
  try {
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // Corrupted — start fresh
  }
  return { entries: {}, version: 1 };
}

async function writeMeta(paths: HivePaths, projectId: string, meta: MetaSidecar): Promise<void> {
  await Bun.write(metaPath(paths, projectId), JSON.stringify(meta, null, 2));
}

export function createEntryMeta(): EntryMeta {
  return {
    createdAt: toDateLabel(),
    lastRecalled: null,
    recallCount: 0,
    halfLife: KNOWLEDGE_HALF_LIFE,
  };
}

export function bumpRecall(meta: EntryMeta): EntryMeta {
  return {
    ...meta,
    lastRecalled: toDateLabel(),
    recallCount: meta.recallCount + 1,
    halfLife: Math.min(meta.halfLife + RETRIEVAL_BOOST, MAX_HALF_LIFE),
  };
}

// Damped variant for auto-load (index rebuild) — entries earning a slot in the
// session-start index strengthen, but more gently than explicit search recalls.
// recallCount becomes fractional; entryStrength's log2 multiplier handles it.
export function bumpRecallDamped(meta: EntryMeta): EntryMeta {
  return {
    ...meta,
    lastRecalled: toDateLabel(),
    recallCount: meta.recallCount + AUTOLOAD_RECALL_INCREMENT,
    halfLife: Math.min(meta.halfLife + AUTOLOAD_BOOST, MAX_HALF_LIFE),
  };
}

// ---------------------------------------------------------------------------
// Strength Calculation
// ---------------------------------------------------------------------------

export function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.max(0, (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

export function entryStrength(meta: EntryMeta | undefined): number {
  if (!meta) return 1.0; // no metadata = default strength (graceful degradation)
  const age = daysBetween(meta.createdAt, toDateLabel());
  const decayFactor = Math.pow(0.5, age / meta.halfLife);
  return decayFactor * (1 + Math.log2(meta.recallCount + 1));
}

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

    // Create metadata for the new entry
    const hash = entryHash(cleaned);
    const meta = await readMeta(paths, projectId);
    meta.entries[hash] = createEntryMeta();
    await writeMeta(paths, projectId, meta);
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

    // Remove old metadata, create fresh for new entry
    const oldHash = entryHash(oldText);
    const newHash = entryHash(cleanedNew);
    const meta = await readMeta(paths, projectId);
    delete meta.entries[oldHash];
    meta.entries[newHash] = createEntryMeta();
    await writeMeta(paths, projectId, meta);
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
  const meta = await readMeta(paths, projectId);

  const activeFacts = snapshot.facts.filter((f) => !f.superseded);
  const activeConventions = snapshot.conventions.filter((c) => !c.superseded);
  const activeDecisions = snapshot.decisions.filter((d) => !d.superseded);
  const openQuestions = snapshot.questions.filter((q) => !q.superseded);

  // Sort entries by strength descending, cap by token budget
  const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
  const sortByStrength = <T extends MemoryEntry>(entries: T[]): T[] => {
    return [...entries].sort((a, b) => {
      const sa = entryStrength(meta.entries[entryHash(a.text)]);
      const sb = entryStrength(meta.entries[entryHash(b.text)]);
      return sb - sa;
    });
  };
  const budgetSlice = <T extends MemoryEntry>(entries: T[]): T[] => {
    let tokens = 0;
    const result: T[] = [];
    for (const e of entries) {
      const cost = estimateTokens(e.text);
      if (tokens + cost > INDEX_SECTION_TOKEN_BUDGET && result.length > 0) break;
      result.push(e);
      tokens += cost;
    }
    return result;
  };

  const rankedFacts = sortByStrength(activeFacts);
  const rankedConventions = sortByStrength(activeConventions);
  const rankedQuestions = sortByStrength(openQuestions);

  // Compute the slices that will land in the index up front so we can both
  // render them and bump their recall metadata (auto-load strengthening).
  const displayFacts = budgetSlice(rankedFacts);
  const displayConventions = budgetSlice(rankedConventions);

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
    for (const q of rankedQuestions) {
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

  // Key facts — strength-ranked, token-budgeted
  if (rankedFacts.length > 0) {
    lines.push(`## Key Facts`);
    for (const f of displayFacts) {
      lines.push(`- ${f.text}${formatTags(f.tags)}`);
    }
    if (rankedFacts.length > displayFacts.length) {
      lines.push(`- _(${rankedFacts.length - displayFacts.length} more — use search_memory for full results)_`);
    }
    lines.push(``);
  }

  // Conventions — strength-ranked, token-budgeted
  if (rankedConventions.length > 0) {
    lines.push(`## Conventions`);
    for (const c of displayConventions) {
      lines.push(`- ${c.text}${formatTags(c.tags)}`);
    }
    if (rankedConventions.length > displayConventions.length) {
      lines.push(`- _(${rankedConventions.length - displayConventions.length} more — use search_memory for full results)_`);
    }
    lines.push(``);
  }

  const output = lines.join("\n");
  const iPath = indexPath(paths, projectId);
  await Bun.write(iPath, output);

  // Auto-load strengthening — entries that earned a slot in the index get a
  // damped recall bump. Closes the gap where searchMemory was the only path
  // that strengthened entries (Hippo retrieval-strengthening principle).
  const indexedEntries: Array<{ text: string }> = [
    ...displayFacts,
    ...displayConventions,
    ...rankedQuestions,
    ...recentDecisions,
  ];
  if (indexedEntries.length > 0) {
    let changed = false;
    for (const entry of indexedEntries) {
      const hash = entryHash(entry.text);
      if (meta.entries[hash]) {
        meta.entries[hash] = bumpRecallDamped(meta.entries[hash]!);
        changed = true;
      }
    }
    if (changed) {
      await writeMeta(paths, projectId, meta);
    }
  }

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
  const tagFilter = options.tag?.toLowerCase();

  // Load knowledge + metadata
  const snapshot = await readProjectMemorySnapshot(paths, projectId);
  const meta = await readMeta(paths, projectId);

  // Collect all knowledge entry texts for BM25 corpus building
  const allEntries: Array<{ text: string; fullText: string; section: string; tags: string[]; entry: MemoryEntry | ProjectDecision }> = [];

  const collectSection = (
    entries: Array<MemoryEntry | ProjectDecision>,
    sectionName: string,
    sectionKey: MemorySection,
  ) => {
    if (options.section && options.section !== sectionKey) return;
    for (const entry of entries) {
      if (!options.includeSuperseded && entry.superseded) continue;
      if (tagFilter && !entry.tags.some((t) => t === tagFilter)) continue;

      const fullText = "ts" in entry
        ? `[${(entry as ProjectDecision).ts}] ${entry.text}`
        : entry.text;

      // Include tags in searchable text
      allEntries.push({
        text: `${entry.text} ${entry.tags.join(" ")}`,
        fullText,
        section: sectionName,
        tags: entry.tags,
        entry,
      });
    }
  };

  collectSection(snapshot.facts, "facts", "fact");
  collectSection(snapshot.conventions, "conventions", "convention");
  collectSection(snapshot.decisions, "decisions", "decision");
  collectSection(snapshot.questions, "questions", "question");

  // Collect log entries
  const logEntries = await readLog(paths, projectId, options.logDays ?? 14);
  const logTexts = logEntries.map((e) => e.text);

  // Build BM25 corpus from all searchable documents
  const allDocs = [...allEntries.map((e) => e.text), ...logTexts];
  const corpus = buildCorpus(allDocs);

  // Score knowledge entries
  const recalledHashes: string[] = [];
  for (const item of allEntries) {
    const score = bm25Score(query, item.text, corpus);
    if (score > 0) {
      const hash = entryHash(item.entry.text);
      const strength = entryStrength(meta.entries[hash]);
      recalledHashes.push(hash);

      results.push({
        source: "knowledge",
        file: "knowledge.md",
        section: item.section,
        entry: item.fullText,
        tags: item.tags,
        score: score * strength,
      });
    }
  }

  // Score log entries
  const today = toDateLabel();
  const logDays = options.logDays ?? 14;
  for (const entry of logEntries) {
    const score = bm25Score(query, entry.text, corpus);
    if (score > 0) {
      const entryDate = entry.time.slice(0, 10);
      const age = daysBetween(entryDate, today);
      const recencyWeight = Math.max(0.1, 1.0 - (age / logDays) * 0.9);

      results.push({
        source: "log",
        file: `log/${entryDate}.md`,
        entry: `${entry.time} | ${entry.type} | ${entry.text}`,
        tags: [],
        date: entryDate,
        score: score * recencyWeight,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Retrieval strengthening — bump metadata for recalled knowledge entries
  if (recalledHashes.length > 0) {
    let changed = false;
    for (const hash of recalledHashes) {
      if (meta.entries[hash]) {
        meta.entries[hash] = bumpRecall(meta.entries[hash]!);
        changed = true;
      }
    }
    if (changed) {
      await writeMeta(paths, projectId, meta);
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
    `Found ${results.length} result(s) for "${query}" (ranked by relevance):`,
    ``,
  ];

  // Results are already sorted by score — present in order
  const knowledge = results.filter((r) => r.source === "knowledge");
  const log = results.filter((r) => r.source === "log");

  if (knowledge.length > 0) {
    lines.push(`### Knowledge (compiled)`);
    for (const e of knowledge) {
      const tagStr = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
      const scoreStr = ` (score: ${e.score.toFixed(2)})`;
      lines.push(`  - [${e.section}] ${e.entry}${tagStr}${scoreStr}`);
    }
    lines.push(``);
  }

  if (log.length > 0) {
    lines.push(`### Session Log (raw)`);
    for (const e of log) {
      const scoreStr = ` (score: ${e.score.toFixed(2)})`;
      lines.push(`  - ${e.entry}${scoreStr}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Candidates — mid-session writes pending nightly verifier admission.
// docs/specs/2026-04-26-memory-design.md §Mid-session memory writes
// ---------------------------------------------------------------------------

export type Candidate = {
  type: MemorySection;
  content: string;
  tags: string[];
  provenance: string;        // auto-attached at write time
  provenanceNote?: string;   // optional enrichment from caller
  supersedesHint?: string;   // hint for Pass V; verifier still owns the call
  writtenAt: string;         // ISO UTC
};

export type CandidateInput = {
  type: MemorySection;
  content: string;
  tags?: string[];
  provenanceNote?: string;
  supersedesHint?: string;
};

const CANDIDATES_HEADER =
  "# Candidates — pending verifier admission. Each line below is a JSON object.\n";

export function candidatesPath(paths: HivePaths, projectId: string): string {
  return join(memoryProjectDir(paths, projectId), "candidates.md");
}

function defaultProvenance(now: Date = new Date()): string {
  // No real session ID at MCP-call time; pid + UTC time is enough for the
  // verifier to correlate against the day's session digest.
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `session:pid-${process.pid} — agent-write at ${hh}:${mm}:${ss}Z`;
}

async function ensureCandidatesFile(paths: HivePaths, projectId: string): Promise<string> {
  await ensureProjectMemoryDir(paths, projectId);
  const file = candidatesPath(paths, projectId);
  if (!(await Bun.file(file).exists())) {
    await Bun.write(file, CANDIDATES_HEADER);
  }
  return file;
}

export async function appendCandidate(
  paths: HivePaths,
  projectId: string,
  input: CandidateInput,
  options: { now?: Date; provenanceOverride?: string } = {},
): Promise<Candidate> {
  const cleaned = validateMemoryEntry(input.content);
  const now = options.now ?? new Date();
  const candidate: Candidate = {
    type: input.type,
    content: cleaned,
    tags: (input.tags ?? []).map((t) => t.toLowerCase()),
    provenance: options.provenanceOverride ?? defaultProvenance(now),
    writtenAt: now.toISOString(),
    ...(input.provenanceNote ? { provenanceNote: input.provenanceNote } : {}),
    ...(input.supersedesHint ? { supersedesHint: input.supersedesHint } : {}),
  };

  const file = await ensureCandidatesFile(paths, projectId);
  const existing = await Bun.file(file).text();
  const sep = existing.endsWith("\n") ? "" : "\n";
  await Bun.write(file, existing + sep + JSON.stringify(candidate) + "\n");

  return candidate;
}

export async function appendCandidates(
  paths: HivePaths,
  projectId: string,
  inputs: CandidateInput[],
  options: { now?: Date; provenanceOverride?: string } = {},
): Promise<Candidate[]> {
  if (inputs.length === 0) return [];
  const file = await ensureCandidatesFile(paths, projectId);
  const lines: string[] = [];
  const candidates: Candidate[] = [];
  // Same wall-clock for the batch; provenance time matches the reflect call.
  const batchNow = options.now ?? new Date();

  for (const input of inputs) {
    const cleaned = validateMemoryEntry(input.content);
    const candidate: Candidate = {
      type: input.type,
      content: cleaned,
      tags: (input.tags ?? []).map((t) => t.toLowerCase()),
      provenance: options.provenanceOverride ?? defaultProvenance(batchNow),
      writtenAt: batchNow.toISOString(),
      ...(input.provenanceNote ? { provenanceNote: input.provenanceNote } : {}),
      ...(input.supersedesHint ? { supersedesHint: input.supersedesHint } : {}),
    };
    candidates.push(candidate);
    lines.push(JSON.stringify(candidate));
  }

  const existing = await Bun.file(file).text();
  const sep = existing.endsWith("\n") ? "" : "\n";
  await Bun.write(file, existing + sep + lines.join("\n") + "\n");
  return candidates;
}

export async function readCandidates(
  paths: HivePaths,
  projectId: string,
): Promise<Candidate[]> {
  const file = candidatesPath(paths, projectId);
  if (!(await Bun.file(file).exists())) return [];
  const content = await Bun.file(file).text();
  const out: Candidate[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && obj.type && obj.content) {
        out.push(obj as Candidate);
      }
    } catch {
      // Skip malformed lines — append-safety means we tolerate corruption.
    }
  }
  return out;
}

/**
 * Move the live candidates.md aside (typically into runs/{DATE}/) and reset
 * the live file to just its header. Used by Pass F (Apply) after verify.
 */
export async function drainCandidates(
  paths: HivePaths,
  projectId: string,
  destPath: string,
): Promise<{ drained: number; destPath: string }> {
  const file = candidatesPath(paths, projectId);
  if (!(await Bun.file(file).exists())) {
    return { drained: 0, destPath };
  }
  const content = await Bun.file(file).text();
  const candidates = await readCandidates(paths, projectId);
  await Bun.write(destPath, content);
  await Bun.write(file, CANDIDATES_HEADER);
  return { drained: candidates.length, destPath };
}
