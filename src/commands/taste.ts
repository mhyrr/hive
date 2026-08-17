import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { formatUsd } from "../lib/pricing";
import { resolveProjectFromCwd } from "../lib/project";
import { loadTranscripts } from "../lib/transcript";
import { segmentWindows } from "../lib/taste-segment";
import { runTasteExtract, validateTasteCandidate, type TasteExtractResult } from "../lib/taste-extract";
import {
  runTasteConsolidate,
  writeTasteDecisions,
  type TasteConsolidateResult,
} from "../lib/taste-consolidate";
import {
  clearInvalidLadders,
  generalTasteDir,
  listPendingUnits,
  projectTasteDir,
  readNegatives,
  readTasteUnits,
  recordNegative,
  removeUnit,
  setUnitStatus,
  writeTasteUnit,
  type TasteUnit,
} from "../lib/taste-store";
import type { TasteCandidate } from "../lib/taste-types";
import { buildTasteLayer, parsePrincipleHeadings } from "../lib/taste";

const USAGE = `Usage:
  hive taste status [options]             Store tally — active / contradictions held / holding
    --since <YYYY-MM-DD>                 Also list units admitted since that date
    --json                               Machine-readable (used by the weekly reminder)

  hive taste review [options]             Walk the contradiction queue: y/n keypress stepper
    --candidates <path...>               Import candidate JSON (from a run) as pending first
    --project <name>                     Review a project's store (default: cross-project)

  hive taste reject <hash|dedupe_key>     Demote a unit and blacklist it from re-proposal

  hive taste admit <hash|dedupe_key>      Promote a held unit to active
    --all-pending [--apply]              Admit every held unit (dry run without --apply)

  hive taste relink [--apply]             Clear ladder hints naming a principle that
                                          doesn't exist. Run after editing principles.md.

  hive taste consolidate [options]        Pass TC — gate + cohere TB candidates into the store
    --candidates <path...>               Candidate JSON (TB output) to consolidate (required)
    --project <name>                     Project context (default: resolved from cwd)
    --min-recurrence <N>                 Recurrence needed for review-eligibility (default 2)
    --out <dir>                          Where to write taste-decisions.{json,md}
    --json                               Print the full result JSON to stdout

  hive taste extract [options]            Mine taste candidates from transcripts (design §13)

  Sources (pick one; defaults to the last 24h):
    --transcript <path...>               One or more explicit JSONL transcripts
    --since <YYYY-MM-DD> [--until <d>]   A date range over discovered sessions
    --hours <N>                          Last N hours of sessions

  Filters / output:
    --project <name>                     Only sessions resolving to this project
    --flags-only                         Stop after TA-1 (cheap; no Opus analyze)
    --out <dir>                          Where to write artifacts (default: runs/<date>/)
    --json                               Print the full result JSON to stdout`;

interface ParsedArgs {
  transcripts: string[];
  since?: string;
  until?: string;
  hours?: number;
  project?: string;
  flagsOnly: boolean;
  out?: string;
  json: boolean;
}

function parseExtractArgs(rest: string[]): ParsedArgs {
  const p: ParsedArgs = { transcripts: [], flagsOnly: false, json: false };
  let i = 0;
  // Consume the next token as a value, rejecting a missing value or a token
  // that is actually the next flag (so `--since --json` errors, not silently
  // swallows --json).
  const take = (flag: string): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new UsageError(`${flag} requires a value\n\n${USAGE}`);
    }
    i += 1;
    return v;
  };
  for (; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--transcript") {
      // variadic: collect until the next --flag
      while (i + 1 < rest.length && !rest[i + 1]!.startsWith("--")) {
        p.transcripts.push(rest[++i]!);
      }
    } else if (arg === "--since") {
      p.since = take("--since");
    } else if (arg === "--until") {
      p.until = take("--until");
    } else if (arg === "--hours") {
      p.hours = Number(take("--hours"));
      if (Number.isNaN(p.hours)) throw new UsageError(`--hours must be a number\n\n${USAGE}`);
    } else if (arg === "--project") {
      p.project = take("--project");
    } else if (arg === "--flags-only") {
      p.flagsOnly = true;
    } else if (arg === "--out") {
      p.out = take("--out");
    } else if (arg === "--json") {
      p.json = true;
    } else {
      throw new UsageError(`Unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return p;
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
  return out;
}

function fmtCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
}

function printSummary(result: TasteExtractResult, candidates: TasteCandidate[]): void {
  const line = (s = "") => console.error(s);
  line();
  line("=== taste extract — summary ===");
  line(`sessions w/ windows : ${result.sessionsProcessed}`);
  line(`windows segmented   : ${result.windowCount}`);
  line(`flagged (TA-1)      : ${result.flaggedCount}  (rejected ${result.rejected.flags})`);
  line(`candidates (TB)     : ${candidates.length}  (rejected ${result.rejected.candidates})`);
  line(`model calls / cost  : ${result.modelCalls} calls · ${formatUsd(result.totalUsd)}`);
  if (result.flags.length > 0) {
    line();
    line(`flag types : ${fmtCounts(countBy(result.flags, (f) => f.type_guess))}`);
  }
  if (candidates.length > 0) {
    line();
    line(`by category: ${fmtCounts(countBy(candidates, (c) => c.category))}`);
    line(`by tier    : ${fmtCounts(countBy(candidates, (c) => c.tier))}`);
    line(`by scope   : ${fmtCounts(countBy(candidates, (c) => c.scope.kind))}`);
    line();
    line("--- candidates (eyeball these against the ≥30% bar) ---");
    candidates.forEach((c, i) => {
      const glob = c.scope.glob ? ` ${c.scope.glob}` : "";
      line(`\n[${i + 1}] ${c.category}/${c.tier}/${c.scope.kind}${glob}  (${c.reason_source})`);
      line(`    rule : ${c.rule_statement || "—"}`);
      line(`    why  : ${c.reasoning}`);
      if (c.ladders_up_hint) line(`    ↑    : ${c.ladders_up_hint}`);
      const ev = c.evidence[0];
      if (ev) line(`    ev   : "${ev.quote.slice(0, 100)}" [${ev.anchor.id}]`);
    });
  }
}

async function extractCommand(rest: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();
  const p = parseExtractArgs(rest);
  const date = new Date().toISOString().slice(0, 10);

  console.error(`=== HIVE taste extract · ${date}${p.flagsOnly ? " · flags-only" : ""} ===`);
  console.error("loading transcripts…");

  const loaded = await loadTranscripts({
    files: p.transcripts.length > 0 ? p.transcripts : undefined,
    since: p.since,
    until: p.until,
    hoursWindow: p.hours,
    project: p.project,
  });

  if (loaded.length === 0) {
    console.error("No transcripts matched. Try --transcript <path>, --since <date>, or --hours <N>.");
    return;
  }

  const totalEvents = loaded.reduce((n, t) => n + t.events.length, 0);
  const totalWindows = loaded.reduce((n, t) => n + segmentWindows(t.events).length, 0);
  console.error(
    `${loaded.length} sessions · ${totalEvents} events · ${totalWindows} candidate windows (mechanical)`,
  );

  const result = await runTasteExtract(loaded, {
    flagsOnly: p.flagsOnly,
    onProgress: (msg) => console.error(`  · ${msg}`),
  });

  printSummary(result, result.candidates);

  if (result.errors.length > 0) {
    console.error(`\nerrors (${result.errors.length}) — isolated, did not abort the run:`);
    for (const e of result.errors) console.error(`  ! ${e}`);
  }

  // Write artifacts next to the nightly run dir by default.
  const outDir = p.out ?? join(paths.memoryRunsDir, date);
  await mkdir(outDir, { recursive: true });
  const flagsPath = join(outDir, "taste-flags.offline.json");
  const candPath = join(outDir, "candidates.TB.offline.json");
  await writeFile(flagsPath, JSON.stringify(result.flags, null, 2));
  if (!p.flagsOnly) await writeFile(candPath, JSON.stringify(result.candidates, null, 2));

  console.log(`\nFlags    → ${flagsPath}`);
  if (!p.flagsOnly) console.log(`Candidates → ${candPath}`);
  if (p.json) console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// `hive taste review` — a y/n keypress stepper (design §10)
// ---------------------------------------------------------------------------

/**
 * Read single keypresses. In a TTY this is raw mode (no Enter needed); under
 * piped input it consumes one non-whitespace char per call (so it's testable
 * with `echo "y n q" | hive taste review`).
 */
function makeKeyReader() {
  const stdin = process.stdin;
  const isTTY = Boolean(stdin.isTTY);
  if (isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  let buffer = "";
  const waiters: Array<(c: string) => void> = [];
  const flush = () => {
    while (waiters.length > 0) {
      let ch = "";
      while (buffer.length > 0) {
        const c = buffer[0]!;
        buffer = buffer.slice(1);
        if (c === "\n" || c === "\r" || c === " " || c === "\t") continue;
        ch = c;
        break;
      }
      if (!ch) return;
      waiters.shift()!(ch);
    }
  };
  const onData = (d: Buffer) => {
    buffer += d.toString("utf-8");
    flush();
  };
  // On EOF (piped input runs out, or the stream closes), resolve any waiter as
  // quit so the loop ends cleanly instead of hanging.
  const onEnd = () => {
    while (waiters.length > 0) waiters.shift()!("q");
  };
  stdin.on("data", onData);
  stdin.on("end", onEnd);
  return {
    next(): Promise<string> {
      return new Promise((res) => {
        waiters.push(res);
        flush();
      });
    },
    close() {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      if (isTTY && stdin.setRawMode) stdin.setRawMode(false);
      stdin.pause();
    },
  };
}

function wrap(text: string, width: number, indent: string): string {
  const words = (text || "").trim().split(/\s+/);
  const out: string[] = [];
  let line = indent;
  for (const w of words) {
    if (line.length + 1 + w.length > width && line.trim()) {
      out.push(line);
      line = indent + w;
    } else {
      line = line === indent ? indent + w : `${line} ${w}`;
    }
  }
  if (line.trim()) out.push(line);
  return out.join("\n");
}

function renderCandidate(u: TasteUnit, idx: number, total: number): string {
  const W = 74;
  const bar = "─".repeat(W);
  const glob = u.scope.glob ? `  ${u.scope.glob}` : "";
  const lines: string[] = [];
  lines.push(`  taste review   ${idx + 1} / ${total}`);
  lines.push(bar);
  lines.push(
    `  ${u.category}${u.secondary_category ? ` +${u.secondary_category}` : ""}  ·  ${u.tier}  ·  ${u.scope.kind}${glob}  ·  ${u.reason_source}  ·  seen ${u.recurrence}×`,
  );
  lines.push("");
  lines.push("  RULE");
  lines.push(wrap(u.rule_statement, W, "    "));
  lines.push("");
  lines.push("  WHY");
  lines.push(wrap(u.reasoning, W, "    "));
  if (u.canonical_example?.bad || u.canonical_example?.good) {
    lines.push("");
    lines.push("  EXAMPLE");
    if (u.canonical_example.bad) lines.push(wrap(`✗ ${u.canonical_example.bad}`, W, "    "));
    if (u.canonical_example.good) lines.push(wrap(`✓ ${u.canonical_example.good}`, W, "    "));
  }
  if (u.check_sketch) {
    lines.push("");
    lines.push("  CHECK");
    lines.push(wrap(u.check_sketch, W, "    "));
  }
  if (u.ladders_up_hint) {
    lines.push("");
    lines.push("  LADDERS UP");
    lines.push(wrap(`↑ ${u.ladders_up_hint}`, W, "    "));
  }
  lines.push("");
  lines.push("  EVIDENCE");
  for (const e of u.evidence) lines.push(wrap(`"${e.quote}"  [${e.anchor.id}]`, W, "    "));
  lines.push("");
  lines.push(bar);
  lines.push("  [y] approve → store     [n] reject     [s] skip     [q] quit");
  return lines.join("\n");
}

interface ReviewArgs {
  candidates: string[];
  project?: string;
}

function parseReviewArgs(rest: string[]): ReviewArgs {
  const a: ReviewArgs = { candidates: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--candidates") {
      while (i + 1 < rest.length && !rest[i + 1]!.startsWith("--")) a.candidates.push(rest[++i]!);
    } else if (arg === "--project") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--project requires a value\n\n${USAGE}`);
      a.project = v;
      i += 1;
    } else {
      throw new UsageError(`Unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return a;
}

/**
 * Stores a review pass should walk. The cross-project (general) store is ALWAYS
 * included — a `general-taste` unit consolidated under a project still lands
 * there, and would otherwise be invisible to `review --project X`. With a
 * project, walk general + that project; without, walk general + every project
 * store so nothing pending is ever stranded.
 */
async function reviewStoreDirs(paths: HivePaths, project?: string): Promise<string[]> {
  const dirs = new Set<string>([generalTasteDir(paths)]);
  if (project) {
    dirs.add(projectTasteDir(paths, project));
  } else {
    try {
      for (const e of await readdir(paths.memoryProjectsDir, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.add(projectTasteDir(paths, e.name));
      }
    } catch {
      // intentional: no project stores yet — general store alone is fine
    }
  }
  return [...dirs];
}

async function reviewCommand(rest: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();
  const a = parseReviewArgs(rest);
  // Manual seeds land in the project store if --project is given, else general.
  const importDir = a.project ? projectTasteDir(paths, a.project) : generalTasteDir(paths);

  // Optional import: seed candidate JSON into the store as pending units.
  if (a.candidates.length > 0) {
    let imported = 0;
    for (const f of a.candidates) {
      let arr: unknown;
      try {
        arr = JSON.parse(await readFile(f, "utf-8"));
      } catch {
        console.error(`  ! could not read ${f}`);
        continue;
      }
      for (const raw of Array.isArray(arr) ? arr : []) {
        const c = validateTasteCandidate(raw);
        if (c) {
          await writeTasteUnit(importDir, c, { status: "pending" });
          imported++;
        }
      }
    }
    console.error(`imported ${imported} candidate(s) as pending`);
  }

  // Collect pending across every relevant store, tagging each unit with the
  // store it lives in so approve/reject targets the right file.
  const pending: { unit: TasteUnit; storeDir: string }[] = [];
  for (const dir of await reviewStoreDirs(paths, a.project)) {
    const negatives = new Set(await readNegatives(dir));
    for (const u of await listPendingUnits(dir)) {
      if (!negatives.has(u.dedupe_key)) pending.push({ unit: u, storeDir: dir });
    }
  }
  if (pending.length === 0) {
    console.log("No pending taste candidates to review.");
    return;
  }

  const reader = makeKeyReader();
  let approved = 0;
  let rejected = 0;
  let skipped = 0;
  let i = 0;
  try {
    for (; i < pending.length; i++) {
      const { unit: u, storeDir } = pending[i]!;
      process.stdout.write("\x1b[2J\x1b[H"); // clear + home
      process.stdout.write(`${renderCandidate(u, i, pending.length)}\n`);
      let key = "";
      while (!["y", "n", "s", "q"].includes(key)) {
        const k = await reader.next();
        key = k === "\x03" ? "q" : k.toLowerCase();
      }
      if (key === "y") {
        await setUnitStatus(storeDir, u.hash, "active");
        approved++;
      } else if (key === "n") {
        await removeUnit(storeDir, u.hash);
        await recordNegative(storeDir, u.dedupe_key);
        rejected++;
      } else if (key === "s") {
        skipped++;
      } else {
        break; // quit
      }
    }
  } finally {
    reader.close();
  }

  process.stdout.write("\x1b[2J\x1b[H");
  const remaining = pending.length - approved - rejected - skipped;
  console.log(
    `taste review — ${approved} approved, ${rejected} rejected, ${skipped} skipped` +
      (remaining > 0 ? `, ${remaining} left` : ""),
  );
  if (approved > 0) console.log(`approved units are now active.`);
}

// ---------------------------------------------------------------------------
// `hive taste consolidate` — Pass TC over TB candidates (design §8)
// ---------------------------------------------------------------------------

interface ConsolidateArgs {
  candidates: string[];
  project?: string;
  minRecurrence?: number;
  out?: string;
  json: boolean;
}

function parseConsolidateArgs(rest: string[]): ConsolidateArgs {
  const a: ConsolidateArgs = { candidates: [], json: false };
  const take = (flag: string, i: number): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} requires a value\n\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--candidates") {
      while (i + 1 < rest.length && !rest[i + 1]!.startsWith("--")) a.candidates.push(rest[++i]!);
    } else if (arg === "--project") {
      a.project = take("--project", i);
      i += 1;
    } else if (arg === "--min-recurrence") {
      a.minRecurrence = Number(take("--min-recurrence", i));
      if (Number.isNaN(a.minRecurrence)) throw new UsageError(`--min-recurrence must be a number\n\n${USAGE}`);
      i += 1;
    } else if (arg === "--out") {
      a.out = take("--out", i);
      i += 1;
    } else if (arg === "--json") {
      a.json = true;
    } else {
      throw new UsageError(`Unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return a;
}

async function loadCandidates(files: string[]): Promise<{ candidates: TasteCandidate[]; rejected: number }> {
  const candidates: TasteCandidate[] = [];
  let rejected = 0;
  for (const f of files) {
    let arr: unknown;
    try {
      arr = JSON.parse(await readFile(f, "utf-8"));
    } catch {
      console.error(`  ! could not read ${f}`);
      continue;
    }
    for (const raw of Array.isArray(arr) ? arr : []) {
      const c = validateTasteCandidate(raw);
      if (c) candidates.push(c);
      else rejected++;
    }
  }
  return { candidates, rejected };
}

function printConsolidateSummary(r: TasteConsolidateResult): void {
  const line = (s = "") => console.error(s);
  line();
  line("=== taste consolidate (Pass TC) — summary ===");
  line(`written            : ${r.written}  (${r.reviewEligible} review-eligible, ${r.holding} holding)`);
  line(`fact handoffs       : ${r.handoffsToFacts.length}  (CONTEXTUAL → fact candidates)`);
  line(`dropped             : ${r.droppedNoise} noise · ${r.droppedNegative} negatives`);
  line(`conflicts / tensions: ${r.conflicts.length} / ${r.tensions.length}`);
  if (r.usage) line(`coherence call      : ${formatUsd(r.usage.usd)} (${r.usage.model})`);
  if (r.newPrincipleProposals.length) {
    line();
    line("new-principle proposals:");
    for (const p of r.newPrincipleProposals) line(`  · ${p}`);
  }
  if (r.tensions.length) {
    line();
    line("tensions (need your call):");
    for (const d of r.tensions) line(`  ! ${d.dedupe_key} — ${d.tension_note ?? "(no note)"}`);
  }
  if (r.errors.length) {
    line();
    line(`errors (${r.errors.length}) — isolated:`);
    for (const e of r.errors) line(`  ! ${e}`);
  }
}

async function consolidateCommand(rest: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();
  const a = parseConsolidateArgs(rest);
  if (a.candidates.length === 0) {
    throw new UsageError(`taste consolidate needs --candidates <path...>\n\n${USAGE}`);
  }
  const projectId = a.project ?? resolveProjectFromCwd();
  if (!projectId) {
    throw new UsageError(`Could not resolve a project from the current directory — pass --project <name>.\n\n${USAGE}`);
  }
  const date = new Date().toISOString().slice(0, 10);

  const { candidates, rejected } = await loadCandidates(a.candidates);
  console.error(
    `=== HIVE taste consolidate · ${date} · project=${projectId} ===\n` +
      `loaded ${candidates.length} candidate(s)${rejected ? ` (${rejected} rejected)` : ""}`,
  );
  if (candidates.length === 0) {
    console.error("No valid candidates to consolidate.");
    return;
  }

  const result = await runTasteConsolidate(candidates, {
    paths,
    projectId,
    minRecurrence: a.minRecurrence,
    onProgress: (m) => console.error(`  · ${m}`),
  });

  printConsolidateSummary(result);

  const outDir = a.out ?? join(paths.memoryRunsDir, date);
  const { json, md } = await writeTasteDecisions(outDir, result, date);
  console.log(`\nDecisions → ${md}`);
  console.log(`           ${json}`);
  if (result.reviewEligible > 0) {
    console.log(`\n${result.reviewEligible} unit(s) are review-eligible — run \`hive taste review${a.project ? ` --project ${a.project}` : ""}\`.`);
  }
  if (a.json) console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// status / reject / admit — the operator surface for an auto-admitting store
// ---------------------------------------------------------------------------

interface StoreTally {
  active: number;
  pending: number;
  holding: number;
  /** Units admitted within the reporting window, newest first. */
  recent: TasteUnit[];
}

/** Count the whole taste library, and collect units admitted since `since`. */
export async function tallyTaste(
  paths: HivePaths,
  since?: string,
): Promise<StoreTally> {
  const tally: StoreTally = { active: 0, pending: 0, holding: 0, recent: [] };
  for (const dir of await reviewStoreDirs(paths)) {
    for (const u of await readTasteUnits(dir)) {
      tally[u.status]++;
      if (u.status === "active" && since && u.lastSeen >= since) tally.recent.push(u);
    }
  }
  tally.recent.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  return tally;
}

async function statusCommand(rest: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();
  const json = rest.includes("--json");
  const sinceIdx = rest.indexOf("--since");
  const since = sinceIdx >= 0 ? rest[sinceIdx + 1] : undefined;

  const t = await tallyTaste(paths, since);
  if (json) {
    console.log(
      JSON.stringify(
        {
          active: t.active,
          pending: t.pending,
          holding: t.holding,
          recent: t.recent.map((u) => ({
            dedupe_key: u.dedupe_key,
            category: u.category,
            rule_statement: u.rule_statement,
            lastSeen: u.lastSeen,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`taste store — ${t.active} active · ${t.pending} contradictions held · ${t.holding} holding`);
  if (t.pending > 0) console.log(`  ${t.pending} need a call: hive taste review`);
  if (since && t.recent.length > 0) {
    console.log(`\nadmitted since ${since}:`);
    for (const u of t.recent) console.log(`  · [${u.category}] ${u.rule_statement}`);
  }
}

/** Resolve a unit by full hash, hash prefix, or exact dedupe_key. */
async function findUnit(
  paths: HivePaths,
  ref: string,
): Promise<{ unit: TasteUnit; storeDir: string }[]> {
  const hits: { unit: TasteUnit; storeDir: string }[] = [];
  for (const dir of await reviewStoreDirs(paths)) {
    for (const u of await readTasteUnits(dir)) {
      if (u.hash === ref || u.dedupe_key === ref || u.hash.startsWith(ref)) {
        hits.push({ unit: u, storeDir: dir });
      }
    }
  }
  return hits;
}

/**
 * Demote and blacklist a unit. This is the reversibility that makes auto-admission
 * safe to run — without it, a wrong instance retrieved into working context has no
 * exit. Recording the negative stops TC re-proposing the same dedupe_key.
 */
async function rejectCommand(rest: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();
  const ref = rest.find((r) => !r.startsWith("-"));
  if (!ref) throw new UsageError("hive taste reject <hash|dedupe_key>");

  const hits = await findUnit(paths, ref);
  if (hits.length === 0) throw new UsageError(`No taste unit matches "${ref}".`);
  if (hits.length > 1) {
    throw new UsageError(
      `"${ref}" matches ${hits.length} units — use a full hash:\n` +
        hits.map((h) => `  ${h.unit.hash}  ${h.unit.dedupe_key}`).join("\n"),
    );
  }

  const { unit, storeDir } = hits[0]!;
  await removeUnit(storeDir, unit.hash);
  await recordNegative(storeDir, unit.dedupe_key);
  console.log(`rejected ${unit.dedupe_key} (${unit.hash}) — removed and blacklisted.`);
}

/**
 * Promote held units to active. `--all-pending` is the slice-1 migration: units
 * stranded at `pending` by the old human gate are not contradictions, and under
 * the new gate they would never be revisited — TC only touches units it re-observes.
 */
async function admitCommand(rest: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();
  const all = rest.includes("--all-pending");
  const apply = rest.includes("--apply");
  const ref = rest.find((r) => !r.startsWith("-"));

  if (!all && !ref) throw new UsageError("hive taste admit <hash|dedupe_key> | --all-pending [--apply]");

  const targets = all
    ? (
        await Promise.all(
          (await reviewStoreDirs(paths)).map(async (dir) =>
            (await listPendingUnits(dir)).map((unit) => ({ unit, storeDir: dir })),
          ),
        )
      ).flat()
    : await findUnit(paths, ref!);

  if (targets.length === 0) {
    console.log("Nothing to admit.");
    return;
  }
  if (all && !apply) {
    console.log(`${targets.length} unit(s) would be admitted (dry run — pass --apply):\n`);
    for (const { unit } of targets) console.log(`  · [${unit.category}] ${unit.rule_statement}`);
    return;
  }
  for (const { unit, storeDir } of targets) {
    await setUnitStatus(storeDir, unit.hash, "active");
  }
  console.log(`admitted ${targets.length} unit(s) — retrievable via search_taste.`);
}

/**
 * Clear ladder hints that don't name a real principle. Run after editing
 * principles.md; the units re-ladder on the next TC pass.
 */
async function relinkCommand(rest: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();
  const apply = rest.includes("--apply");
  const headings = new Set(parsePrincipleHeadings(await buildTasteLayer()));
  if (headings.size === 0) {
    console.error("No principle headings found in principles.md — refusing to clear every ladder.");
    return;
  }

  const cleared: { dedupe_key: string; wanted: string }[] = [];
  for (const dir of await reviewStoreDirs(paths)) {
    cleared.push(...(await clearInvalidLadders(dir, headings, { dryRun: !apply })));
  }

  if (cleared.length === 0) {
    console.log(`All ladders valid against ${headings.size} principle heading(s).`);
    return;
  }
  console.log(
    `${cleared.length} unit(s) ladder to a principle that doesn't exist` +
      (apply ? " — cleared:" : " (dry run — pass --apply):"),
  );
  const byWanted = new Map<string, number>();
  for (const c of cleared) byWanted.set(c.wanted, (byWanted.get(c.wanted) ?? 0) + 1);
  for (const [wanted, n] of [...byWanted].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}×  "${wanted}"`);
  }
  if (!apply) return;
  console.log("\nThese are new-principle evidence — the model reached for a rung and found nothing.");
}

export async function tasteCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "extract") {
    return extractCommand(args.slice(1));
  }
  if (subcommand === "consolidate") {
    return consolidateCommand(args.slice(1));
  }
  if (subcommand === "review") {
    return reviewCommand(args.slice(1));
  }
  if (subcommand === "status") {
    return statusCommand(args.slice(1));
  }
  if (subcommand === "reject") {
    return rejectCommand(args.slice(1));
  }
  if (subcommand === "admit") {
    return admitCommand(args.slice(1));
  }
  if (subcommand === "relink") {
    return relinkCommand(args.slice(1));
  }
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    return;
  }
  throw new UsageError(`Unknown taste subcommand: ${subcommand}\n\n${USAGE}`);
}
