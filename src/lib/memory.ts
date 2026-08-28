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
  /** Stable entry hash for knowledge hits — lets the caller bump only what it returned. */
  hash?: string;
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

// Session-start context is the scarcest resource the index spends (TK-133).
// Entries are truncated to a teaser with a search_memory pointer; each
// section carries a count cap AND a token budget (~4 chars/token) measured
// on the rendered line — whichever binds first. The budgets sum to ~1870
// tokens ≈ 7.5KB so a worst-case corpus of max-length entries still lands
// under the whole-index budget below.
const INDEX_ENTRY_MAX_CHARS = 400;
const INDEX_CAPS = {
  decisions: 5,
  questions: 10,
  activity: 10,
  facts: 15,
  conventions: 10,
} as const;
const INDEX_SECTION_TOKEN_BUDGETS = {
  decisions: 330,
  questions: 330,
  activity: 330,
  facts: 550,
  conventions: 330,
} as const;

// Target for a whole _index.md; `hive doctor` warns above this.
export const INDEX_SIZE_BUDGET_BYTES = 8 * 1024;

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

/**
 * Conservative suffix stripping, so a query and the entry that answers it don't
 * miss each other on inflection alone.
 *
 * The bug this fixes: "what model does the verifier use" scored ZERO against the
 * entry containing "Pass V (Opus: verifies candidates)... Models: Sonnet B/C,
 * Opus V". Every query term missed — `model` ≠ `models`, `verifier` ≠ `verifies`
 * — so BM25 gave it 0 and the entry was invisible rather than merely low-ranked.
 * Silent zero-recall is the worst failure a search can have: indistinguishable
 * from never having learned the thing.
 *
 * Deliberately lighter than Porter. Rules are ordered longest-first, first match
 * wins, and a rule is REJECTED if it would leave a stem under MIN_STEM. That
 * guard is what keeps over-merging in check: "notes" declines the `es` rule
 * (would give "not") and falls through to `s` → "note".
 *
 * Correctness here is convergence, not linguistics. Both the query and the
 * document run through the same function, so a stem only has to be consistent —
 * verify/verifies/verifier/verified all landing on "verif" is the whole job.
 */
const MIN_STEM = 4;
const SUFFIX_RULES = ["ies", "ied", "ier", "ing", "age", "ment", "ness", "es", "ed", "s", "y", "e"];

export function stem(token: string): string {
  if (token.length <= MIN_STEM) return token;
  for (const suffix of SUFFIX_RULES) {
    if (!token.endsWith(suffix)) continue;
    // Never strip the second `s` of a double — "class" is not a plural.
    if (suffix === "s" && token.endsWith("ss")) continue;
    const stemmed = token.slice(0, -suffix.length);
    if (stemmed.length >= MIN_STEM) return stemmed;
    // Too short: try a shorter suffix rather than mangling the word.
  }
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(stem);
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

// Identity is the prose. Tags and the recurrence marker are metadata riding on
// the same line — neither changes which entry this is, so both come off before
// hashing. Entries carrying no marker hash exactly as they did before it existed.
export function entryHash(text: string): string {
  const cleaned = parseRecurrence(parseTags(text).text).text;
  return createHash("sha256").update(cleaned).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Metadata Sidecar — _meta.json
// ---------------------------------------------------------------------------

export function metaPath(paths: HivePaths, projectId: string): string {
  return join(memoryProjectDir(paths, projectId), "_meta.json");
}

export async function readMeta(paths: HivePaths, projectId: string): Promise<MetaSidecar> {
  const file = Bun.file(metaPath(paths, projectId));
  try {
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // intentional: corrupted meta JSON — start fresh with empty sidecar
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

// A tag is a short label, not prose. Anything over-length or carrying
// sentence punctuation means the trailing bracket is entry text that the
// pattern over-matched — keep it as prose rather than ingesting garbage.
const TAG_MAX_CHARS = 40;
const TAG_PROSE_CHARS = /[.!?;:]/;

function isValidTag(tag: string): boolean {
  return tag.length <= TAG_MAX_CHARS && !TAG_PROSE_CHARS.test(tag);
}

export function parseTags(text: string): { text: string; tags: string[] } {
  const match = text.match(TAG_PATTERN);
  if (!match) return { text: text.trim(), tags: [] };
  const tags = match[1]!.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0 || tags.some((t) => !isValidTag(t))) {
    return { text: text.trim(), tags: [] };
  }
  return { text: text.slice(0, match.index).trim(), tags };
}

export function formatTags(tags: string[]): string {
  if (tags.length === 0) return "";
  return ` [${tags.join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Recurrence — one entry observed N times, not N entries
// ---------------------------------------------------------------------------

// TK-147: a gap the verifier re-observes night after night is the same question
// getting louder. The count is rendered into the entry line so it is visible
// where the entry is read, and sits between the prose and the tags:
//   - Is the heartbeat still earning its keep? _(seen 3×, last 2026-08-17)_ [gap]
const RECURRENCE_PATTERN = /\s*_\(seen (\d+)×, last (\d{4}-\d{2}-\d{2})\)_$/;

/** Split a marker off entry text. An unmarked entry has been seen once. */
export function parseRecurrence(text: string): {
  text: string;
  count: number;
  lastSeen: string | null;
} {
  const match = text.match(RECURRENCE_PATTERN);
  if (!match) return { text: text.trim(), count: 1, lastSeen: null };
  return {
    text: text.slice(0, match.index).trim(),
    count: Number(match[1]),
    lastSeen: match[2]!,
  };
}

export function formatRecurrence(count: number, date: string = toDateLabel()): string {
  return ` _(seen ${count}×, last ${date})_`;
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
// Hash-based mutations — Pass F (Apply) needs to operate by entryHash since
// the verifier (Opus) returns target_hash for supersede / merge decisions.
// ---------------------------------------------------------------------------

interface HashedEntryHit {
  lineIndex: number;
  rawLine: string;
  coreText: string;     // text used for entryHash (no ts, no tags)
  tags: string[];
  ts: string | null;    // decision timestamp if any
}

function findActiveEntryLineByHash(content: string, header: string, targetHash: string): HashedEntryHit | null {
  const idx = content.indexOf(header);
  if (idx === -1) return null;
  const after = idx + header.length;
  const nextHeading = content.slice(after).search(/\n## /);
  const end = nextHeading === -1 ? content.length : after + nextHeading;
  const sectionStart = after;

  const lines = content.split("\n");
  let runningOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = runningOffset;
    runningOffset += line.length + 1; // +1 for newline
    if (lineStart < sectionStart || lineStart >= end) continue;

    if (!line.startsWith("- ")) continue;
    const raw = line.slice(2).trim();
    if (!raw || isSuperseded(raw)) continue;

    // Strip optional decision timestamp prefix.
    const tsMatch = raw.match(/^\[([^\]]+)\]\s+(.*)$/);
    const ts = tsMatch ? tsMatch[1]!.trim() : null;
    const afterTs = tsMatch ? tsMatch[2]! : raw;

    const { text, tags } = parseTags(afterTs);
    if (entryHash(text) === targetHash) {
      return { lineIndex: i, rawLine: line, coreText: text, tags, ts };
    }
  }
  return null;
}

export async function supersedeEntryByHash(
  paths: HivePaths,
  projectId: string,
  section: MemorySection,
  targetHash: string,
  newText: string,
  newTags: string[] = [],
): Promise<{ supersededText: string; newHash: string }> {
  const cleanedNew = validateMemoryEntry(newText);
  await ensureProjectMemoryDir(paths, projectId);
  const filePath = knowledgePath(paths, projectId);
  const header = sectionToHeader[section];

  let supersededText = "";
  let newHash = "";

  await enqueue(filePath, async () => {
    let content = await Bun.file(filePath).text();
    const hit = findActiveEntryLineByHash(content, header, targetHash);
    if (!hit) {
      throw new Error(`No active ${section} entry with hash ${targetHash} in ${projectId}`);
    }

    const lines = content.split("\n");
    // Recompose the original raw entry (with ts + tags) so the strikethrough
    // preserves what was there, not just the core text.
    const original = hit.ts
      ? `[${hit.ts}] ${hit.coreText}${formatTags(hit.tags)}`
      : `${hit.coreText}${formatTags(hit.tags)}`;
    lines[hit.lineIndex] = `- ${formatSuperseded(original)}`;
    supersededText = hit.coreText;
    content = lines.join("\n");

    const tagStr = formatTags(newTags);
    const entry =
      section === "decision"
        ? `- [${toIsoTimestamp().slice(0, 10)}] ${cleanedNew}${tagStr}`
        : `- ${cleanedNew}${tagStr}`;
    const updated = appendToSection(content, header, entry);

    const check = validateMemoryStructure(updated);
    if (!check.valid) {
      throw new Error(`Memory write would corrupt file: ${check.error}`);
    }
    await Bun.write(filePath, updated);

    // Meta — drop old, create new.
    const meta = await readMeta(paths, projectId);
    delete meta.entries[targetHash];
    newHash = entryHash(cleanedNew);
    meta.entries[newHash] = createEntryMeta();
    await writeMeta(paths, projectId, meta);
  });

  return { supersededText, newHash };
}

/**
 * TK-147: record that an existing entry was observed again. Rewrites the line
 * in place with an incremented recurrence marker — no new entry, no new hash.
 *
 * Idempotence is per call, not per day: two calls on the same date leave
 * "seen 3×" then "seen 4×". Callers are nightly passes that see a given gap
 * once per run, so the count tracks nights observed.
 */
export async function markEntryRecurrence(
  paths: HivePaths,
  projectId: string,
  section: MemorySection,
  targetHash: string,
  date: string = toDateLabel(),
): Promise<{ count: number; text: string }> {
  await ensureProjectMemoryDir(paths, projectId);
  const filePath = knowledgePath(paths, projectId);
  const header = sectionToHeader[section];

  let count = 0;
  let coreText = "";

  await enqueue(filePath, async () => {
    let content = await Bun.file(filePath).text();
    const hit = findActiveEntryLineByHash(content, header, targetHash);
    if (!hit) {
      throw new Error(`No active ${section} entry with hash ${targetHash} in ${projectId}`);
    }

    const prior = parseRecurrence(hit.coreText);
    count = prior.count + 1;
    coreText = prior.text;

    const lines = content.split("\n");
    const tsPart = hit.ts ? `[${hit.ts}] ` : "";
    lines[hit.lineIndex] =
      `- ${tsPart}${coreText}${formatRecurrence(count, date)}${formatTags(hit.tags)}`;
    content = lines.join("\n");

    const check = validateMemoryStructure(content);
    if (!check.valid) {
      throw new Error(`Memory write would corrupt file: ${check.error}`);
    }
    await Bun.write(filePath, content);

    // The damped bump, not the full one: a re-observation is the machine
    // noticing again, not a human recalling. Enough to keep a still-open
    // question from decaying out of the index while it keeps recurring.
    const meta = await readMeta(paths, projectId);
    const existing = meta.entries[targetHash];
    if (existing) {
      meta.entries[targetHash] = bumpRecallDamped(existing);
      await writeMeta(paths, projectId, meta);
    }
  });

  return { count, text: coreText };
}

export async function mergeTagsIntoEntry(
  paths: HivePaths,
  projectId: string,
  section: MemorySection,
  targetHash: string,
  addedTags: string[],
): Promise<{ mergedTags: string[]; addedTags: string[] }> {
  await ensureProjectMemoryDir(paths, projectId);
  const filePath = knowledgePath(paths, projectId);
  const header = sectionToHeader[section];
  const normalized = addedTags.map((t) => t.trim().toLowerCase()).filter(Boolean);

  let resultMerged: string[] = [];
  let resultAdded: string[] = [];

  await enqueue(filePath, async () => {
    let content = await Bun.file(filePath).text();
    const hit = findActiveEntryLineByHash(content, header, targetHash);
    if (!hit) {
      throw new Error(`No active ${section} entry with hash ${targetHash} in ${projectId}`);
    }

    const existingSet = new Set(hit.tags);
    const additions = normalized.filter((t) => !existingSet.has(t));
    if (additions.length === 0) {
      // No-op merge — return without touching the file.
      resultMerged = hit.tags;
      resultAdded = [];
      return;
    }

    const merged = [...hit.tags, ...additions];
    const lines = content.split("\n");
    const tsPart = hit.ts ? `[${hit.ts}] ` : "";
    lines[hit.lineIndex] = `- ${tsPart}${hit.coreText}${formatTags(merged)}`;
    content = lines.join("\n");

    const check = validateMemoryStructure(content);
    if (!check.valid) {
      throw new Error(`Memory write would corrupt file: ${check.error}`);
    }
    await Bun.write(filePath, content);

    resultMerged = merged;
    resultAdded = additions;
  });

  return { mergedTags: resultMerged, addedTags: resultAdded };
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
    // intentional: log directory doesn't exist yet — no entries to return
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

// ---------------------------------------------------------------------------
// Canon digest — one line per active entry, strongest first, under a budget.
// For prompts that need to know what canon already holds without carrying the
// whole file. Pass B used to receive the full knowledge.md as "do not
// duplicate"; by 2026-08-28 that was 46k–66k tokens against a 16k excerpt
// budget, and the extractor's yield tracked the canon's size, not the day's.
// ---------------------------------------------------------------------------

export const CANON_DIGEST_ENTRY_MAX_CHARS = 220;
export const CANON_DIGEST_BUDGET_TOKENS = 12_000;

type CanonSection = "fact" | "convention" | "decision" | "question";
const CANON_SECTION_LABELS: Record<CanonSection, string> = {
  fact: "Facts",
  convention: "Conventions",
  decision: "Decisions",
  question: "Open questions",
};

export interface CanonDigestOptions {
  maxEntryChars?: number;
  budgetTokens?: number;
}

/** Active canon entries as `- [section] text…` lines, grouped by section,
 * weakest entries dropped first when the budget binds. `[gap]` questions are
 * excluded — they are the pipeline talking about itself. */
export async function renderCanonDigest(
  paths: HivePaths,
  projectId: string,
  options: CanonDigestOptions = {},
): Promise<string> {
  const snapshot = await readProjectMemorySnapshot(paths, projectId);
  const meta = await readMeta(paths, projectId);
  const maxChars = options.maxEntryChars ?? CANON_DIGEST_ENTRY_MAX_CHARS;
  const budget = options.budgetTokens ?? CANON_DIGEST_BUDGET_TOKENS;

  type Row = { section: CanonSection; line: string; strength: number };
  const rows: Row[] = [];
  const clip = (text: string): string =>
    text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}…`;
  const collect = (
    section: CanonSection,
    entries: Array<{ text: string; tags: string[]; superseded?: boolean }>,
  ): void => {
    for (const e of entries) {
      if (e.superseded || e.tags.includes("gap")) continue;
      rows.push({
        section,
        line: `- [${section}] ${clip(e.text)}`,
        strength: entryStrength(meta.entries[entryHash(e.text)]),
      });
    }
  };
  collect("fact", snapshot.facts);
  collect("convention", snapshot.conventions);
  collect("decision", snapshot.decisions);
  collect("question", snapshot.questions);

  const ranked = [...rows].sort((a, b) => b.strength - a.strength);
  const kept = new Set<Row>();
  let tokens = 0;
  for (const r of ranked) {
    const cost = Math.ceil(r.line.length / 4);
    if (tokens + cost > budget) continue;
    kept.add(r);
    tokens += cost;
  }
  const dropped = rows.length - kept.size;

  const lines: string[] = [];
  for (const section of Object.keys(CANON_SECTION_LABELS) as CanonSection[]) {
    const group = rows.filter((r) => r.section === section && kept.has(r));
    if (group.length === 0) continue;
    lines.push(`### ${CANON_SECTION_LABELS[section]} (${group.length})`);
    for (const r of group) lines.push(r.line);
    lines.push("");
  }
  if (dropped > 0) {
    lines.push(`_(${dropped} weaker entries omitted to fit the budget)_`);
  }
  return lines.join("\n").trim();
}

export interface CanonEntryCreated {
  section: CanonSection;
  text: string;
  createdAt: string;
}

/** Active, non-gap canon entries whose meta `createdAt` falls within
 * [sinceLabel, untilLabel] (inclusive YYYY-MM-DD labels). A decision with no
 * meta row falls back to its own timestamp. */
export async function canonEntriesCreatedBetween(
  paths: HivePaths,
  projectId: string,
  sinceLabel: string,
  untilLabel: string,
): Promise<CanonEntryCreated[]> {
  const snapshot = await readProjectMemorySnapshot(paths, projectId);
  const meta = await readMeta(paths, projectId);
  const out: CanonEntryCreated[] = [];
  const consider = (
    section: CanonSection,
    entries: Array<{ text: string; tags: string[]; superseded?: boolean; ts?: string | null }>,
  ): void => {
    for (const e of entries) {
      if (e.superseded || e.tags.includes("gap")) continue;
      const createdAt = meta.entries[entryHash(e.text)]?.createdAt ?? e.ts ?? null;
      if (!createdAt) continue;
      if (createdAt < sinceLabel || createdAt > untilLabel) continue;
      out.push({ section, text: e.text, createdAt });
    }
  };
  consider("fact", snapshot.facts);
  consider("convention", snapshot.conventions);
  consider("decision", snapshot.decisions);
  consider("question", snapshot.questions);
  return out;
}

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

  // Sort entries by strength descending, cap by count then token budget.
  // Budgets are measured on the rendered line (text + tags + prefixes) so
  // the whole-index size target holds regardless of tag or timestamp bulk.
  const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
  const truncateForIndex = (text: string): string => {
    if (text.length <= INDEX_ENTRY_MAX_CHARS) return text;
    const cut = text.slice(0, INDEX_ENTRY_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(" ");
    const head = (lastSpace > INDEX_ENTRY_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
    return `${head} … _(truncated — search_memory for the rest)_`;
  };
  const sortByStrength = <T extends MemoryEntry>(entries: T[]): T[] => {
    return [...entries].sort((a, b) => {
      const sa = entryStrength(meta.entries[entryHash(a.text)]);
      const sb = entryStrength(meta.entries[entryHash(b.text)]);
      return sb - sa;
    });
  };
  const budgetSlice = <T>(
    entries: T[],
    cap: number,
    budget: number,
    render: (e: T) => string,
  ): T[] => {
    let tokens = 0;
    const result: T[] = [];
    for (const e of entries.slice(0, cap)) {
      const cost = estimateTokens(render(e));
      if (tokens + cost > budget && result.length > 0) break;
      result.push(e);
      tokens += cost;
    }
    return result;
  };
  const renderEntry = (e: MemoryEntry): string =>
    `- ${truncateForIndex(e.text)}${formatTags(e.tags)}`;
  const renderDecision = (d: ProjectDecision): string =>
    `- [${d.ts}] ${truncateForIndex(d.text)}${formatTags(d.tags)}`;
  const renderLog = (e: LogEntry): string =>
    `- ${e.time} | ${e.type} | ${truncateForIndex(e.text)}`;

  const rankedFacts = sortByStrength(activeFacts);
  const rankedConventions = sortByStrength(activeConventions);
  // `[gap]` questions are the pipeline reporting on itself — they live in
  // runs/{DATE}/gaps.md and knowledge.md, not in session-start context.
  const rankedQuestions = sortByStrength(
    openQuestions.filter((q) => !q.tags.includes("gap")),
  );

  // Compute the slices that will land in the index up front so we can both
  // render them and bump their recall metadata (auto-load strengthening).
  const displayFacts = budgetSlice(
    rankedFacts, INDEX_CAPS.facts, INDEX_SECTION_TOKEN_BUDGETS.facts, renderEntry,
  );
  const displayConventions = budgetSlice(
    rankedConventions, INDEX_CAPS.conventions, INDEX_SECTION_TOKEN_BUDGETS.conventions, renderEntry,
  );
  const displayQuestions = budgetSlice(
    rankedQuestions, INDEX_CAPS.questions, INDEX_SECTION_TOKEN_BUDGETS.questions, renderEntry,
  );

  // Decisions keep the most recent under budget; log entries arrive newest-first.
  const recentDecisions = budgetSlice(
    [...activeDecisions].reverse(),
    INDEX_CAPS.decisions,
    INDEX_SECTION_TOKEN_BUDGETS.decisions,
    renderDecision,
  ).reverse();
  const recentLogEntries = budgetSlice(
    recentLog, INDEX_CAPS.activity, INDEX_SECTION_TOKEN_BUDGETS.activity, renderLog,
  );

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

  // Recent decisions
  if (recentDecisions.length > 0) {
    lines.push(`## Recent Decisions`);
    for (const d of recentDecisions) {
      lines.push(renderDecision(d));
    }
    if (activeDecisions.length > recentDecisions.length) {
      lines.push(`- _(${activeDecisions.length - recentDecisions.length} more — use search_memory for full results)_`);
    }
    lines.push(``);
  }

  // Open questions — gap-filtered, strength-ranked, count-capped
  if (displayQuestions.length > 0) {
    lines.push(`## Open Questions`);
    for (const q of displayQuestions) {
      lines.push(renderEntry(q));
    }
    if (rankedQuestions.length > displayQuestions.length) {
      lines.push(`- _(${rankedQuestions.length - displayQuestions.length} more — use search_memory for full results)_`);
    }
    lines.push(``);
  }

  // Recent log activity
  if (recentLogEntries.length > 0) {
    lines.push(`## Recent Activity`);
    for (const e of recentLogEntries) {
      lines.push(renderLog(e));
    }
    lines.push(``);
  }

  // Key facts — strength-ranked, count-capped, token-budgeted
  if (rankedFacts.length > 0) {
    lines.push(`## Key Facts`);
    for (const f of displayFacts) {
      lines.push(renderEntry(f));
    }
    if (rankedFacts.length > displayFacts.length) {
      lines.push(`- _(${rankedFacts.length - displayFacts.length} more — use search_memory for full results)_`);
    }
    lines.push(``);
  }

  // Conventions — strength-ranked, count-capped, token-budgeted
  if (rankedConventions.length > 0) {
    lines.push(`## Conventions`);
    for (const c of displayConventions) {
      lines.push(renderEntry(c));
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
    ...displayQuestions,
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

/** Results plus how many cleared the relevance floor, so callers can say what they dropped. */
export interface SearchOutcome {
  results: SearchResult[];
  /** Matches above the floor, before topK. `results.length` when nothing was cut. */
  total: number;
}

/**
 * Default result cap. Measured median before this existed: 24 results, ~2,800 tokens.
 *
 * 10 rather than 8 because the floor already trims sharp queries on its own — a
 * well-aimed query comes back with three or six results and never reaches the cap.
 * The cap only binds on VAGUE queries, which are precisely the ones that need more
 * recall, not less. Measured against known-answer queries, truth landed at rank 9
 * and 10 for two reasonable phrasings; 10 costs ~250 tokens over 8 and converts
 * both from misses to hits.
 */
export const SEARCH_TOP_K = 10;
/** Keep only results scoring at least this fraction of the best hit (taste uses the same). */
export const SEARCH_FLOOR = 0.25;

export async function searchMemory(
  paths: HivePaths,
  projectId: string,
  query: string,
  options: {
    tag?: string;
    section?: MemorySection;
    includeSuperseded?: boolean;
    logDays?: number;
    /** Hard cap on returned results. Default SEARCH_TOP_K. */
    topK?: number;
    /** Relative relevance floor as a fraction of the top score. Default SEARCH_FLOOR. */
    floor?: number;
    /**
     * Blend raw session-log entries into the results. Default FALSE — logs are
     * episodic and were the bulk of the volume that made search unreadable.
     * Turn on deliberately when doing forensics ("when did we change X").
     */
    includeLogs?: boolean;
    /** Skip retrieval strengthening. For internal probes (dedupe checks) that no human reads. */
    noBump?: boolean;
  } = {},
): Promise<SearchOutcome> {
  const results: SearchResult[] = [];
  const tagFilter = options.tag?.toLowerCase();
  const topK = options.topK ?? SEARCH_TOP_K;
  const floor = options.floor ?? SEARCH_FLOOR;
  const includeLogs = options.includeLogs ?? false;

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

  // Collect log entries only when explicitly asked. Keeping them out of the
  // corpus as well as the results matters: they dominated the document count,
  // which skewed IDF against the compiled knowledge we actually want ranked.
  const logEntries = includeLogs ? await readLog(paths, projectId, options.logDays ?? 14) : [];
  const logTexts = logEntries.map((e) => e.text);

  // Build BM25 corpus from all searchable documents
  const allDocs = [...allEntries.map((e) => e.text), ...logTexts];
  const corpus = buildCorpus(allDocs);

  // Score knowledge entries
  for (const item of allEntries) {
    const score = bm25Score(query, item.text, corpus);
    if (score > 0) {
      const hash = entryHash(item.entry.text);
      const strength = entryStrength(meta.entries[hash]);

      results.push({
        source: "knowledge",
        hash,
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

  // Sort, then cut twice. The relative floor does the real work — a sharp query
  // has one dominant hit and returns two or three results, while a vague one gets
  // truncated instead of dumping half the store. topK is the backstop for the
  // case where twenty entries genuinely score alike.
  results.sort((a, b) => b.score - a.score);
  const top = results[0]?.score ?? 0;
  const relevant = top > 0 ? results.filter((r) => r.score >= floor * top) : results;
  const kept = relevant.slice(0, topK);

  // Retrieval strengthening — bump ONLY what was returned. Bumping every entry
  // that scored above zero (the prior behavior) strengthened up to 162 entries
  // on a single search, which flattens the decay signal it is meant to sharpen:
  // if everything gets recalled, nothing ever ranks lower. Mirrors the same fix
  // made for the auto-loaded index in TK-133.
  if (!options.noBump) {
    let changed = false;
    for (const r of kept) {
      const hash = r.hash;
      if (!hash || !meta.entries[hash]) continue;
      meta.entries[hash] = bumpRecall(meta.entries[hash]!);
      changed = true;
    }
    if (changed) {
      await writeMeta(paths, projectId, meta);
    }
  }

  return { results: kept, total: relevant.length };
}

// ---------------------------------------------------------------------------
// Format search results for LLM consumption
// ---------------------------------------------------------------------------

export function formatSearchResults(
  results: SearchResult[],
  query: string,
  total = results.length,
): string {
  if (results.length === 0) {
    return `No memory entries found matching "${query}".`;
  }

  // Say what was dropped. A cap that hides its own truncation reads as coverage
  // it doesn't have — the caller should know to narrow or raise the limit.
  const shown = total > results.length
    ? `Showing top ${results.length} of ${total} matches for "${query}" (ranked by relevance; narrow the query or pass top_k for more):`
    : `Found ${results.length} result(s) for "${query}" (ranked by relevance):`;
  const lines: string[] = [shown, ``];

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
  directive?: boolean;       // user explicitly directed the save — verifier may place but not reject (TK-123)
  writtenAt: string;         // ISO UTC
};

export type CandidateInput = {
  type: MemorySection;
  content: string;
  tags?: string[];
  provenanceNote?: string;
  supersedesHint?: string;
  directive?: boolean;
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
    ...(input.directive ? { directive: true } : {}),
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
      ...(input.directive ? { directive: true } : {}),
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
      // intentional: skip malformed JSONL lines — append-only format tolerates partial corruption
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
