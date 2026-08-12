// Watch tick executor (TK-138).
//
// Per selected watch: due-ness → delta gate → (at most) ONE bounded model
// call → venue render → state. Watches run in SERIES — concurrent
// `claude --print` subprocesses contend on OAuth/Keychain in detached
// launchd contexts (the empirical lesson the nightly pipeline encodes).
//
// State discipline: lastRun/lastDigests persist only on settled outcomes
// (surfaced/quiet/no-delta). A deferred or errored watch keeps its old
// state so the SAME delta re-fires it next tick — a swallowed fingerprint
// update would silently eat the signal.

import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { completeClaudeTextBounded, type ClaudeTextCompletion } from "./claude";
import { extractConfigValue } from "./config";
import { getProjectPaths, type HivePaths } from "./paths";
import { now as hiveNow, toCompactTimestamp, toIsoTimestamp } from "./time";
import {
  evaluateWatchDelta,
  assembleWatchDigest,
  type DeltaSeams,
} from "./watch-delta";
import { resolveWatchModel } from "./watch-model";
import {
  loadWatchState,
  recordUsage,
  saveWatchState,
  stateEntry,
  type WatchOutcome,
} from "./watch-state";
import { discoverWatches, isDue, type WatchAutonomy, type WatchDef } from "./watch";

// ---------------------------------------------------------------------------
// Autonomy ceiling
// ---------------------------------------------------------------------------

const AUTONOMY_ORDER: Record<WatchAutonomy, number> = { observe: 0, propose: 1, act: 2 };

export const DEFAULT_AUTONOMY_CEILING: WatchAutonomy = "propose";

/** Global ceiling from ~/.hive/config.md (`watches.max_autonomy: ...`).
 * Missing or unparseable → the shipping default (propose): nothing anywhere
 * dispatches until Greg raises it deliberately. */
export function readAutonomyCeiling(paths: HivePaths): WatchAutonomy {
  try {
    const raw = extractConfigValue(readFileSync(paths.config, "utf-8"), "watches.max_autonomy");
    if (raw === "observe" || raw === "propose" || raw === "act") return raw;
  } catch {
    // intentional: unreadable config — ship default
  }
  return DEFAULT_AUTONOMY_CEILING;
}

export function clampAutonomy(own: WatchAutonomy, ceiling: WatchAutonomy): WatchAutonomy {
  return AUTONOMY_ORDER[own] <= AUTONOMY_ORDER[ceiling] ? own : ceiling;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** Exact silence token. `claude --print` rejects empty results (TK-136), so
 * quiet must be an explicit reply, never an empty one. */
export const NO_SIGNAL = "NO_SIGNAL";

function autonomyInstruction(autonomy: WatchAutonomy): string {
  switch (autonomy) {
    case "observe":
      return "Autonomy: OBSERVE. Write a short memo — observations and connections only. Do not propose actions.";
    case "propose":
      return "Autonomy: PROPOSE. Surface at most 3 candidate items. Each must state: the observed signal (cited), the item itself, and the first concrete step. You may not execute anything.";
    case "act":
      // Slice 1 has no act-capable venue; the runner clamps before this is
      // reachable, but keep the text honest if that ever regresses.
      return "Autonomy: PROPOSE. Surface at most 3 candidate items. Each must state: the observed signal (cited), the item itself, and the first concrete step. You may not execute anything.";
  }
}

export function buildWatchSystemPrompt(watch: WatchDef, autonomy: WatchAutonomy): string {
  return [
    `You are a HIVE watch — a standing question evaluated against fresh evidence. Watch: ${watch.qualifiedName}.`,
    autonomyInstruction(autonomy),
    "Hard rules:",
    "- The digest in the user message is your ENTIRE evidence base. Do not assume activity beyond it.",
    "- Every claim must cite evidence anchors from the digest VERBATIM — ticket IDs (TK-xxx), commit SHAs, session labels, file paths. An uncited claim is discarded.",
    `- Silence is a valid answer — the operator's attention is the scarce currency. If nothing clears the bar of genuinely worth surfacing, reply with exactly ${NO_SIGNAL} and nothing else.`,
    "- No preamble, no restating the question, no filler. Output is read as-is.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type WatchCaller = (input: {
  modelId: string;
  systemPrompt: string;
  userContent: string;
}) => Promise<ClaudeTextCompletion>;

export interface WatchRunReport {
  watch: string;
  outcome: WatchOutcome | "not-due" | "disabled";
  effectiveAutonomy: WatchAutonomy;
  detail?: string;
  reasons?: string[];
  error?: string;
  artifactPath?: string | null;
  durationMs?: number;
}

export interface RunWatchesOptions {
  paths: HivePaths;
  /** "due": the hourly tick — due-ness + delta gate. "nightly": only @nightly
   * watches, due-ness bypassed (the orchestrator just made their scope fresh),
   * delta gate kept. "named": exactly `names`, due-ness AND gate bypassed —
   * the operator asked, so the model looks. */
  mode: "due" | "nightly" | "named";
  names?: string[];
  now?: Date;
  /** Artifact date for briefing-venue writes (runs/{DATE}/). Defaults to now's date. */
  date?: string;
  caller?: WatchCaller;
  seams?: DeltaSeams;
}

export interface RunWatchesResult {
  reports: WatchRunReport[];
  warnings: string[];
}

function callCapPerTick(): number {
  const raw = Number(process.env.HIVE_WATCH_MAX_CALLS_PER_TICK);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
}

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit|429|overloaded|quota|too many requests/i.test(msg);
}

async function appendInbox(inboxPath: string, header: string, body: string): Promise<void> {
  const existing = existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") : `${header}\n\n`;
  await Bun.write(inboxPath, `${existing}${body}`);
}

/** Full observability for every model call: the EXACT prompts sent and what
 * came back, one file per invocation under ~/.hive/watches/log/<date>/.
 * No-delta ticks write nothing here (there was no call to record). */
async function writeInvocationLog(args: {
  paths: HivePaths;
  watch: WatchDef;
  now: Date;
  modelId: string;
  autonomy: WatchAutonomy;
  reasons: string[];
  systemPrompt: string;
  userContent: string;
  output: string | null;
  outcome: string;
  error?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  const dir = join(args.paths.watchesDir, "log", args.now.toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${args.watch.qualifiedName.replace(/\//g, "--")}-${toCompactTimestamp(args.now)}.md`);
  const body = [
    "---",
    `watch: ${args.watch.qualifiedName}`,
    `at: ${toIsoTimestamp(args.now)}`,
    `model: ${args.modelId}`,
    `autonomy: ${args.autonomy}`,
    `outcome: ${args.outcome}`,
    ...(args.durationMs != null ? [`durationMs: ${args.durationMs}`] : []),
    ...(args.reasons.length > 0 ? [`reasons: ${args.reasons.join(" | ")}`] : []),
    "---",
    "",
    "## System prompt",
    "",
    args.systemPrompt,
    "",
    "## User content (digest + standing question)",
    "",
    args.userContent,
    "",
    args.error != null ? "## Error" : "## Output",
    "",
    args.error ?? args.output ?? "(none)",
    "",
  ].join("\n");
  await Bun.write(file, body);
}

export async function runWatches(options: RunWatchesOptions): Promise<RunWatchesResult> {
  const { paths } = options;
  const now = options.now ?? hiveNow();
  const date = options.date ?? now.toISOString().slice(0, 10);
  const caller: WatchCaller = options.caller ?? ((input) => completeClaudeTextBounded(input));
  const ceiling = readAutonomyCeiling(paths);

  const { watches, warnings } = await discoverWatches(paths);
  const state = await loadWatchState(paths);
  const reports: WatchRunReport[] = [];
  let callsThisTick = 0;

  // Liveness stamp: every hourly tick records itself, even when nothing is
  // due — the dashboard's "is the ambient agent breathing" signal.
  if (options.mode === "due") {
    state.lastTick = toIsoTimestamp(now);
    await saveWatchState(paths, state);
  }

  const selected = watches.filter((w) => {
    if (options.mode === "named") return options.names?.includes(w.qualifiedName) || options.names?.includes(w.name);
    if (options.mode === "nightly") return w.cadence.type === "nightly";
    return true;
  });

  for (const watch of selected) {
    // Slice 1 ships no act-capable machinery: even with the ceiling raised,
    // effective autonomy tops out at propose until the harvester slice lands.
    const effective = clampAutonomy(clampAutonomy(watch.autonomy, ceiling), "propose");
    const entry = stateEntry(state, watch.qualifiedName);
    const startMs = Date.now();

    const report = (partial: Omit<WatchRunReport, "watch" | "effectiveAutonomy">): void => {
      reports.push({ watch: watch.qualifiedName, effectiveAutonomy: effective, ...partial });
    };

    try {
      if (!watch.enabled) {
        if (options.mode === "named") report({ outcome: "disabled", detail: "enable it first: hive watch on" });
        continue;
      }
      if (options.mode === "due" && !isDue(watch.cadence, entry.lastRun, now)) {
        continue; // not evaluated — no state change, no report noise
      }

      // ---- Delta gate (bypassed only for operator-named runs) ----
      const forced = options.mode === "named";
      const delta = await evaluateWatchDelta({
        paths,
        watch,
        lastDigests: entry.lastDigests,
        now,
        seams: options.seams,
      });
      if (!forced && !delta.changed) {
        entry.lastRun = toIsoTimestamp(now);
        entry.lastDigests = delta.fingerprints;
        entry.lastOutcome = "no-delta";
        entry.lastError = null;
        await saveWatchState(paths, state);
        report({ outcome: "no-delta", durationMs: Date.now() - startMs });
        continue;
      }

      if (callsThisTick >= callCapPerTick()) {
        // Backstop, not budget: state untouched so the same delta re-fires
        // next tick. Reported so the cap is never a silent drop.
        entry.lastOutcome = "deferred:cap";
        await saveWatchState(paths, state);
        report({ outcome: "deferred:cap", detail: `per-tick call cap (${callCapPerTick()}) reached` });
        continue;
      }

      const digest = await assembleWatchDigest({ paths, watch, now, seams: options.seams });
      if (digest.empty) {
        entry.lastRun = toIsoTimestamp(now);
        entry.lastDigests = delta.fingerprints;
        entry.lastOutcome = "no-delta";
        entry.lastError = null;
        await saveWatchState(paths, state);
        report({ outcome: "no-delta", detail: "scope empty at digest time", durationMs: Date.now() - startMs });
        continue;
      }

      // ---- The one model call ----
      const modelId = resolveWatchModel(watch.model, watch.name);
      const systemPrompt = buildWatchSystemPrompt(watch, effective);
      const userContent = `${digest.text}\n\n# Standing question\n${watch.question}`;

      let completion: ClaudeTextCompletion;
      callsThisTick += 1;
      try {
        completion = await caller({ modelId, systemPrompt, userContent });
      } catch (err) {
        const outcome: WatchOutcome = isQuotaError(err) ? "deferred:quota" : "error";
        entry.lastOutcome = outcome;
        entry.lastError = err instanceof Error ? err.message : String(err);
        await saveWatchState(paths, state);
        try {
          await writeInvocationLog({
            paths, watch, now, modelId, autonomy: effective, reasons: delta.reasons,
            systemPrompt, userContent, output: null, outcome, error: entry.lastError,
          });
        } catch (logErr) {
          warnings.push(`${watch.qualifiedName}: invocation log write failed (${logErr instanceof Error ? logErr.message : String(logErr)})`);
        }
        report({ outcome, error: entry.lastError, reasons: delta.reasons, durationMs: Date.now() - startMs });
        continue;
      }

      entry.lastInvoked = toIsoTimestamp(now);
      recordUsage(entry, {
        at: toIsoTimestamp(now),
        model: completion.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        durationMs: completion.durationMs,
      });

      const output = completion.text.trim();
      const chosesilence = output === NO_SIGNAL || output.startsWith(`${NO_SIGNAL}\n`);
      const cites = digest.provenance.some((anchor) => output.includes(anchor));

      let outcome: WatchOutcome;
      let detail: string | undefined;
      let artifactPath: string | null = null;

      if (chosesilence) {
        outcome = "quiet";
      } else if (!cites) {
        // Provenance rule: no citation, no output. Dropped, not surfaced.
        outcome = "quiet";
        detail = "output dropped — no evidence anchor cited";
      } else if (watch.venue === "inbox") {
        const heading = `## ${toIsoTimestamp(now)} — watch:${watch.qualifiedName}\n\n`;
        const body = `${heading}${output}\n\n`;
        if (watch.project) {
          await appendInbox(getProjectPaths(paths, watch.project).inbox, `# Inbox: ${watch.project}`, body);
          artifactPath = getProjectPaths(paths, watch.project).inbox;
        } else {
          artifactPath = join(paths.home, "inbox.md");
          await appendInbox(artifactPath, "# Inbox", body);
        }
        outcome = "surfaced";
      } else if (watch.venue === "briefing") {
        const runDir = join(paths.memoryRunsDir, date);
        await mkdir(runDir, { recursive: true });
        artifactPath = join(runDir, `${watch.name}.md`);
        await Bun.write(artifactPath, `# Watch: ${watch.qualifiedName} — ${date}\n\n${output}\n`);
        outcome = "surfaced";
      } else {
        // tickets/dispatch venues wait on the harvester slice (TK-125/TK-130).
        outcome = "error";
        detail = `venue "${watch.venue}" not supported in slice 1`;
      }

      entry.lastRun = toIsoTimestamp(now);
      entry.lastDigests = delta.fingerprints;
      entry.lastOutcome = outcome;
      entry.lastError = outcome === "error" ? detail ?? null : null;
      await saveWatchState(paths, state);
      try {
        await writeInvocationLog({
          paths, watch, now, modelId, autonomy: effective, reasons: delta.reasons,
          systemPrompt, userContent, output,
          outcome: outcome + (detail ? ` (${detail})` : ""),
          durationMs: completion.durationMs,
        });
      } catch (logErr) {
        warnings.push(`${watch.qualifiedName}: invocation log write failed (${logErr instanceof Error ? logErr.message : String(logErr)})`);
      }
      report({ outcome, detail, reasons: delta.reasons, artifactPath, durationMs: Date.now() - startMs });
    } catch (err) {
      // Per-watch isolation: one watch's throw never kills the tick.
      const msg = err instanceof Error ? err.message : String(err);
      entry.lastOutcome = "error";
      entry.lastError = msg;
      try {
        await saveWatchState(paths, state);
      } catch {
        // intentional: state write failed — the report still carries the error
      }
      report({ outcome: "error", error: msg, durationMs: Date.now() - startMs });
    }
  }

  return { reports, warnings };
}
