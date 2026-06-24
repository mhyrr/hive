import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import { formatUsd } from "../lib/pricing";
import { loadTranscripts } from "../lib/transcript";
import { segmentWindows } from "../lib/taste-segment";
import { runTasteExtract, type TasteExtractResult } from "../lib/taste-extract";
import type { TasteCandidate } from "../lib/taste-types";

const USAGE = `Usage:
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

export async function tasteCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "extract") {
    return extractCommand(args.slice(1));
  }
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    return;
  }
  throw new UsageError(`Unknown taste subcommand: ${subcommand}\n\n${USAGE}`);
}
