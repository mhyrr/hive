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

// TK-057: cap identity proposals per project per nightly. Healthy pipeline
// lands ~1 per week per project; if we're flooding past this it's signal,
// not principle. Overflow is reported, not silently dropped.
const IDENTITY_PROPOSAL_RATE_LIMIT = 2;

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

// TK-027: batch promotion used by the nightly orchestrator (Pass P).
// Same routing as `promoteReflections` but iterates a project list once and
// dispatches each entry to the project named in its provenance string (with
// a default fallback), instead of marking files as processed on the first
// project's pass and starving subsequent projects.
export interface PromotionBatchOpts {
  defaultProjectId: string;
  eligibleProjectIds: ReadonlySet<string>;
  /** Optional date filter — only process reflections at this date. Default: all unprocessed. */
  date?: string;
}

export interface PromotionBatchResult {
  filesProcessed: number;
  promoted: number;
  skipped: number;
  proposed: number;
  perProject: Record<string, { promoted: number; skipped: number; proposed: number }>;
  details: string[];
}

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
  let activeEntry: ReflectionEntry | null = null;

  const startsBullet = (s: string): boolean => /^\s*-\s/.test(s);

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    // Detect section headers
    let isHeader = false;
    for (const [header, section] of Object.entries(SECTION_HEADERS)) {
      if (lower === header) {
        current = section;
        activeEntry = null;
        isHeader = true;
        break;
      }
    }
    if (isHeader) continue;

    if (current && startsBullet(line)) {
      const text = trimmed.replace(/^-\s+/, "").trim();
      activeEntry = { text, section: current };
      entries.push(activeEntry);
      continue;
    }

    // Continuation: indented line that doesn't start a new bullet. Pass V's
    // reflectionLine puts `  _provenance:_ ...` on the line after the bullet;
    // we fold those into the active entry's text so downstream parsers
    // (e.g. projectFromReflectionEntry) can see the hint.
    if (activeEntry && line.length > 0 && /^\s+\S/.test(line) && !startsBullet(line)) {
      activeEntry.text = `${activeEntry.text} ${trimmed}`;
      continue;
    }

    // Blank line or top-level prose → close the active entry.
    if (line.trim() === "" || !line.startsWith(" ")) {
      activeEntry = null;
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
    // intentional: file doesn't exist yet — will create below
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
    // intentional: reflections directory doesn't exist yet
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

// Identity-stack files we check when classifying a candidate as "covered."
// Order is loudest-first so the citation in details reads naturally.
const IDENTITY_STACK_FILES = ["SOUL.md", "IDENTITY.md", "SELF.md", "AGENTS.md", "TRUST.md"];

export interface DuplicateCheckResult {
  duplicate: boolean;
  /** Which file + line covers it, when duplicate. */
  coveredBy?: { source: string; snippet: string };
}

/**
 * TK-057: extend duplicate detection from knowledge.md alone to the full
 * identity stack. A reflection that just restates an existing SOUL/IDENTITY/
 * SELF/AGENTS principle should be dropped (with citation), not promoted.
 *
 * Walks identity files paragraph-by-paragraph and runs the same word-overlap
 * heuristic the knowledge.md check uses. First hit wins; SOUL→TRUST order.
 */
async function checkDuplicate(
  paths: HivePaths,
  projectId: string,
  entryText: string,
): Promise<DuplicateCheckResult> {
  // Knowledge layer first — same as the prior behavior.
  const results = await searchMemory(paths, projectId, entryText.slice(0, 150));
  for (const r of results.slice(0, 3)) {
    if (r.source !== "knowledge") continue;
    if (wordOverlap(entryText, r.entry) > OVERLAP_THRESHOLD) {
      return {
        duplicate: true,
        coveredBy: { source: `knowledge:${projectId}`, snippet: truncate(r.entry, 100) },
      };
    }
  }

  // Identity stack — splits on blank lines to keep "paragraphs" as the unit.
  for (const file of IDENTITY_STACK_FILES) {
    const filePath = join(paths.home, file);
    let raw: string;
    try {
      raw = await Bun.file(filePath).text();
    } catch {
      // intentional: identity file missing — skip
      continue;
    }
    const paragraphs = raw.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
      if (wordOverlap(entryText, para) > OVERLAP_THRESHOLD) {
        // Use the first line of the paragraph as a citation handle —
        // typically a heading or the opening sentence.
        const handle = (para.split("\n")[0] ?? para).slice(0, 100);
        return {
          duplicate: true,
          coveredBy: { source: file, snippet: handle },
        };
      }
    }
  }

  return { duplicate: false };
}

// Backward-compat shim — `promoteReflections` (single-project CLI flow) still
// calls the boolean signature.
async function isDuplicate(
  paths: HivePaths,
  projectId: string,
  entryText: string,
): Promise<boolean> {
  const r = await checkDuplicate(paths, projectId, entryText);
  return r.duplicate;
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
// Batch promotion — routes per-entry by parsing provenance for project=NAME.
// Used by the nightly orchestrator (Pass P).
// ---------------------------------------------------------------------------

const PROVENANCE_PROJECT_RE = /\bproject\s*=\s*([a-z0-9][a-z0-9_-]*)/i;

export function projectFromReflectionEntry(entryText: string): string | null {
  // Pass C's provenance template includes `project=<name>` (see extract.ts).
  // The reflection file appended by `appendReflectionsToDay` puts the
  // provenance on a separate `_provenance:_` line. We search the whole
  // entry text and pick the first match.
  const m = entryText.match(PROVENANCE_PROJECT_RE);
  return m?.[1] ? m[1].toLowerCase() : null;
}

function ensureBucket(
  agg: PromotionBatchResult,
  projectId: string,
): { promoted: number; skipped: number; proposed: number } {
  let bucket = agg.perProject[projectId];
  if (!bucket) {
    bucket = { promoted: 0, skipped: 0, proposed: 0 };
    agg.perProject[projectId] = bucket;
  }
  return bucket;
}

export async function promoteReflectionsBatch(
  paths: HivePaths,
  opts: PromotionBatchOpts,
): Promise<PromotionBatchResult> {
  const result: PromotionBatchResult = {
    filesProcessed: 0,
    promoted: 0,
    skipped: 0,
    proposed: 0,
    perProject: {},
    details: [],
  };

  const unprocessed = await readUnprocessedReflections(paths);
  const files = opts.date
    ? unprocessed.filter((f) => f.date === opts.date)
    : unprocessed;

  if (files.length === 0) {
    result.details.push("No unprocessed reflections.");
    return result;
  }

  // Per-project batched identity proposals so each project's inbox gets one
  // consolidated entry per nightly, not one per reflection line.
  const gregProposalsByProject = new Map<string, Array<{ text: string; date: string }>>();
  const mayaProposalsByProject = new Map<string, Array<{ text: string; date: string }>>();
  const projectsTouched = new Set<string>();

  for (const file of files) {
    for (const entry of file.entries) {
      const claimed = projectFromReflectionEntry(entry.text);
      const target =
        claimed && opts.eligibleProjectIds.has(claimed)
          ? claimed
          : opts.defaultProjectId;

      if (entry.section === "system") {
        try {
          const check = await checkDuplicate(paths, target, entry.text);
          if (check.duplicate) {
            ensureBucket(result, target).skipped++;
            result.skipped++;
            const covered = check.coveredBy
              ? ` (covered by ${check.coveredBy.source}: "${check.coveredBy.snippet}")`
              : "";
            result.details.push(`[${target}] skip (dup)${covered}: ${truncate(entry.text)}`);
            continue;
          }
          await appendProjectMemory(paths, target, "fact", entry.text, ["reflection"]);
          ensureBucket(result, target).promoted++;
          result.promoted++;
          projectsTouched.add(target);
          result.details.push(`[${target}] promoted: ${truncate(entry.text)}`);
        } catch (err) {
          result.details.push(
            `[${target}] error: ${truncate(entry.text, 60)} — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }

      // TK-057: same dedupe gate as system entries — most "About Greg/Maya"
      // candidates in the prior 54-item backlog were already covered by SOUL/
      // IDENTITY/SELF text. Drop with citation rather than flooding the inbox.
      const check = await checkDuplicate(paths, target, entry.text);
      if (check.duplicate) {
        ensureBucket(result, target).skipped++;
        result.skipped++;
        const covered = check.coveredBy
          ? ` (covered by ${check.coveredBy.source}: "${check.coveredBy.snippet}")`
          : "";
        const dest = entry.section === "greg" ? "SELF.md" : "IDENTITY.md";
        result.details.push(`[${target}] skip identity-proposal → ${dest}${covered}: ${truncate(entry.text)}`);
        continue;
      }

      if (entry.section === "greg") {
        const list = gregProposalsByProject.get(target) ?? [];
        list.push({ text: entry.text, date: file.date });
        gregProposalsByProject.set(target, list);
      } else {
        const list = mayaProposalsByProject.get(target) ?? [];
        list.push({ text: entry.text, date: file.date });
        mayaProposalsByProject.set(target, list);
      }
    }

    await markPromoted(file.path);
    result.filesProcessed++;
  }

  // TK-057: rate-limit identity proposals. Healthy pipeline lands maybe one
  // per project per week; bursts mean the gate is loose and an operator
  // should look. We cap per-pass at IDENTITY_PROPOSAL_RATE_LIMIT and surface
  // the overflow in details so it doesn't silently disappear.
  for (const [projectId, proposals] of gregProposalsByProject) {
    const kept = proposals.slice(0, IDENTITY_PROPOSAL_RATE_LIMIT);
    const overflow = proposals.length - kept.length;
    await writeIdentityProposals(paths, projectId, "SELF.md", "About Greg", kept);
    ensureBucket(result, projectId).proposed += kept.length;
    result.proposed += kept.length;
    for (const p of kept) {
      result.details.push(`[${projectId}] proposed → SELF.md: ${truncate(p.text)}`);
    }
    if (overflow > 0) {
      result.details.push(
        `[${projectId}] rate-limited ${overflow} extra SELF.md proposal(s) — gate is loose, review the kept ones first`,
      );
    }
  }
  for (const [projectId, proposals] of mayaProposalsByProject) {
    const kept = proposals.slice(0, IDENTITY_PROPOSAL_RATE_LIMIT);
    const overflow = proposals.length - kept.length;
    await writeIdentityProposals(paths, projectId, "IDENTITY.md", "About Maya", kept);
    ensureBucket(result, projectId).proposed += kept.length;
    result.proposed += kept.length;
    for (const p of kept) {
      result.details.push(`[${projectId}] proposed → IDENTITY.md: ${truncate(p.text)}`);
    }
    if (overflow > 0) {
      result.details.push(
        `[${projectId}] rate-limited ${overflow} extra IDENTITY.md proposal(s) — gate is loose, review the kept ones first`,
      );
    }
  }

  for (const projectId of projectsTouched) {
    try {
      await rebuildIndex(paths, projectId);
    } catch {
      // intentional: rebuild failure is non-fatal here; doctor will catch drift.
    }
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
    // intentional: inbox doesn't exist yet — initialize with header
    content = `# Inbox: ${projectId}\n\n`;
  }

  // TK-057: name the section by what it actually is — candidates for
  // promotion that survived the dedupe + rate gates. The prior "Proposed
  // edits to FILE.md" framing pre-classified every entry as
  // identity-bound, which biased review toward accepting things that
  // belonged in project memory instead.
  const lines = [
    `\n## ${toIsoTimestamp()} — Session learnings — candidates for promotion`,
    ``,
    `Target: \`${targetFile}\` (${label}). These passed the dedupe gate against the identity stack; review before applying.`,
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
