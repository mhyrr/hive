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

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
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
import { writePendingSection } from "./identity-candidates";
import { buildDashboard } from "./dashboard";
import { listProjects } from "./paths";
import { loadTranscripts } from "./transcript";
import { runProjectTasteExtract } from "./taste-extract";
import { buildReplayCorpus, type ReplayCorpus } from "./taste-replay";
import {
  mergeConsolidateResults,
  runTasteConsolidate,
  writeTasteDecisions,
  type TasteConsolidateResult,
} from "./taste-consolidate";
import { appendUsageRecord, buildUsageRecord } from "./pricing";
import { runWatches, type WatchCaller } from "./watch-run";
import { tasteEveryNights } from "./nightly-config";
import {
  catchUpDates,
  decideTasteGate,
  emptyManifest,
  projectCatchUpDays,
  readManifest,
  writeManifest,
  type ResumeManifest,
  type TasteGate,
} from "./nightly-resume";

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
    // @nightly watches (TK-138), one report per watch evaluated.
    W: PassReport[];
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

/** TK-157: write the identity candidates still waiting on Greg into the
 * landed briefing and the run's copy. A failure is reported, never fatal. */
async function listPendingIdentityCandidates(
  paths: HivePaths,
  result: NightlyResult,
): Promise<void> {
  if (!result.briefingPath) return;
  try {
    await writePendingSection(paths, join(paths.memoryRunsDir, result.date, STUB_BRIEFING_FILENAME));
    await writePendingSection(paths, result.briefingPath);
  } catch (err) {
    result.errors.push(`identity-candidates: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  /** Run clock captured once for rolling-window correctness; testing seam. */
  now?: Date;
  dryRun?: boolean;
  caller?: ModelCaller;
  /** Run the taste track (TA→TB→TC). Default true; `--no-taste` sets false. */
  taste?: boolean;
  /** Run the taste track tonight even when the cadence gate says it isn't due
   * (`--taste-now`). */
  tasteNow?: boolean;
  /** Taste cadence in nights. Defaults to tasteEveryNights() (config/env). */
  tasteEveryNights?: number;
  /** Re-run every pass, ignoring runs/{DATE}/resume.json (`--force`). Pass F
   * then applies a second time for the date. */
  force?: boolean;
  /** Injectable transcript reader (testing seam). Defaults to the real loader. */
  transcriptLoader?: typeof loadTranscripts;
  onProgress?: (event: ProgressEvent) => void;
}

export async function runNightly(options: RunNightlyOptions): Promise<NightlyResult> {
  const { paths } = options;
  const runClock = options.now ?? new Date();
  const date = options.date ?? runClock.toISOString().slice(0, 10);
  const dryRun = options.dryRun ?? false;
  const caller = options.caller;
  const emit = options.onProgress ?? (() => {});
  const startedAt = runClock.toISOString();
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
      W: [],
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
      const report = await buildConditionReport(
        paths,
        options.date ? { date, now: runClock } : { now: runClock },
      );
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
    result.passes.W = [{ pass: "W", status: "skipped", detail: "trivial day" }];
    if (!dryRun) {
      result.briefingPath = await copyStubToBriefings(paths, date, stub);
      result.passes.F = { pass: "F", status: "skipped", detail: "stub-only briefing copied" };
      await listPendingIdentityCandidates(paths, result);
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

  // ---- Resume -------------------------------------------------------------
  // A retry of the same date (the morning firings after a failed 2am run)
  // skips the passes resume.json records as finished. Once F has applied, the
  // whole fact track is done for the date: re-running it would apply canon a
  // second time. Dry-runs neither read nor write the manifest.
  const resumeOn = !dryRun && !options.force;
  const manifest: ResumeManifest =
    (resumeOn ? readManifest(paths, date) : null) ?? emptyManifest(date);
  const persist = async (): Promise<void> => {
    if (!dryRun) await writeManifest(paths, manifest);
  };
  const runDir = join(paths.memoryRunsDir, date);
  const factApplied = resumeOn && manifest.F ? manifest.F : null;
  const resumedFact = `resumed — fact track already applied at ${factApplied}`;
  // Set when B or C produces new output in this invocation, so V can't be
  // resumed from decisions made on older inputs.
  let factInputsChanged = false;

  // ---- Pass B (per project with signal) -------------------------------------
  const targets = factApplied ? [] : condition.projects.filter(projectHasSignal);
  if (factApplied) {
    const failedBefore = condition.projects
      .filter(projectHasSignal)
      .filter((p) => !manifest.B[p.projectName])
      .map((p) => p.projectName);
    result.passes.B = [{
      pass: "B",
      status: "skipped",
      detail:
        resumedFact +
        (failedBefore.length > 0
          ? `; B failed then for ${failedBefore.join(", ")} and is not retried (it would re-apply canon)`
          : ""),
    }];
    emit({ type: "pass-skipped", report: result.passes.B[0]! });
  }
  emit({
    type: "pass-start",
    pass: "B",
    detail: `${targets.length} project${targets.length === 1 ? "" : "s"} with signal — Opus calls in series`,
  });
  // Serial, NOT parallel: concurrent `claude --print` subprocesses contend on
  // OAuth/Keychain access in the detached launchd context and stall past
  // claude's own ~6-min request cap, so a fan-out turns every project's
  // extraction into a hard failure. This is the same empirical lesson the
  // taste track encodes below (see the TA→TB→TC comment) — every claude-heavy
  // pass runs in series. Per-project failures stay isolated (one project's
  // throw doesn't abort the rest); each call is independently deadline-bounded
  // in its caller.
  const bReports: PassReport[] = [];
  for (const p of targets) {
    const projectId = p.projectName;
    const bPath = join(runDir, `candidates.B.${projectId}.json`);
    if (resumeOn && manifest.B[projectId] && existsSync(bPath)) {
      const n = countArtifactCandidates(bPath);
      result.candidateCounts.bByProject[projectId] = n;
      const r: PassReport = {
        pass: `B.${projectId}`,
        status: "skipped",
        detail: `resumed — ${n} candidate(s) from ${manifest.B[projectId]}`,
      };
      emit({ type: "pass-skipped", report: r });
      bReports.push(r);
      continue;
    }
    emit({ type: "pass-start", pass: `B.${projectId}` });
    factInputsChanged = true;
    try {
      const { value, durationMs } = await timed(() =>
        runProjectExtractor({ paths, projectId, date, caller }),
      );
      manifest.B[projectId] = new Date().toISOString();
      await persist();
      result.candidateCounts.bByProject[projectId] = value.result.candidates.length;
      const r: PassReport = {
        pass: `B.${projectId}`,
        status: "complete",
        detail: `${value.result.candidates.length} candidate(s), ${value.result.rejected} rejected`,
        durationMs,
      };
      emit({ type: "pass-complete", report: r });
      bReports.push(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Pass B (${projectId}): ${msg}`);
      const r: PassReport = { pass: `B.${projectId}`, status: "failed", error: msg };
      emit({ type: "pass-failed", report: r });
      bReports.push(r);
    }
  }
  if (!factApplied) result.passes.B = bReports;

  // ---- Pass C (cross-project reflections) -----------------------------------
  const cPath = join(runDir, "candidates.C.json");
  if (factApplied) {
    result.passes.C = { pass: "C", status: "skipped", detail: resumedFact };
    emit({ type: "pass-skipped", report: result.passes.C });
  } else if (resumeOn && manifest.C && existsSync(cPath)) {
    result.candidateCounts.c = countArtifactCandidates(cPath);
    result.passes.C = {
      pass: "C",
      status: "skipped",
      detail: `resumed — ${result.candidateCounts.c} reflection(s) from ${manifest.C}`,
    };
    emit({ type: "pass-skipped", report: result.passes.C });
  } else try {
    emit({ type: "pass-start", pass: "C", detail: "cross-project reflections" });
    factInputsChanged = true;
    const { value, durationMs } = await timed(() =>
      runReflectionExtractor({ paths, date, caller }),
    );
    manifest.C = new Date().toISOString();
    await persist();
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
  let verifyOK = false;
  const decisionsPath = join(runDir, "decisions.json");
  const vResumable =
    resumeOn &&
    !!manifest.V &&
    !factInputsChanged &&
    existsSync(decisionsPath) &&
    existsSync(join(runDir, "verifier-output.json"));
  if (factApplied || vResumable) {
    const decisions = readDecisions(decisionsPath);
    for (const d of decisions) {
      result.decisionCounts[d.action] = (result.decisionCounts[d.action] ?? 0) + 1;
    }
    result.passes.V = {
      pass: "V",
      status: "skipped",
      detail: factApplied ? resumedFact : `resumed — ${decisions.length} decision(s) from ${manifest.V}`,
    };
    emit({ type: "pass-skipped", report: result.passes.V });
    verifyOK = true;
  } else try {
    emit({
      type: "pass-start",
      pass: "V",
      detail: "one call per project with candidates, then the brief",
    });
    const { value, durationMs } = await timed(() =>
      runVerifier({ paths, date, caller }),
    );
    manifest.V = new Date().toISOString();
    await persist();
    for (const d of value.output.decisions) {
      const k = d.action;
      result.decisionCounts[k] = (result.decisionCounts[k] ?? 0) + 1;
    }
    const shards = value.shardedProjects;
    result.passes.V = {
      pass: "V",
      status: "complete",
      detail:
        `${value.output.decisions.length} decision(s), ${value.output.gaps.length} gap(s) · ` +
        `${shards.length + 1} call(s)${shards.length > 0 ? ` (${shards.join(", ")} + brief)` : " (brief only)"}`,
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

  // The dashboard rebuild is deferred until after the taste track (below) so
  // it captures the night's taste-decisions.json. This flag records that the
  // happy path (verify OK, not dry-run) reached the point where we'd build.
  let rebuildDashboard = false;

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
    let applyOK = false;
    if (factApplied) {
      result.passes.F = { pass: "F", status: "skipped", detail: resumedFact };
      emit({ type: "pass-skipped", report: result.passes.F });
      const landed = join(paths.home, "briefings", `${date}.md`);
      if (existsSync(landed)) result.briefingPath = landed;
      applyOK = true;
    } else try {
      emit({ type: "pass-start", pass: "F", detail: "applying decisions to canon" });
      const { value, durationMs } = await timed(() =>
        applyDecisions({ paths, date }),
      );
      manifest.F = new Date().toISOString();
      await persist();
      result.briefingPath = value.briefingPath;
      const forced = value.totals.directivesForceAdmitted;
      result.passes.F = {
        pass: "F",
        status: "complete",
        detail:
          `+${value.totals.accepted} ~${value.totals.superseded} ⊕${value.totals.merged} ✗${value.totals.rejected}` +
          (value.totals.gapsBriefed > 0 ? ` ⚑${value.totals.gapsBriefed} gap(s) briefed` : "") +
          (forced > 0 ? ` ⚡${forced} directive(s) kept over verifier reject` : "") +
          (value.canonSizeWarnings.length > 0
            ? ` ⚠${value.canonSizeWarnings.length} canon(s) near the Verify budget`
            : ""),
        durationMs,
      };
      emit({ type: "pass-complete", report: result.passes.F });
      // A failed canon-size measurement is non-fatal to F but must not be
      // silent: it is the early warning for the TK-137 failure mode.
      for (const e of value.errors) {
        if (e.startsWith("canon-size:") || e.startsWith("identity-candidates:")) {
          result.errors.push(`Pass F: ${e}`);
        }
      }
      applyOK = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.passes.F = { pass: "F", status: "failed", error: msg };
      emit({ type: "pass-failed", report: result.passes.F });
      result.errors.push(`Pass F: ${msg}`);
    }

    // ---- Pass P (promote) — TK-027 ----------------------------------------
    // Closes the reflection loop: today's reflection file (just written by
    // Pass F) gets routed entry-by-entry to project knowledge.md or, as an
    // identity candidate, to the pending store (TK-157). Default project is the
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

    // Pass P runs after F landed the briefing, so tonight's new identity
    // candidates join the pending list there now, not a night late.
    await listPendingIdentityCandidates(paths, result);

    // Dashboard rebuild is deferred until after the taste track — see below.
    rebuildDashboard = true;
  }

  // ---- Taste track (TA → TB → TC) -------------------------------------------
  // Sequenced AFTER the fact track, not concurrent with B/C/V: nested
  // `claude --print` subprocesses contend, so the design's "concurrently" is
  // overridden by the empirical lesson — run the claude-heavy passes in series.
  // Independent of the fact track's success (it reads transcripts, not V's
  // output), so it runs even if V/F failed.
  //
  // Cadence: every N nights (nightly-config.ts tasteEveryNights). A run covers
  // every session since the last one, so a skipped night loses nothing.
  const skipTaste = (detail: string): void => {
    const skip = (pass: string): PassReport => ({ pass, status: "skipped", detail });
    result.passes.TA = [skip("TA")];
    result.passes.TB = [skip("TB")];
    result.passes.TC = [skip("TC")];
    emit({ type: "pass-skipped", report: result.passes.TA[0]! });
  };
  const gate = decideTasteGate(paths, date, options.tasteEveryNights ?? tasteEveryNights());
  const tasteStarted = resumeOn && Object.keys(manifest.taste).length > 0;
  if (!(options.taste ?? true)) {
    skipTaste("disabled via --no-taste");
  } else if (resumeOn && manifest.tasteComplete) {
    skipTaste(`resumed — taste track already finished at ${manifest.tasteComplete}`);
  } else if (!gate.run && !options.tasteNow && !tasteStarted) {
    const detail = `taste skipped (next run ${gate.nextRun}) — ${gate.reason}`;
    skipTaste(detail);
    await noteTasteSkipInBriefing(runDir, result.briefingPath, gate);
  } else {
    await runTasteTrack({
      paths,
      date,
      dryRun,
      condition,
      caller,
      emit,
      result,
      transcriptLoader: options.transcriptLoader ?? loadTranscripts,
      gate,
      manifest: dryRun ? null : manifest,
      resume: resumeOn,
      persist,
    });
  }

  // ---- @nightly watches (TK-138) — after both tracks, before the dashboard --
  // Invoked here (not by the hourly tick) so they read tonight's runs/{DATE}/
  // artifacts; the dashboard rebuild below then captures whatever they surface
  // (propose.md et al). Delta-gated: a night that changed nothing spawns nothing.
  // Skipped on --dry-run — watches write venue artifacts and spend real calls.
  if (dryRun) {
    result.passes.W = [{ pass: "W", status: "skipped", detail: "dry-run" }];
  } else {
    emit({ type: "pass-start", pass: "W", detail: "@nightly watches" });
    try {
      const watchCaller: WatchCaller | undefined = caller
        ? async (input) => {
            const c = await caller({ provider: "anthropic", ...input });
            return { ...c, provider: "anthropic" as const };
          }
        : undefined;
      const { value, durationMs } = await timed(() =>
        runWatches({ paths, mode: "nightly", date, caller: watchCaller }),
      );
      if (value.reports.length === 0) {
        result.passes.W = [{ pass: "W", status: "skipped", detail: "no @nightly watches", durationMs }];
        emit({ type: "pass-skipped", report: result.passes.W[0] });
      } else {
        for (const r of value.reports) {
          const report: PassReport = {
            pass: `W.${r.watch}`,
            status: r.outcome === "error" ? "failed" : "complete",
            detail: r.outcome + (r.detail ? ` — ${r.detail}` : ""),
            error: r.error,
          };
          result.passes.W.push(report);
          emit({ type: r.outcome === "error" ? "pass-failed" : "pass-complete", report });
          if (r.error) result.errors.push(`Watch ${r.watch}: ${r.error}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.passes.W = [{ pass: "W", status: "failed", error: msg }];
      emit({ type: "pass-failed", report: result.passes.W[0] });
      result.errors.push(`Watches: ${msg}`);
    }
  }

  // ---- Dashboard rebuild — runs LAST -----------------------------------------
  // Deferred to here (rather than at the end of Pass P) so it captures the
  // taste track's taste-decisions.json, written by runTasteTrack just above.
  // Building earlier raced the taste passes and left the taste page empty.
  // Never fatal.
  if (rebuildDashboard) {
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

/** Replay's eval corpus spans a wider window than TA/TB's 24h (design §9). */
const REPLAY_WINDOW_DAYS = 90;

interface TasteTrackArgs {
  paths: HivePaths;
  date: string;
  dryRun: boolean;
  condition: ConditionReport;
  caller?: ModelCaller;
  emit: (event: ProgressEvent) => void;
  result: NightlyResult;
  transcriptLoader: typeof loadTranscripts;
  gate: TasteGate;
  /** Where finished projects are recorded; null on dry-run. */
  manifest: ResumeManifest | null;
  /** Skip projects the manifest records as finished for this date. */
  resume: boolean;
  persist: () => Promise<void>;
}

async function runTasteTrack(args: TasteTrackArgs): Promise<void> {
  const { paths, date, dryRun, condition, caller, emit, result, transcriptLoader, gate, manifest } = args;
  const runDir = join(paths.memoryRunsDir, date);
  // Anchor the transcript window to the run date, matching condition's window
  // (so a retroactive `--date` covers the named day, not the wall clock).
  const now = new Date(`${date}T23:59:59.999Z`);

  // Combined TC artifact — clear stale at track start (restartability). It is
  // rebuilt below from this run's TC results plus any resumed ones.
  await rm(join(runDir, "taste-decisions.json"), { force: true });
  await rm(join(runDir, "taste-decisions.md"), { force: true });

  const targets = tasteTargets(paths, date, condition, gate.catchUpDays);
  const tcResults: TasteConsolidateResult[] = [];
  let anyFailed = false;

  for (const projectId of targets) {
    // ---- Resume: this project already finished the track for this date ----
    const done = args.resume ? manifest?.taste[projectId] : undefined;
    if (done) {
      if (done.tc) tcResults.push(done.tc);
      const r: PassReport = { pass: `TA.${projectId}`, status: "skipped", detail: `resumed — finished at ${done.at}` };
      result.passes.TA.push(r);
      emit({ type: "pass-skipped", report: r });
      continue;
    }
    // Back to the last run that analyzed this project, so nothing between
    // taste runs is lost and nothing is analyzed twice.
    const days = projectCatchUpDays(paths, date, projectId, gate);
    const hoursWindow = condition.hoursWindow + 24 * (days - 1);
    const markDone = async (tc: TasteConsolidateResult | null): Promise<void> => {
      if (!manifest || dryRun) return;
      manifest.taste[projectId] = { at: new Date().toISOString(), tc };
      await args.persist();
    };

    // ---- TA + TB (per-project batched extraction) ----
    const flagsPath = join(runDir, `taste-flags.${projectId}.json`);
    const tbPath = join(runDir, `candidates.TB.${projectId}.json`);
    await rm(flagsPath, { force: true });
    await rm(tbPath, { force: true });

    emit({ type: "pass-start", pass: `TA.${projectId}` });
    let extract: Awaited<ReturnType<typeof runProjectTasteExtract>>;
    try {
      const loaded = await transcriptLoader({ project: projectId, hoursWindow, now });
      const { value, durationMs } = await timed(() => runProjectTasteExtract(loaded, { caller }));
      extract = value;
      await mkdir(runDir, { recursive: true });
      await Bun.write(flagsPath, JSON.stringify(value.flags, null, 2));
      await Bun.write(tbPath, JSON.stringify(value.candidates, null, 2));
      for (const rec of value.usageRecords) {
        await appendUsageRecord(
          paths,
          date,
          buildUsageRecord(
            rec.pass,
            { ...rec.usage, inputTokens: rec.usage.inputTokens ?? 0, outputTokens: rec.usage.outputTokens ?? 0 },
            projectId,
          ),
        );
      }
      const taReport: PassReport = {
        pass: `TA.${projectId}`,
        status: "complete",
        detail:
          `${value.windowCount} window(s) · ${value.flaggedCount} flagged` +
          (days > 1 ? ` · ${days} days of sessions` : ""),
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
      anyFailed = true;
      continue; // one project's failure never blocks the others
    }

    // ---- TC (consolidate/gate) — skipped on dry-run (it is the store writer) ----
    if (dryRun) {
      result.passes.TC.push({ pass: `TC.${projectId}`, status: "skipped", detail: "dry-run" });
      continue;
    }
    if (extract.candidates.length === 0) {
      result.passes.TC.push({ pass: `TC.${projectId}`, status: "skipped", detail: "no candidates" });
      await markDone(null);
      continue;
    }
    // Replay eval corpus (design §9) — built from a WIDER 90d window than
    // TA/TB's 24h, and only when there are FUZZY candidates replay could gate
    // (skip the I/O otherwise). Passed INTO TC to keep it disk-free + hermetic.
    // A load failure leaves the corpus null (replay-enabled but inconclusive →
    // candidates HOLD), never undefined (which would disable replay = fail open).
    let replayCorpus: ReplayCorpus | null | undefined;
    if (extract.candidates.some((c) => c.tier === "FUZZY")) {
      replayCorpus = null; // enabled; stays null on load failure → inconclusive → hold
      try {
        const since = new Date(now.getTime() - REPLAY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
        const history = await transcriptLoader({ project: projectId, since, now });
        replayCorpus = buildReplayCorpus(history.flatMap((t) => t.events));
      } catch (err) {
        result.errors.push(`replay corpus (${projectId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    emit({ type: "pass-start", pass: `TC.${projectId}` });
    try {
      const { value: tc, durationMs } = await timed(() =>
        runTasteConsolidate(extract.candidates, { paths, projectId, now: date, caller, replayCorpus }),
      );
      tcResults.push(tc);
      await markDone(tc);
      if (tc.replayUsage) {
        await appendUsageRecord(
          paths,
          date,
          buildUsageRecord(
            "TR",
            { ...tc.replayUsage, inputTokens: tc.replayUsage.inputTokens ?? 0, outputTokens: tc.replayUsage.outputTokens ?? 0 },
            projectId,
          ),
        );
      }
      if (tc.usage) {
        await appendUsageRecord(
          paths,
          date,
          buildUsageRecord(
            "TC",
            { ...tc.usage, inputTokens: tc.usage.inputTokens ?? 0, outputTokens: tc.usage.outputTokens ?? 0 },
            projectId,
          ),
        );
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
      anyFailed = true;
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

  // The track counts as run (and resets the cadence) only when every project
  // finished. A failure leaves the night due, so a retry or the next night
  // picks up the failed project's sessions.
  if (manifest && !dryRun && !anyFailed) {
    manifest.tasteComplete = new Date().toISOString();
    await args.persist();
  }
}

/**
 * Projects the taste track covers tonight: every project with signal on any
 * night since the last taste run, read from each night's condition.json.
 * Tonight's signal comes from the in-memory report. A night with no
 * condition.json (the nightly never ran) contributes nothing.
 */
function tasteTargets(
  paths: HivePaths,
  date: string,
  condition: ConditionReport,
  catchUpDays: number,
): string[] {
  const names = new Set(condition.projects.filter(projectHasSignal).map((p) => p.projectName));
  for (const d of catchUpDates(date, catchUpDays)) {
    if (d === date) continue;
    const file = join(paths.memoryRunsDir, d, "condition.json");
    if (!existsSync(file)) continue;
    try {
      const prior = JSON.parse(readFileSync(file, "utf-8")) as ConditionReport;
      for (const p of prior.projects.filter(projectHasSignal)) names.add(p.projectName);
    } catch {
      // intentional: an unreadable report adds no targets; tonight's still run
    }
  }
  return [...names];
}

/** Count candidates in a B/C artifact ({ candidates: [...] }). */
function countArtifactCandidates(file: string): number {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { candidates?: unknown[] };
    return parsed.candidates?.length ?? 0;
  } catch {
    // intentional: a count is display-only; V reads the file itself
    return 0;
  }
}

function readDecisions(file: string): Array<{ action: keyof NightlyResult["decisionCounts"] }> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      decisions?: Array<{ action: keyof NightlyResult["decisionCounts"] }>;
    };
    return parsed.decisions ?? [];
  } catch {
    // intentional: counts are display-only
    return [];
  }
}

/** Say in the briefing that the taste track sat tonight out, so a quiet taste
 * section reads as scheduled, not broken. Writes the run copy and the landed
 * copy when they exist. */
async function noteTasteSkipInBriefing(
  runDir: string,
  landedPath: string | null,
  gate: TasteGate,
): Promise<void> {
  const note =
    `\n\n## Taste\n- Taste track skipped tonight (${gate.reason}). ` +
    `Next run ${gate.nextRun}; it covers every session since ${gate.lastRun ?? "the last run"}.\n`;
  for (const file of [join(runDir, "briefing.md"), landedPath]) {
    if (file && existsSync(file)) await appendFile(file, note);
  }
}
