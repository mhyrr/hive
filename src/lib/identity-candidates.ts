/**
 * Pending identity candidates (TK-157).
 *
 * Pass P finds reflections that belong in the identity stack: "About Maya"
 * lines for IDENTITY.md and "About Greg" lines for SELF.md. Only Greg decides
 * whether one enters the stack, and his answer can come days later. These
 * candidates used to live in a project inbox, and the nightly clears every
 * inbox once the briefing lands (TK-059). So a candidate got one briefing
 * line and then vanished, answered or not.
 *
 * A candidate now lives in its own store, `~/.hive/identity-candidates.json`,
 * until Greg answers it:
 *   - approve: the text is appended to the target file, then removed here.
 *   - decline: the text is removed here.
 * Both answers append one line to `~/.hive/identity-candidates.log`. Nothing
 * else removes a candidate. The nightly lists every pending candidate in each
 * briefing, so the ask repeats until it is answered.
 *
 * `rescueInboxCandidates` moves candidate sections out of an inbox body before
 * an inbox clear. It covers inboxes written before this store existed, and any
 * future writer that still puts a candidate in an inbox.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HivePaths } from "./paths";

export type IdentityTarget = "IDENTITY.md" | "SELF.md";

export const IDENTITY_TARGETS: readonly IdentityTarget[] = ["IDENTITY.md", "SELF.md"];

/** The section of the target file an approved candidate is appended to. When
 * the heading is missing, the candidate goes at the end of the file. */
const TARGET_SECTION: Record<IdentityTarget, string> = {
  "IDENTITY.md": "## Things You've Learned",
  "SELF.md": "## Working Patterns",
};

const TARGET_LABEL: Record<IdentityTarget, string> = {
  "IDENTITY.md": "About Maya",
  "SELF.md": "About Greg",
};

export interface IdentityCandidate {
  /** First 8 hex chars of sha256(target + text). Stable, so a re-proposal of
   * the same text is a duplicate, not a second card. */
  id: string;
  target: IdentityTarget;
  text: string;
  /** Date of the reflection the candidate came from (YYYY-MM-DD). */
  date: string;
  /** Project whose session produced it, or null when unknown. */
  project: string | null;
  /** When the candidate entered the store (ISO). */
  proposedAt: string;
  /** Where it came from: "pass-p", "inbox-rescue", or "cli". */
  source: string;
}

interface Store {
  version: 1;
  pending: IdentityCandidate[];
}

export type CandidateAnswer = "approved" | "declined";

export interface CandidateLogLine {
  at: string;
  action: CandidateAnswer | "proposed";
  id: string;
  target: IdentityTarget;
  text: string;
  project: string | null;
  reason?: string;
}

export function candidatesPath(paths: HivePaths): string {
  return join(paths.home, "identity-candidates.json");
}

export function candidatesLogPath(paths: HivePaths): string {
  return join(paths.home, "identity-candidates.log");
}

export function candidateId(target: IdentityTarget, text: string): string {
  return createHash("sha256").update(`${target}\n${text.trim()}`).digest("hex").slice(0, 8);
}

export function isIdentityTarget(value: string): value is IdentityTarget {
  return (IDENTITY_TARGETS as readonly string[]).includes(value);
}

async function readStore(paths: HivePaths): Promise<Store> {
  const file = candidatesPath(paths);
  if (!existsSync(file)) return { version: 1, pending: [] };
  // A corrupt store must fail loudly. Treating it as empty would let the next
  // write overwrite every pending candidate, which is the loss TK-157 fixes.
  const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<Store>;
  if (!Array.isArray(parsed.pending)) {
    throw new Error(`${file}: expected a "pending" array`);
  }
  return { version: 1, pending: parsed.pending };
}

async function writeStore(paths: HivePaths, store: Store): Promise<void> {
  const file = candidatesPath(paths);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + "\n");
  await rename(tmp, file);
}

async function appendLog(paths: HivePaths, line: CandidateLogLine): Promise<void> {
  const file = candidatesLogPath(paths);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(line) + "\n");
}

export async function listPendingCandidates(paths: HivePaths): Promise<IdentityCandidate[]> {
  return (await readStore(paths)).pending;
}

export interface ProposeInput {
  target: IdentityTarget;
  text: string;
  date: string;
  project: string | null;
  source: string;
}

async function declinedIds(paths: HivePaths): Promise<Set<string>> {
  const file = candidatesLogPath(paths);
  if (!existsSync(file)) return new Set();
  const ids = new Set<string>();
  for (const line of (await readFile(file, "utf-8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<CandidateLogLine>;
      if (entry.action === "declined" && typeof entry.id === "string") ids.add(entry.id);
    } catch {
      // intentional: a torn log line hides one decline, it must not block proposals
    }
  }
  return ids;
}

/** Add candidates to the store. A candidate already pending (same target and
 * text) is skipped. So is one Greg already declined, unless a person files it
 * again by hand (source "cli"). Returns the candidates that were added. */
export async function addCandidates(
  paths: HivePaths,
  inputs: ProposeInput[],
): Promise<IdentityCandidate[]> {
  if (inputs.length === 0) return [];
  const store = await readStore(paths);
  const known = new Set(store.pending.map((c) => c.id));
  const declined = await declinedIds(paths);
  const added: IdentityCandidate[] = [];
  const now = new Date().toISOString();
  for (const input of inputs) {
    const text = input.text.trim();
    if (!text) continue;
    const id = candidateId(input.target, text);
    if (known.has(id)) continue;
    if (declined.has(id) && input.source !== "cli") continue;
    known.add(id);
    added.push({
      id,
      target: input.target,
      text,
      date: input.date,
      project: input.project,
      proposedAt: now,
      source: input.source,
    });
  }
  if (added.length === 0) return [];
  store.pending.push(...added);
  await writeStore(paths, store);
  for (const c of added) {
    await appendLog(paths, {
      at: now,
      action: "proposed",
      id: c.id,
      target: c.target,
      text: c.text,
      project: c.project,
    });
  }
  return added;
}

function findCandidate(store: Store, idPrefix: string): IdentityCandidate {
  const matches = store.pending.filter((c) => c.id.startsWith(idPrefix));
  if (matches.length === 0) {
    throw new Error(`No pending identity candidate matches '${idPrefix}'.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `'${idPrefix}' matches ${matches.length} candidates (${matches.map((c) => c.id).join(", ")}). Use more characters.`,
    );
  }
  return matches[0]!;
}

/** Insert `- text` as the last bullet of `heading`'s section, or at the end of
 * the file when the heading is absent. */
export function insertIntoSection(fileText: string, heading: string, text: string): string {
  const bullet = `- ${text.trim()}`;
  const lines = fileText.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) {
    return `${fileText.trimEnd()}\n\n${bullet}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  // Place the bullet after the section's last non-blank line.
  let last = end - 1;
  while (last > start && lines[last]!.trim() === "") last--;
  lines.splice(last + 1, 0, bullet);
  return lines.join("\n");
}

export interface AnswerResult {
  candidate: IdentityCandidate;
  /** The file the text was appended to; approve only. */
  appliedTo?: string;
  /** The text that entered the file; approve only. */
  appliedText?: string;
}

/** Greg approves: append the text (or his edited wording) to the target file,
 * then drop the candidate and log it. The file write comes first, so a failed
 * write leaves the candidate pending. */
export async function approveCandidate(
  paths: HivePaths,
  idPrefix: string,
  opts: { text?: string } = {},
): Promise<AnswerResult> {
  const store = await readStore(paths);
  const candidate = findCandidate(store, idPrefix);
  const appliedText = (opts.text ?? candidate.text).trim();
  if (!appliedText) throw new Error("Approved text is empty.");

  const file = join(paths.home, candidate.target);
  const before = existsSync(file) ? await readFile(file, "utf-8") : "";
  await writeFile(file, insertIntoSection(before, TARGET_SECTION[candidate.target], appliedText));

  store.pending = store.pending.filter((c) => c.id !== candidate.id);
  await writeStore(paths, store);
  await appendLog(paths, {
    at: new Date().toISOString(),
    action: "approved",
    id: candidate.id,
    target: candidate.target,
    text: appliedText,
    project: candidate.project,
    ...(opts.text ? { reason: `edited from: ${candidate.text}` } : {}),
  });
  return { candidate, appliedTo: file, appliedText };
}

/** Greg declines: drop the candidate and log it with the reason. */
export async function declineCandidate(
  paths: HivePaths,
  idPrefix: string,
  opts: { reason?: string } = {},
): Promise<AnswerResult> {
  const store = await readStore(paths);
  const candidate = findCandidate(store, idPrefix);
  store.pending = store.pending.filter((c) => c.id !== candidate.id);
  await writeStore(paths, store);
  await appendLog(paths, {
    at: new Date().toISOString(),
    action: "declined",
    id: candidate.id,
    target: candidate.target,
    text: candidate.text,
    project: candidate.project,
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
  return { candidate };
}

// ---------------------------------------------------------------------------
// Inbox rescue
// ---------------------------------------------------------------------------

/** The section heading Pass P wrote into inboxes before this store existed. */
const INBOX_SECTION_HEADING = /^##\s.*candidates for promotion\s*$/;
const INBOX_TARGET_LINE = /^Target:\s*`(IDENTITY\.md|SELF\.md)`/;
const INBOX_BULLET = /^-\s+(?:\((\d{4}-\d{2}-\d{2})\)\s+)?(.*)$/;

export interface InboxRescue {
  /** The inbox body with every candidate section removed. */
  remaining: string;
  candidates: Array<{ target: IdentityTarget; text: string; date: string }>;
}

/** Split identity-candidate sections out of an inbox body. A section runs from
 * its "## … candidates for promotion" heading to the next `---` line or `## `
 * heading. Its `Target:` line names the file; each bullet is one candidate. A
 * section without a recognised Target line is left in place. */
export function extractInboxCandidates(body: string): InboxRescue {
  const lines = body.split("\n");
  const kept: string[] = [];
  const candidates: InboxRescue["candidates"] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!INBOX_SECTION_HEADING.test(line)) {
      kept.push(line);
      i++;
      continue;
    }

    let end = i + 1;
    let closedByRule = false;
    while (end < lines.length) {
      const l = lines[end]!;
      if (l.trim() === "---") {
        closedByRule = true;
        break;
      }
      if (/^## /.test(l)) break;
      end++;
    }
    const section = lines.slice(i + 1, end);
    const targetLine = section.map((l) => l.match(INBOX_TARGET_LINE)).find(Boolean);
    if (!targetLine) {
      kept.push(line);
      i++;
      continue;
    }
    const target = targetLine[1] as IdentityTarget;

    let current: { text: string; date: string } | null = null;
    const flush = () => {
      if (current && current.text.trim()) {
        candidates.push({ target, text: current.text.trim(), date: current.date });
      }
      current = null;
    };
    for (const l of section) {
      if (INBOX_TARGET_LINE.test(l)) continue;
      const bullet = l.match(INBOX_BULLET);
      if (bullet) {
        flush();
        current = { date: bullet[1] ?? "", text: bullet[2] ?? "" };
      } else if (current && l.trim() !== "") {
        current.text += ` ${l.trim()}`;
      } else if (l.trim() === "") {
        flush();
      }
    }
    flush();

    i = closedByRule ? end + 1 : end;
  }

  return { remaining: kept.join("\n").trim(), candidates };
}

/** Move candidate sections from an inbox body into the store. Returns the
 * body left for the caller to clear or keep. */
export async function rescueInboxCandidates(
  paths: HivePaths,
  projectId: string,
  body: string,
): Promise<{ remaining: string; rescued: number }> {
  const { remaining, candidates } = extractInboxCandidates(body);
  if (candidates.length === 0) return { remaining: body, rescued: 0 };
  await addCandidates(
    paths,
    candidates.map((c) => ({
      target: c.target,
      text: c.text,
      date: c.date,
      project: projectId,
      source: "inbox-rescue",
    })),
  );
  return { remaining, rescued: candidates.length };
}

// ---------------------------------------------------------------------------
// Briefing section
// ---------------------------------------------------------------------------

const BRIEFING_HEADING = "## Identity candidates (pending)";
const BRIEFING_SECTION_RE = /\n*## Identity candidates \(pending\)\n[\s\S]*?(?=\n## |$)/;

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function pendingCandidateLines(pending: IdentityCandidate[]): string[] {
  if (pending.length === 0) return [];
  const lines = [
    `${pending.length} waiting on your answer. Each stays here until you approve or decline it.`,
    "",
  ];
  for (const c of pending) {
    const from = c.project ? `, from ${c.project}` : "";
    lines.push(`- \`${c.id}\` → ${c.target} (${TARGET_LABEL[c.target]}${from}, ${c.date || c.proposedAt.slice(0, 10)}): ${oneLine(c.text)}`);
  }
  lines.push(
    "",
    "Answer: `hive identity approve <id> [--text \"edited wording\"]` or `hive identity decline <id> [--reason \"…\"]`.",
  );
  return lines;
}

/** Replace (or remove) the pending-candidates section of a briefing. */
export function upsertPendingSection(briefing: string, pending: IdentityCandidate[]): string {
  const without = briefing.replace(BRIEFING_SECTION_RE, "").trimEnd();
  const lines = pendingCandidateLines(pending);
  if (lines.length === 0) return without + "\n";
  return `${without}\n\n${BRIEFING_HEADING}\n${lines.join("\n")}\n`;
}

/** Write the current pending list into a briefing file on disk. A missing
 * file is left alone. Returns the number of candidates listed. */
export async function writePendingSection(paths: HivePaths, briefingPath: string): Promise<number> {
  if (!existsSync(briefingPath)) return 0;
  const pending = await listPendingCandidates(paths);
  const before = await readFile(briefingPath, "utf-8");
  const after = upsertPendingSection(before, pending);
  if (after !== before) await writeFile(briefingPath, after);
  return pending.length;
}
