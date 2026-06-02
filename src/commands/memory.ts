import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import { resolveProjectFromCwd } from "../lib/project";
import {
  appendProjectMemory,
  appendToLog,
  readProjectMemorySnapshot,
  readProjectMemorySection,
  searchMemory,
  formatSearchResults,
  rebuildIndex,
  type MemorySection,
} from "../lib/memory";
import { promoteReflections } from "../lib/reflections";
import { buildConditionReport, writeConditionReport } from "../lib/condition";
import {
  runProjectExtractor,
  runReflectionExtractor,
} from "../lib/extract";
import { runVerifier } from "../lib/verify";
import { formatUsd, loadUsageSummary } from "../lib/pricing";
import { applyDecisions } from "../lib/apply";
import { runNightly, type PassReport } from "../lib/orchestrator";

function parseFlagsAndArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--project" || arg === "-p") {
      flags.project = args[++i] ?? "";
    } else if (arg === "--tag" || arg === "-t") {
      flags.tag = args[++i] ?? "";
    } else if (arg === "--section" || arg === "-s") {
      flags.section = args[++i] ?? "";
    } else if (arg === "--no-superseded") {
      flags.noSuperseded = "true";
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

export async function memoryCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive memory                              View all project memory
  hive memory view [facts|conventions|decisions|questions]
  hive memory fact <text> [--tag <tag>]    Add a durable fact
  hive memory convention <text>            Add a convention
  hive memory decision <text>              Add a decision
  hive memory question <text>              Add an open question
  hive memory search <query> [--tag t] [--section s]  Search across all memory layers
  hive memory index                        Rebuild the project memory index
  hive memory reflect                      Batch-write learnings from stdin (JSON)
  hive memory promote                      Promote unprocessed reflections to memory
  hive memory condition [--hours N] [--top-k N] [--dry-run]
                                           Pass A: build the nightly signal report
  hive memory extract-project <name> [--date YYYY-MM-DD]
                                           Pass B: Sonnet extracts candidates per project
  hive memory extract-reflections [--date YYYY-MM-DD]
                                           Pass C: Sonnet extracts cross-project reflections
  hive memory verify [--date YYYY-MM-DD]   Pass V: Opus verifies + writes briefing
  hive memory apply [--date YYYY-MM-DD] [--dry-run]
                                           Pass F: applies decisions to canon
  hive memory nightly [--date YYYY-MM-DD] [--dry-run]
                                           Run the full V1 pipeline (A → B → C → V → F)
  hive memory --project <name> ...         Specify project`;

  const paths = await ensureHiveScaffold();
  const { flags, positional } = parseFlagsAndArgs(args);

  const subcommand = positional[0];

  // Cross-project subcommands — don't require a project context.
  if (subcommand === "nightly") {
    let date = new Date().toISOString().slice(0, 10);
    let dryRun = false;
    const rest = positional.slice(1);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--date") date = rest[++i] ?? date;
      else if (rest[i] === "--dry-run") dryRun = true;
    }

    console.log(
      `=== HIVE memory nightly · ${date}${dryRun ? " · DRY RUN" : ""} ===`,
    );

    const fmt = (p: PassReport): string => {
      const dur = p.durationMs !== undefined ? ` (${(p.durationMs / 1000).toFixed(1)}s)` : "";
      const detail = p.detail ? ` — ${p.detail}` : p.error ? ` — ${p.error}` : "";
      return `[${p.status.toUpperCase().padEnd(8)}] ${p.pass}${dur}${detail}`;
    };

    const result = await runNightly({
      paths,
      date,
      dryRun,
      onProgress: (event) => {
        if (event.type === "pass-start") {
          const detail = event.detail ? ` — ${event.detail}` : "";
          console.log(`[STARTING] ${event.pass}${detail}`);
        } else {
          console.log(fmt(event.report));
        }
      },
    });

    // Cost summary
    const usage = await loadUsageSummary(paths, date);
    if (usage.records.length > 0) {
      console.log(
        `Cost: ${usage.totals.inputTokens.toLocaleString()} in / ` +
          `${usage.totals.outputTokens.toLocaleString()} out tokens · ${formatUsd(usage.totals.totalUsd)}`,
      );
    }

    if (result.briefingPath) {
      console.log(`Briefing → ${result.briefingPath}`);
    } else if (dryRun) {
      console.log(`Briefing draft → ${result.artifactsDir}/briefing.md (dry-run, not landed)`);
    }

    if (result.errors.length > 0) {
      console.log(`\nErrors (${result.errors.length}):`);
      for (const e of result.errors) console.log(`  ! ${e}`);
      process.exitCode = 1;
    } else {
      console.log(
        `\nDone. ${(result.totalDurationMs / 1000).toFixed(1)}s total.${dryRun ? " (artifacts in runs/, V0 still owns canon)" : ""}`,
      );
    }
    return;
  }

  if (subcommand === "condition") {
    const rest = positional.slice(1);
    let hours = 24;
    let topK = 30;
    let dryRun = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--hours") hours = Number(rest[++i]) || 24;
      else if (a === "--top-k") topK = Number(rest[++i]) || 30;
      else if (a === "--dry-run") dryRun = true;
    }

    const report = await buildConditionReport(paths, {
      hoursWindow: hours,
      topK,
    });

    if (dryRun) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (report.trivial) {
      console.log(`Today was light: ${report.trivialReason}.`);
    }

    const out = await writeConditionReport(paths, report);
    console.log(`Condition report → ${out}`);
    console.log(
      `  ${report.totals.projectCount} projects · ${report.totals.sessionCount} sessions · ` +
        `${report.totals.exchangeCount} exchanges · ${report.totals.commitCount} commits · ` +
        `${report.totals.ticketsMoved} tickets moved`,
    );
    return;
  }

  if (subcommand === "extract-project") {
    const target = positional[1];
    if (!target) {
      throw new UsageError(
        "Project name required.\n\nhive memory extract-project <name> [--date YYYY-MM-DD]",
      );
    }
    let date = new Date().toISOString().slice(0, 10);
    const rest = positional.slice(2);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--date") date = rest[++i] ?? date;
    }

    console.log(`Pass B (Sonnet) — extracting candidates for ${target} (${date})…`);
    const { outputPath, result } = await runProjectExtractor({
      paths,
      projectId: target,
      date,
    });
    const u = result.usage;
    console.log(`Wrote ${result.candidates.length} candidate(s) to ${outputPath}`);
    if (result.rejected > 0) {
      console.log(`  Rejected ${result.rejected} malformed item(s) from model output.`);
    }
    console.log(
      `  Model: ${u.provider}/${u.model} · ` +
        `tokens in/out: ${u.inputTokens ?? "?"}/${u.outputTokens ?? "?"} · ` +
        `${u.durationMs ? `${u.durationMs}ms` : "duration ?"}`,
    );
    return;
  }

  if (subcommand === "extract-reflections") {
    let date = new Date().toISOString().slice(0, 10);
    const rest = positional.slice(1);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--date") date = rest[++i] ?? date;
    }

    console.log(`Pass C (Sonnet) — extracting cross-project reflections (${date})…`);
    const { outputPath, result } = await runReflectionExtractor({ paths, date });
    const u = result.usage;
    console.log(`Wrote ${result.candidates.length} reflection candidate(s) to ${outputPath}`);
    if (result.rejected > 0) {
      console.log(`  Rejected ${result.rejected} malformed item(s) from model output.`);
    }
    console.log(
      `  Model: ${u.provider}/${u.model} · ` +
        `tokens in/out: ${u.inputTokens ?? "?"}/${u.outputTokens ?? "?"} · ` +
        `${u.durationMs ? `${u.durationMs}ms` : "duration ?"}`,
    );
    return;
  }

  if (subcommand === "apply") {
    let date = new Date().toISOString().slice(0, 10);
    let dryRun = false;
    const rest = positional.slice(1);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--date") date = rest[++i] ?? date;
      else if (rest[i] === "--dry-run") dryRun = true;
    }

    console.log(
      `Pass F (Apply) — ${dryRun ? "dry-run" : "applying"} decisions for ${date}…`,
    );
    const result = await applyDecisions({ paths, date, dryRun });
    const forcedNote =
      result.totals.directivesForceAdmitted > 0
        ? ` · ${result.totals.directivesForceAdmitted} directive(s) kept over verifier reject`
        : "";
    console.log(
      `Totals: ${result.totals.accepted} accept · ${result.totals.superseded} supersede · ` +
        `${result.totals.merged} merge · ${result.totals.rejected} reject · ` +
        `${result.totals.gapsLanded} gap(s) landed · ${result.totals.reflectionsLanded} reflection(s)${forcedNote}`,
    );
    for (const o of result.perProject) {
      const drainNote = o.drainedCandidates > 0 ? ` · drained ${o.drainedCandidates}` : "";
      const inboxNote = o.inboxTruncated ? " · inbox cleared" : "";
      const indexNote = o.rebuiltIndex ? " · index rebuilt" : "";
      console.log(
        `  ${o.projectId}: +${o.accepted} ~${o.superseded} ⊕${o.merged} ✗${o.rejected}${drainNote}${inboxNote}${indexNote}`,
      );
      for (const e of o.errors) console.log(`    ! ${e}`);
    }
    if (result.briefingPath) {
      console.log(`Briefing landed → ${result.briefingPath}`);
    } else if (!dryRun) {
      console.log(`(no briefing.md found — Pass V didn't run for ${date}?)`);
    }
    if (result.reflectionFile) {
      console.log(`Reflections → ${result.reflectionFile}`);
    }
    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.length}`);
      for (const e of result.errors) console.log(`  ! ${e}`);
    }
    return;
  }

  if (subcommand === "verify") {
    let date = new Date().toISOString().slice(0, 10);
    const rest = positional.slice(1);
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--date") date = rest[++i] ?? date;
    }

    console.log(`Pass V (Opus) — verifying + drafting briefing (${date})…`);
    const result = await runVerifier({ paths, date });
    const u = result.usage;
    const accepts = result.output.decisions.filter((d) => d.action === "accept").length;
    const supersedes = result.output.decisions.filter((d) => d.action === "supersede").length;
    const merges = result.output.decisions.filter((d) => d.action === "merge").length;
    const rejects = result.output.decisions.filter((d) => d.action === "reject").length;

    console.log(`Wrote artifacts:`);
    console.log(`  decisions → ${result.artifacts.decisionsPath}`);
    console.log(`  gaps      → ${result.artifacts.gapsPath}`);
    console.log(`  taste     → ${result.artifacts.tastePath}`);
    console.log(`  briefing  → ${result.artifacts.briefingPath}`);
    console.log(
      `Decisions: ${accepts} accept · ${supersedes} supersede · ${merges} merge · ${rejects} reject`,
    );
    console.log(
      `  Model: ${u.provider}/${u.model} · ` +
        `tokens in/out: ${u.inputTokens}/${u.outputTokens} · ` +
        `${u.durationMs ? `${u.durationMs}ms` : "duration ?"} · cost ${formatUsd(result.cost.totalUsd)}`,
    );

    const totals = await loadUsageSummary(paths, date);
    console.log(
      `Run total: ${totals.totals.inputTokens} input + ${totals.totals.outputTokens} output tokens · ` +
        `${formatUsd(totals.totals.totalUsd)} (${totals.records.length} pass${totals.records.length === 1 ? "" : "es"})`,
    );
    return;
  }

  const projectId = flags.project ?? resolveProjectFromCwd();

  if (!projectId) {
    throw new UsageError("No project found. Register one with: hive project add <name> <path>");
  }

  if (subcommand === "promote") {
    const result = await promoteReflections(paths, projectId);
    console.log(`Reflection promotion for ${projectId}:`);
    console.log(`  ${result.promoted} promoted to knowledge`);
    console.log(`  ${result.skipped} skipped (duplicate)`);
    console.log(`  ${result.proposed} proposed to inbox`);
    if (result.details.length > 0) {
      console.log("");
      for (const d of result.details) console.log(`  ${d}`);
    }
    return;
  }

  // Search
  if (subcommand === "search") {
    const query = positional.slice(1).join(" ").trim();
    if (!query) {
      throw new UsageError("No search query provided.\n\nhive memory search <query>");
    }
    const results = await searchMemory(paths, projectId, query, {
      tag: flags.tag,
      section: flags.section as MemorySection | undefined,
      includeSuperseded: flags.noSuperseded !== "true",
    });
    console.log(formatSearchResults(results, query));
    return;
  }

  // Rebuild index
  if (subcommand === "index") {
    const output = await rebuildIndex(paths, projectId);
    console.log(`Index rebuilt for ${projectId}:\n`);
    console.log(output);
    return;
  }

  if (!subcommand || subcommand === "view") {
    const section = (positional[1] ?? "all") as "all" | "facts" | "conventions" | "decisions" | "questions";
    const snapshot = await readProjectMemorySnapshot(paths, projectId);
    console.log(`Project: ${projectId}\n`);
    console.log(readProjectMemorySection(snapshot, section, flags.noSuperseded !== "true"));
    return;
  }

  if (subcommand === "reflect") {
    const stdin = await Bun.stdin.text();
    let learnings: Array<{ type: string; content: string; tags?: string[] }>;
    try {
      learnings = JSON.parse(stdin.trim());
    } catch {
      // intentional: JSON.parse failure → rethrow as UsageError with guidance
      throw new UsageError("Invalid JSON on stdin. Expected: [{\"type\":\"fact\",\"content\":\"...\"},...]");
    }
    if (!Array.isArray(learnings) || learnings.length === 0) {
      throw new UsageError("Expected a non-empty JSON array of learnings.");
    }

    const validTypes = ["fact", "convention", "decision", "question"];

    // Write to log first
    const logEntries = learnings
      .filter((item) => validTypes.includes(item.type))
      .map((item) => ({ type: item.type as MemorySection, content: item.content }));
    if (logEntries.length > 0) {
      await appendToLog(paths, projectId, logEntries);
    }

    // Write to knowledge
    let recorded = 0;
    for (const item of learnings) {
      if (!validTypes.includes(item.type)) {
        console.error(`Skipping invalid type: ${item.type}`);
        continue;
      }
      try {
        await appendProjectMemory(paths, projectId, item.type as MemorySection, item.content, item.tags ?? []);
        recorded++;
      } catch (err) {
        console.error(`Skipping ${item.type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Rebuild index
    await rebuildIndex(paths, projectId);

    console.log(`Recorded ${recorded} learning(s) in ${projectId} memory (knowledge + log). Index rebuilt.`);
    return;
  }

  const validSections: MemorySection[] = ["fact", "convention", "decision", "question"];
  if (!validSections.includes(subcommand as MemorySection)) {
    throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }

  const text = positional.slice(1).join(" ").trim();
  if (!text) {
    throw new UsageError(`No text provided.\n\n${usage}`);
  }

  const tags = flags.tag ? flags.tag.split(",").map((t) => t.trim().toLowerCase()) : [];

  try {
    await appendProjectMemory(paths, projectId, subcommand as MemorySection, text, tags);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  console.log(`Added ${subcommand} to ${projectId} memory.`);
}
