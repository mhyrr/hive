import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { HivePaths } from "./paths";
import { getProjectPaths } from "./paths";
import { toDateLabel, toIsoTimestamp } from "./time";
import {
  appendProjectMemory,
  searchMemory,
  rebuildIndex,
} from "./memory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReflectionSection = "greg" | "maya" | "system";

export type ReflectionEntry = {
  text: string;
  section: ReflectionSection;
};

export type ReflectionFile = {
  date: string;
  path: string;
  entries: ReflectionEntry[];
  promoted: boolean;
};

export type PromotionResult = {
  promoted: number;
  skipped: number;
  proposed: number;
  details: string[];
};

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const SECTION_HEADERS: Record<string, ReflectionSection> = {
  "## about greg": "greg",
  "## about maya": "maya",
  "## about the system": "system",
};

export async function parseReflectionFile(
  filePath: string,
): Promise<ReflectionFile> {
  const content = await Bun.file(filePath).text();
  const lines = content.split("\n");

  // Check frontmatter for promoted flag
  let promoted = false;
  if (lines[0] === "---") {
    const fmEnd = lines.indexOf("---", 1);
    if (fmEnd > 0) {
      const fm = lines.slice(1, fmEnd).join("\n");
      promoted = /^promoted:/m.test(fm);
    }
  }

  const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  const date = dateMatch?.[1] ?? "";

  const entries: ReflectionEntry[] = [];
  let current: ReflectionSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    // Detect section headers
    for (const [header, section] of Object.entries(SECTION_HEADERS)) {
      if (lower === header) {
        current = section;
        break;
      }
    }

    // Collect bullet entries under current section
    if (current && trimmed.startsWith("- ")) {
      entries.push({ text: trimmed.slice(2).trim(), section: current });
    }
  }

  return { date, path: filePath, entries, promoted };
}

// ---------------------------------------------------------------------------
// V1 landing — Pass F appends accepted reflection candidates to today's file
// at ~/.hive/reflections/YYYY-MM-DD.md, in the same "## About Subject" format
// the V0 promoter understands.
// ---------------------------------------------------------------------------

export interface ReflectionLanding {
  subject: ReflectionSection;
  content: string;
  tags: string[];
  provenance: string;
}

const SUBJECT_HEADERS: Record<ReflectionSection, string> = {
  greg: "## About Greg",
  maya: "## About Maya",
  system: "## About the System",
};

function reflectionLine(landing: ReflectionLanding): string {
  const tagSuffix = landing.tags.length > 0 ? ` [${landing.tags.join(", ")}]` : "";
  return `- ${landing.content}${tagSuffix}  \n  _provenance:_ ${landing.provenance}`;
}

function reflectionFilePath(paths: HivePaths, date: string): string {
  return join(paths.reflectionsDir, `${date}.md`);
}

export async function appendReflectionsToDay(
  paths: HivePaths,
  date: string,
  landings: ReflectionLanding[],
): Promise<{ filePath: string; written: number; perSubject: Record<ReflectionSection, number> }> {
  const filePath = reflectionFilePath(paths, date);
  const perSubject: Record<ReflectionSection, number> = { greg: 0, maya: 0, system: 0 };
  if (landings.length === 0) {
    return { filePath, written: 0, perSubject };
  }

  const grouped: Record<ReflectionSection, ReflectionLanding[]> = {
    greg: [],
    maya: [],
    system: [],
  };
  for (const l of landings) grouped[l.subject].push(l);

  let existing = "";
  try {
    existing = await Bun.file(filePath).text();
  } catch {
    // file doesn't exist — we'll create
  }

  if (!existing.trim()) {
    const lines: string[] = [
      "---",
      `generated: ${toIsoTimestamp()}`,
      `pass: V`,
      "---",
      "",
      `# Reflections — ${date}`,
      "",
      "Pass V landings — ratified by the verifier from the day's signal.",
      "",
    ];
    for (const subject of ["greg", "maya", "system"] as ReflectionSection[]) {
      const items = grouped[subject];
      if (items.length === 0) continue;
      lines.push(SUBJECT_HEADERS[subject]);
      lines.push("");
      for (const l of items) {
        lines.push(reflectionLine(l));
        perSubject[subject]++;
      }
      lines.push("");
    }
    await Bun.write(filePath, lines.join("\n"));
    return {
      filePath,
      written: perSubject.greg + perSubject.maya + perSubject.system,
      perSubject,
    };
  }

  // File exists — append to matching sections, create missing ones at the end.
  let updated = existing.trimEnd();
  for (const subject of ["greg", "maya", "system"] as ReflectionSection[]) {
    const items = grouped[subject];
    if (items.length === 0) continue;
    const header = SUBJECT_HEADERS[subject];
    const idx = updated.indexOf(header);
    const block = items.map(reflectionLine).join("\n");
    if (idx === -1) {
      updated = `${updated}\n\n${header}\n\n${block}\n`;
    } else {
      const after = idx + header.length;
      const nextHeading = updated.slice(after).search(/\n## /);
      const sectionEnd = nextHeading === -1 ? updated.length : after + nextHeading;
      const before = updated.slice(0, sectionEnd).trimEnd();
      const rest = updated.slice(sectionEnd);
      updated = `${before}\n${block}${rest}`;
    }
    perSubject[subject] += items.length;
  }
  await Bun.write(filePath, updated.endsWith("\n") ? updated : updated + "\n");

  return {
    filePath,
    written: perSubject.greg + perSubject.maya + perSubject.system,
    perSubject,
  };
}

export async function readUnprocessedReflections(
  paths: HivePaths,
): Promise<ReflectionFile[]> {
  let files: string[];
  try {
    files = await readdir(paths.reflectionsDir);
  } catch {
    return [];
  }

  const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
  const results: ReflectionFile[] = [];

  for (const f of mdFiles) {
    const parsed = await parseReflectionFile(join(paths.reflectionsDir, f));
    if (!parsed.promoted) results.push(parsed);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dedup — word overlap between reflection entry and best knowledge match
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "ought",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "his", "its", "our", "their", "this",
  "that", "these", "those", "and", "but", "or", "nor", "not", "so",
  "yet", "both", "either", "neither", "each", "every", "all", "any",
  "few", "more", "most", "other", "some", "such", "no", "only",
  "same", "than", "too", "very", "just", "of", "in", "on", "at",
  "to", "for", "with", "from", "by", "about", "into", "through",
  "during", "before", "after", "above", "below", "between", "under",
  "again", "then", "once", "here", "there", "when", "where", "why",
  "how", "what", "which", "who", "whom", "if", "because", "as",
  "until", "while", "also", "already", "always", "never", "now",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

export function wordOverlap(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const w of setA) {
    if (setB.has(w)) overlap++;
  }
  // Jaccard-ish: overlap relative to the smaller set
  return overlap / Math.min(setA.size, setB.size);
}

const OVERLAP_THRESHOLD = 0.5;

async function isDuplicate(
  paths: HivePaths,
  projectId: string,
  entryText: string,
): Promise<boolean> {
  const results = await searchMemory(paths, projectId, entryText.slice(0, 150));
  if (results.length === 0) return false;

  // Check top 3 results for significant word overlap
  for (const r of results.slice(0, 3)) {
    if (r.source !== "knowledge") continue;
    if (wordOverlap(entryText, r.entry) > OVERLAP_THRESHOLD) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Promote
// ---------------------------------------------------------------------------

export async function promoteReflections(
  paths: HivePaths,
  projectId: string,
): Promise<PromotionResult> {
  const unprocessed = await readUnprocessedReflections(paths);

  if (unprocessed.length === 0) {
    return {
      promoted: 0, skipped: 0, proposed: 0,
      details: ["No unprocessed reflections found."],
    };
  }

  const result: PromotionResult = {
    promoted: 0, skipped: 0, proposed: 0, details: [],
  };

  // Collect identity proposals to batch into one inbox entry
  const gregProposals: Array<{ text: string; date: string }> = [];
  const mayaProposals: Array<{ text: string; date: string }> = [];

  for (const file of unprocessed) {
    for (const entry of file.entries) {
      if (entry.section === "system") {
        const dupe = await isDuplicate(paths, projectId, entry.text);
        if (dupe) {
          result.skipped++;
          result.details.push(`[skip] ${truncate(entry.text)}`);
          continue;
        }

        try {
          await appendProjectMemory(
            paths, projectId, "fact", entry.text, ["reflection"],
          );
          result.promoted++;
          result.details.push(`[promoted] ${truncate(entry.text)}`);
        } catch (err) {
          result.details.push(
            `[error] ${truncate(entry.text, 60)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (entry.section === "greg") {
        gregProposals.push({ text: entry.text, date: file.date });
      } else {
        mayaProposals.push({ text: entry.text, date: file.date });
      }
    }

    // Mark file as promoted
    await markPromoted(file.path);
  }

  // Write batched identity proposals to inbox
  if (gregProposals.length > 0) {
    await writeIdentityProposals(paths, projectId, "SELF.md", "About Greg", gregProposals);
    result.proposed += gregProposals.length;
    for (const p of gregProposals) {
      result.details.push(`[proposed -> SELF.md] ${truncate(p.text)}`);
    }
  }
  if (mayaProposals.length > 0) {
    await writeIdentityProposals(paths, projectId, "IDENTITY.md", "About Maya", mayaProposals);
    result.proposed += mayaProposals.length;
    for (const p of mayaProposals) {
      result.details.push(`[proposed -> IDENTITY.md] ${truncate(p.text)}`);
    }
  }

  // Rebuild index after all knowledge writes
  if (result.promoted > 0) {
    await rebuildIndex(paths, projectId);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Inbox + file helpers
// ---------------------------------------------------------------------------

async function writeIdentityProposals(
  paths: HivePaths,
  projectId: string,
  targetFile: string,
  label: string,
  proposals: Array<{ text: string; date: string }>,
): Promise<void> {
  const pp = getProjectPaths(paths, projectId);
  let content = "";
  try {
    content = await Bun.file(pp.inbox).text();
  } catch {
    content = `# Inbox: ${projectId}\n\n`;
  }

  const lines = [
    `\n## ${toIsoTimestamp()} — Reflection Promotion`,
    ``,
    `**Proposed edits to \`${targetFile}\`** (${label}):`,
    ``,
  ];
  for (const p of proposals) {
    lines.push(`- (${p.date}) ${p.text}`);
  }
  lines.push(``, `---`, ``);

  await Bun.write(pp.inbox, content + lines.join("\n"));
}

async function markPromoted(filePath: string): Promise<void> {
  const content = await Bun.file(filePath).text();
  const date = toDateLabel();

  if (content.startsWith("---\n")) {
    const fmEnd = content.indexOf("---\n", 4);
    if (fmEnd > 0) {
      const updated =
        content.slice(0, fmEnd) +
        `promoted: ${date}\n` +
        content.slice(fmEnd);
      await Bun.write(filePath, updated);
      return;
    }
  }

  await Bun.write(filePath, `---\npromoted: ${date}\n---\n\n${content}`);
}

function truncate(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}
