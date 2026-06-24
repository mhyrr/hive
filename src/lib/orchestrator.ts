// Nightly orchestrator — wraps the V1 memory passes into one call.
//
// Pipeline:
//   Pass A (condition)
//     ↓
//   trivial day? → write a stub briefing, skip downstream
//     ↓
//   Pass B (Sonnet, per project with activity, in parallel)
//   Pass C (Sonnet, cross-project reflections)
//     ↓
//   Pass V (Opus, verify + brief)
//     ↓
//   Pass F (apply, mechanical) — skipped on --dry-run
//     ↓
//   Dashboard rebuild — skipped on --dry-run
//
// Each pass writes its artifact to runs/{DATE}/ before downstream consumes,
// so individual passes are independently restartable from disk.
//
// docs/specs/2026-04-26-memory-design.md §Group 8

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HivePaths } from "./paths";
import type { ModelCaller } from "./extract";
import {
  buildConditionReport,
  writeConditionReport,
  type ConditionReport,
  type ProjectSignal,
} from "./condition";
import { runProjectExtractor, runReflectionExtractor } from "./extract";
import { runVerifier } from "./verify";
import { applyDecisions } from "./apply";
import { promoteReflectionsBatch } from "./reflections";
import { buildDashboard } from "./dashboard";
import { listProjects } from "./paths";
import { loadTranscripts } from "./transcript";
import { runProjectTasteExtract } from "./taste-extract";
import {
  mergeConsolidateResults,
  runTasteConsolidate,
  writeTasteDecisions,
  type TasteConsolidateResult,
} from "./taste-consolidate";
import { appendUsageRecord, estimateCost } from "./pricing";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type PassStatus = "complete" | "skipped" | "failed";

export interface PassReport {
  pass: string;
  status: PassStatus;
  detail?: string;
  durationMs?: number;
  error?: string;
}

export interface NightlyResult {
  date: string;
  dryRun: boolean;
  trivial: boolean;
  trivialReason: string | null;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  passes: {
    A: PassReport;
    B: PassReport[];
    C: PassReport;
    V: PassReport;
    F: PassReport;
    P: PassReport;
    dashboard: PassReport;
    // Taste track (per project). TA flag → TB analyze → TC consolidate/gate.
    TA: PassReport[];
    TB: PassReport[];
    TC: PassReport[];
  };
  artifactsDir: string;
  briefingPath: string | null;
  errors: string[];
  // Counts for the final summary line
  candidateCounts: {
    bByProject: Record<string, number>;
    c: number;
  };
  decisionCounts: {
    accept: number;
    supersede: number;
    merge: number;
    reject: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectHasSignal(p: ProjectSignal): boolean {
  return (
    p.sessions.exchangeCount > 0 ||
    p.git.commits > 0 ||
    p.tickets.moved.length > 0
  );
}

function nowMs(): number {
  return Date.now();
}

function timed<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const start = nowMs();
  return fn().then((value) => ({ value, durationMs: nowMs() - start }));
}

const STUB_BRIEFING_FILENAME = "briefing.md";

async function writeStubBriefing(
  paths: HivePaths,
  date: string,
  trivialReason: string | null,
): Promise<string> {
  const runDir = join(paths.memoryRunsDir, date);
  await mkdir(runDir, { recursive: true });
  const reason = trivialReason ?? "no signal in window";
  const body = `# HIVE — ${date}

## Headline
Quiet day. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}.

## Memory + verifier
- Added: 0 entries. Superseded: 0. Reflections: 0.
- Verifier flags: skipped (no signal worth verifying).
`;
  const file = join(runDir, STUB_BRIEFING_FILENAME);
  await writeFile(file, body);
  return file;
}

async function copyStubToBriefings(
  paths: HivePaths,
  date: string,
  source: string,
): Promise<string> {
  const dest = join(paths.home, "briefings", `${date}.md`);
  await mkdir(join(paths.home, "briefings"), { recursive: true });
  const body = await Bun.file(source).text();
  await Bun.write(dest, body);
  return dest;
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export type ProgressEvent =
  | { type: "pass-start"; pass: string; detail?: string }
  | { type: "pass-complete"; report: PassReport }
  | { type: "pass-skipped"; report: PassReport }
  | { type: "pass-failed"; report: PassReport };

export interface RunNightlyOptions {
  paths: HivePaths;
  date?: string;
  dryRun?: boolean;
  caller?: ModelCaller;
  /** Run the taste track (TA→TB→TC). Default true; `--no-taste` sets false. */
  taste?: boolean;
  /** Injectable transcript reader (testing seam). Defaults to the real loader. */
  transcriptLoader?: typeof loadTranscripts;
  onProgress?: (event: ProgressEvent) => void;
}

export async function runNightly(options: RunNightlyOptions): Promise<NightlyResult> {
  const { paths } = options;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const dryRun = options.dryRun ?? false;
  const caller = options.caller;
  const emit = options.onProgress ?? (() => {});
  const startedAt = new Date().toISOString();
  const startMs = nowMs();

  const result: NightlyResult = {
    date,
    dryRun,
    trivial: false,
    trivialReason: null,
    startedAt,
    finishedAt: "",
    totalDurationMs: 0,
    passes: {
      A: { pass: "A", status: "skipped" },
      B: [],
      C: { pass: "C", status: "skipped" },
      V: { pass: "V", status: "skipped" },
      F: { pass: "F", status: "skipped" },
      P: { pass: "P", status: "skipped" },
      dashboard: { pass: "dashboard", status: "skipped" },
      TA: [],
      TB: [],
      TC: [],
    },
    artifactsDir: join(paths.memoryRunsDir, date),
    briefingPath: null,
    errors: [],
    candidateCounts: { bByProject: {}, c: 0 },
    decisionCounts: { accept: 0, supersede: 0, merge: 0, reject: 0 },
  };

  // ---- Pass A ---------------------------------------------------------------
  emit({ type: "pass-start", pass: "A", detail: "scanning sessions, git, tickets" });
  let condition: ConditionReport;
  try {
    const { value, durationMs } = await timed(async () => {
      const report = await buildConditionReport(paths, { date });
      await writeConditionReport(paths, report);
      return report;
    });
    condition = value;
    result.passes.A = {
      pass: "A",
      status: "complete",
      detail: `${value.totals.projectCount} projects · ${value.totals.exchangeCount} exchanges · ${value.totals.commitCount} commits`,
      durationMs,
    };
    emit({ type: "pass-complete", report: result.passes.A });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.passes.A = { pass: "A", status: "failed", error: msg };
    emit({ type: "pass-failed", report: result.passes.A });
    result.errors.push(`Pass A: ${msg}`);
    result.finishedAt = new Date().toISOString();
    result.totalDurationMs = nowMs() - startMs;
    return result; // can't proceed without condition
  }

  // ---- Trivial-day short-circuit -------------------------------------------
  if (condition.trivial) {
    result.trivial = true;
    result.trivialReason = condition.trivialReason;
    emit({
      type: "pass-skipped",
      report: { pass: "B/C/V", status: "skipped", detail: `trivial day — ${condition.trivialReason}` },
    });
    const stub = await writeStubBriefing(paths, date, condition.trivialReason);
    result.passes.B = [{ pass: "B", status: "skipped", detail: "trivial day" }];
    result.passes.C = { pass: "C", status: "skipped", detail: "trivial day" };
    result.passes.V = { pass: "V", status: "skipped", detail: "trivial day" };
    result.passes.TA = [{ pass: "TA", status: "skipped", detail: "trivial day" }];
    result.passes.TB = [{ pass: "TB", status: "skipped", detail: "trivial day" }];
    result.passes.TC = [{ pass: "TC", status: "skipped", detail: "trivial day" }];
    if (!dryRun) {
      result.briefingPath = await copyStubToBriefings(paths, date, stub);
      result.passes.F = { pass: "F", status: "skipped", detail: "stub-only briefing copied" };
      try {
        const { durationMs } = await timed(() => buildDashboard(paths));
        result.passes.dashboard = { pass: "dashboard", status: "complete", durationMs };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.passes.dashboard = { pass: "dashboard", status: "failed", error: msg };
        result.errors.push(`dashboard: ${msg}`);
      }
    } else {
      result.passes.F = { pass: "F", status: "skipped", detail: "dry-run + trivial" };
      result.passes.dashboard = { pass: "dashboard", status: "skipped", detail: "dry-run" };
    }
    result.finishedAt = new Date().toISOString();
    result.totalDurationMs = nowMs() - startMs;
    return result;
  }

  // ---- Pass B (per project with signal) -------------------------------------
  const targets = condition.projects.filter(projectHasSignal);
  emit({
    type: "pass-start",
    pass: "B",
    detail: `${targets.length} project${targets.length === 1 ? "" : "s"} with signal — Sonnet calls in parallel`,
  });
  const bPromises = targets.map(async (p) => {
    const projectId = p.projectName;
    emit({ type: "pass-start", pass: `B.${projectId}` });
    try {
      const { value, durationMs } = await timed(() =>
        runProjectExtractor({ paths, projectId, date, caller }),
      );
      result.candidateCounts.bByProject[projectId] = value.result.candidates.length;
      const r: PassReport = {
        pass: `B.${projectId}`,
        status: "complete",
        detail: `${value.result.candidates.length} candidate(s), ${value.result.rejected} rejected`,
        durationMs,
      };
      emit({ type: "pass-complete", report: r });
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Pass B (${projectId}): ${msg}`);
      const r: PassReport = { pass: `B.${projectId}`, status: "failed", error: msg };
      emit({ type: "pass-failed", report: r });
      return r;
    }
  });
  result.passes.B = await Promise.all(bPromises);

  // ---- Pass C (cross-project reflections) -----------------------------------
  emit({ type: "pass-start", pass: "C", detail: "Sonnet — cross-project reflections" });
  try {
    const { value, durationMs } = await timed(() =>
      runReflectionExtractor({ paths, date, caller }),
    );
    result.candidateCounts.c = value.result.candidates.length;
    result.passes.C = {
      pass: "C",
      status: "complete",
      detail: `${value.result.candidates.length} reflection(s), ${value.result.rejected} rejected`,
      durationMs,
    };
    emit({ type: "pass-complete", report: result.passes.C });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.passes.C = { pass: "C", status: "failed", error: msg };
    emit({ type: "pass-failed", report: result.passes.C });
    result.errors.push(`Pass C: ${msg}`);
  }

  // ---- Pass V (Opus verify) -------------------------------------------------
  // V is the only pass whose failure is fatal — without decisions there's
  // nothing for F to apply and no briefing to land.
  emit({ type: "pass-start", pass: "V", detail: "Opus — verify + brief (this can take 30-60s)" });
  let verifyOK = false;
  try {
    const { value, durationMs } = await timed(() =>
      runVerifier({ paths, date, caller }),
    );
    for (const d of value.output.decisions) {
      const k = d.action;
      result.decisionCounts[k] = (result.decisionCounts[k] ?? 0) + 1;
    }
    result.passes.V = {
      pass: "V",
      status: "complete",
      detail: `${value.output.decisions.length} decision(s), ${value.output.gaps.length} gap(s)`,
      durationMs,
    };
    emit({ type: "pass-complete", report: result.passes.V });
    verifyOK = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.passes.V = { pass: "V", status: "failed", error: msg };
    emit({ type: "pass-failed", report: result.passes.V });
    result.errors.push(`Pass V: ${msg}`);
  }

  // ---- Pass F (apply) — skipped on dry-run --------------------------------
  if (!verifyOK) {
    result.passes.F = {
      pass: "F",
      status: "skipped",
      detail: "verify failed; nothing to apply",
    };
    result.passes.dashboard = {
      pass: "dashboard",
      status: "skipped",
      detail: "verify failed; nothing to render",
    };
  } else if (dryRun) {
    result.passes.F = { pass: "F", status: "skipped", detail: "dry-run" };
    result.passes.dashboard = { pass: "dashboard", status: "skipped", detail: "dry-run" };
    emit({ type: "pass-skipped", report: result.passes.F });
    emit({ type: "pass-skipped", report: result.passes.dashboard });
  } else {
    emit({ type: "pass-start", pass: "F", detail: "applying decisions to canon" });
    let applyOK = false;
    try {
      const { value, durationMs } = await timed(() =>
        applyDecisions({ paths, date }),
      );
      result.briefingPath = value.briefingPath;
      const forced = value.totals.directivesForceAdmitted;
      result.passes.F = {
        pass: "F",
        status: "complete",
        detail:
          `+${value.totals.accepted} ~${value.totals.superseded} ⊕${value.totals.merged} ✗${value.totals.rejected}` +
          (forced > 0 ? ` ⚡${forced} directive(s) kept over verifier reject` : ""),
        durationMs,
      };
      emit({ type: "pass-complete", report: result.passes.F });
      applyOK = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.passes.F = { pass: "F", status: "failed", error: msg };
      emit({ type: "pass-failed", report: result.passes.F });
      result.errors.push(`Pass F: ${msg}`);
    }

    // ---- Pass P (promote) — TK-027 ----------------------------------------
    // Closes the reflection loop: today's reflection file (just written by
    // Pass F) gets routed entry-by-entry to project knowledge.md or to the
    // appropriate inbox.md as an identity proposal. Default project is the
    // one with the highest exchange count today; per-entry `project=NAME`
    // hints in provenance override.
    if (applyOK) {
      emit({ type: "pass-start", pass: "P", detail: "promoting today's reflections" });
      try {
        const eligible = new Set(await listProjects(paths.projectsDir));
        const ranked = condition.projects
          .filter(projectHasSignal)
          .sort((a, b) => b.sessions.exchangeCount - a.sessions.exchangeCount);
        const defaultProject = ranked[0]?.projectName ?? [...eligible][0] ?? "hive";
        const { value: pr, durationMs: pms } = await timed(() =>
          promoteReflectionsBatch(paths, {
            defaultProjectId: defaultProject,
            eligibleProjectIds: eligible,
            date,
          }),
        );
        result.passes.P = {
          pass: "P",
          status: pr.filesProcessed > 0 ? "complete" : "skipped",
          detail:
            pr.filesProcessed === 0
              ? "no unprocessed reflections"
              : `${pr.filesProcessed} file(s) · +${pr.promoted} knowledge · ${pr.proposed} identity-proposed · ${pr.skipped} dup-skipped`,
          durationMs: pms,
        };
        emit({ type: "pass-complete", report: result.passes.P });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.passes.P = { pass: "P", status: "failed", error: msg };
        emit({ type: "pass-failed", report: result.passes.P });
        result.errors.push(`Pass P: ${msg}`);
      }
    } else {
      result.passes.P = {
        pass: "P",
        status: "skipped",
        detail: "apply failed; nothing to promote",
      };
    }

    // Dashboard rebuild — never fatal.
    emit({ type: "pass-start", pass: "dashboard" });
    try {
      const { durationMs } = await timed(() => buildDashboard(paths));
      result.passes.dashboard = { pass: "dashboard", status: "complete", durationMs };
      emit({ type: "pass-complete", report: result.passes.dashboard });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.passes.dashboard = { pass: "dashboard", status: "failed", error: msg };
      emit({ type: "pass-failed", report: result.passes.dashboard });
      result.errors.push(`dashboard: ${msg}`);
    }
  }

  // ---- Taste track (TA → TB → TC) -------------------------------------------
  // Sequenced AFTER the fact track, not concurrent with B/C/V: nested
  // `claude --print` subprocesses contend, so the design's "concurrently" is
  // overridden by the empirical lesson — run the claude-heavy passes in series.
  // Independent of the fact track's success (it reads transcripts, not V's
  // output), so it runs even if V/F failed.
  if (options.taste ?? true) {
    await runTasteTrack({
      paths,
      date,
      dryRun,
      condition,
      caller,
      emit,
      result,
      transcriptLoader: options.transcriptLoader ?? loadTranscripts,
    });
  } else {
    const skip = (pass: string): PassReport => ({
      pass,
      status: "skipped",
      detail: "disabled via --no-taste",
    });
    result.passes.TA = [skip("TA")];
    result.passes.TB = [skip("TB")];
    result.passes.TC = [skip("TC")];
  }

  result.finishedAt = new Date().toISOString();
  result.totalDurationMs = nowMs() - startMs;
  return result;
}

// ---------------------------------------------------------------------------
// Taste track — per project, sequential: TA(flag) → TB(analyze) → TC(gate).
//
// Restartability mirrors the fact track: each project deletes its TA/TB
// artifacts at attempt start, and the combined taste-decisions.{json,md} is
// cleared at track start. Failure isolation: one project's TA/TB failure skips
// only that project; a TC failure leaves the project's TA/TB artifacts intact
// (mirrors Pass V→F). On --dry-run, TA/TB run and write artifacts but TC (the
// store writer) is skipped — the analogue of F being skipped on dry-run.
// ---------------------------------------------------------------------------

interface TasteTrackArgs {
  paths: HivePaths;
  date: string;
  dryRun: boolean;
  condition: ConditionReport;
  caller?: ModelCaller;
  emit: (event: ProgressEvent) => void;
  result: NightlyResult;
  transcriptLoader: typeof loadTranscripts;
}

async function runTasteTrack(args: TasteTrackArgs): Promise<void> {
  const { paths, date, dryRun, condition, caller, emit, result, transcriptLoader } = args;
  const runDir = join(paths.memoryRunsDir, date);
  // Anchor the transcript window to the run date, matching condition's window
  // (so a retroactive `--date` covers the named day, not the wall clock).
  const now = new Date(`${date}T23:59:59.999Z`);

  // Combined TC artifact — clear stale at track start (restartability).
  await rm(join(runDir, "taste-decisions.json"), { force: true });
  await rm(join(runDir, "taste-decisions.md"), { force: true });

  const targets = condition.projects.filter(projectHasSignal);
  const tcResults: TasteConsolidateResult[] = [];

  for (const p of targets) {
    const projectId = p.projectName;

    // ---- TA + TB (per-project batched extraction) ----
    const flagsPath = join(runDir, `taste-flags.${projectId}.json`);
    const tbPath = join(runDir, `candidates.TB.${projectId}.json`);
    await rm(flagsPath, { force: true });
    await rm(tbPath, { force: true });

    emit({ type: "pass-start", pass: `TA.${projectId}` });
    let extract: Awaited<ReturnType<typeof runProjectTasteExtract>>;
    try {
      const loaded = await transcriptLoader({ project: projectId, hoursWindow: condition.hoursWindow, now });
      const { value, durationMs } = await timed(() => runProjectTasteExtract(loaded, { caller }));
      extract = value;
      await mkdir(runDir, { recursive: true });
      await Bun.write(flagsPath, JSON.stringify(value.flags, null, 2));
      await Bun.write(tbPath, JSON.stringify(value.candidates, null, 2));
      for (const rec of value.usageRecords) {
        await appendUsageRecord(paths, date, {
          pass: rec.pass,
          project: projectId,
          provider: rec.usage.provider,
          model: rec.usage.model,
          inputTokens: rec.usage.inputTokens ?? 0,
          outputTokens: rec.usage.outputTokens ?? 0,
          durationMs: rec.usage.durationMs,
          cost: estimateCost({
            provider: rec.usage.provider,
            model: rec.usage.model,
            inputTokens: rec.usage.inputTokens ?? 0,
            outputTokens: rec.usage.outputTokens ?? 0,
          }),
        });
      }
      const taReport: PassReport = {
        pass: `TA.${projectId}`,
        status: "complete",
        detail: `${value.windowCount} window(s) · ${value.flaggedCount} flagged`,
        durationMs,
      };
      result.passes.TA.push(taReport);
      emit({ type: "pass-complete", report: taReport });
      const tbReport: PassReport = {
        pass: `TB.${projectId}`,
        status: "complete",
        detail: `${value.candidates.length} candidate(s), ${value.rejected.candidates} rejected`,
      };
      result.passes.TB.push(tbReport);
      emit({ type: "pass-complete", report: tbReport });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const taReport: PassReport = { pass: `TA.${projectId}`, status: "failed", error: msg };
      result.passes.TA.push(taReport);
      result.passes.TB.push({ pass: `TB.${projectId}`, status: "skipped", detail: "extract failed" });
      emit({ type: "pass-failed", report: taReport });
      result.errors.push(`Pass TA/TB (${projectId}): ${msg}`);
      continue; // one project's failure never blocks the others
    }

    // ---- TC (consolidate/gate) — skipped on dry-run (it is the store writer) ----
    if (dryRun) {
      result.passes.TC.push({ pass: `TC.${projectId}`, status: "skipped", detail: "dry-run" });
      continue;
    }
    if (extract.candidates.length === 0) {
      result.passes.TC.push({ pass: `TC.${projectId}`, status: "skipped", detail: "no candidates" });
      continue;
    }
    emit({ type: "pass-start", pass: `TC.${projectId}` });
    try {
      const { value: tc, durationMs } = await timed(() =>
        runTasteConsolidate(extract.candidates, { paths, projectId, now: date, caller }),
      );
      tcResults.push(tc);
      if (tc.usage) {
        await appendUsageRecord(paths, date, {
          pass: "TC",
          project: projectId,
          provider: tc.usage.provider,
          model: tc.usage.model,
          inputTokens: tc.usage.inputTokens ?? 0,
          outputTokens: tc.usage.outputTokens ?? 0,
          durationMs: tc.usage.durationMs,
          cost: estimateCost({
            provider: tc.usage.provider,
            model: tc.usage.model,
            inputTokens: tc.usage.inputTokens ?? 0,
            outputTokens: tc.usage.outputTokens ?? 0,
          }),
        });
      }
      const r: PassReport = {
        pass: `TC.${projectId}`,
        status: "complete",
        detail: `+${tc.written} written (${tc.reviewEligible} review-eligible, ${tc.holding} holding)`,
        durationMs,
      };
      result.passes.TC.push(r);
      emit({ type: "pass-complete", report: r });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const r: PassReport = { pass: `TC.${projectId}`, status: "failed", error: msg };
      result.passes.TC.push(r);
      emit({ type: "pass-failed", report: r });
      result.errors.push(`Pass TC (${projectId}): ${msg}`);
    }
  }

  // One combined decisions artifact for the morning read (skipped on dry-run —
  // TC didn't run). taste-decisions.md replaces the deprecated taste.md.
  if (!dryRun && tcResults.length > 0) {
    try {
      await writeTasteDecisions(runDir, mergeConsolidateResults(tcResults), date);
    } catch (err) {
      result.errors.push(`taste-decisions write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
