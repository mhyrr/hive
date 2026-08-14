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

import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { completeClaudeTextBounded, type ClaudeTextCompletion } from "./claude";
import { extractConfigValue } from "./config";
import { getProjectPaths, type HivePaths } from "./paths";
import { now as hiveNow, toIsoTimestamp } from "./time";
import { writeInvocationLog } from "./watch-log";
import {
  evaluateWatchDelta,
  assembleWatchDigest,
  type DeltaSeams,
} from "./watch-delta";
import { resolveWatchModel } from "./watch-model";
import { dispatchTicketForReview } from "./review-dispatch";
import {
  loadWatchState,
  recordUsage,
  saveWatchState,
  stateEntry,
  type WatchOutcome,
} from "./watch-state";
import {
  discoverWatches,
  isDue,
  renderWatchQuestion,
  watchInterval,
  type WatchAutonomy,
  type WatchDef,
} from "./watch";

// ---------------------------------------------------------------------------
// Autonomy ceiling
// ---------------------------------------------------------------------------

const AUTONOMY_ORDER: Record<WatchAutonomy, number> = { observe: 0, propose: 1, act: 2 };

export const DEFAULT_AUTONOMY_CEILING: WatchAutonomy = "propose";

/** Global ceiling from ~/.hive/config.md (`watches.max_autonomy: ...`).
 * Missing or unparseable → the shipping default (propose). Act is branch-only
 * and review-required, but still requires an explicit global authorization. */
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
      return "Autonomy: OBSERVE. Interpret the evidence and make connections. Do not recommend actions or change state.";
    case "propose":
      return "Autonomy: PROPOSE. Recommend every item that clearly deserves review. Do not fill a quota. You may not execute or change state.";
    case "act":
      return "Autonomy: ACT. You may execute only the ticket selected through the eligibility rules in this watch. Work on an isolated feature branch and never merge into main.";
  }
}

export function buildWatchSystemPrompt(watch: WatchDef, autonomy: WatchAutonomy): string {
  return [
    `You are a HIVE watch — a standing question evaluated against fresh evidence. Watch: ${watch.qualifiedName}.`,
    autonomyInstruction(autonomy),
    "Hard rules:",
    "- The digest in the user message is your ENTIRE evidence base. Do not assume activity beyond it.",
    "- Cite the digest's bracketed source tags verbatim for every major conclusion. Mark reasoning beyond the evidence as inference.",
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

export interface WatchDispatchRequest {
  project: string;
  ticketId: string;
  watch: string;
}

export interface WatchDispatchResult {
  runId: string;
  detail: string;
}

export type WatchDispatcher = (input: WatchDispatchRequest) => Promise<WatchDispatchResult>;

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
  dispatcher?: WatchDispatcher;
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

const ACT_SELECTION = /^ACT\s+([a-zA-Z0-9_-]+)\/(TK-\d+)\s*$/gm;

async function appendInbox(inboxPath: string, header: string, body: string): Promise<void> {
  const existing = existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") : `${header}\n\n`;
  await Bun.write(inboxPath, `${existing}${body}`);
}

async function acquireWatchRunLock(paths: HivePaths): Promise<() => Promise<void>> {
  const lockPath = join(paths.watchesDir, ".run.lock");
  await mkdir(paths.watchesDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: toIsoTimestamp() }));
      await handle.close();
      return async () => { await unlink(lockPath).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(lockPath, "utf-8")
        .then((raw) => JSON.parse(raw) as { pid?: number })
        .catch(() => ({}));
      if (typeof owner.pid === "number") {
        try {
          process.kill(owner.pid, 0);
          throw new Error(`Another watch cycle is running (pid ${owner.pid})`);
        } catch (probe) {
          if (probe instanceof Error && probe.message.startsWith("Another watch cycle")) throw probe;
        }
      }
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new Error("Could not acquire watch cycle lock");
}

async function runWatchesUnlocked(options: RunWatchesOptions): Promise<RunWatchesResult> {
  const { paths } = options;
  const now = options.now ?? hiveNow();
  const date = options.date ?? now.toISOString().slice(0, 10);
  const caller: WatchCaller = options.caller ?? ((input) => completeClaudeTextBounded(input));
  const dispatcher = options.dispatcher ?? (async (input) => {
    const result = await dispatchTicketForReview({
      paths,
      projectId: input.project,
      ticketId: input.ticketId,
      sourceWatch: input.watch,
    });
    return { runId: result.runId, detail: `${result.branch} at ${result.workspacePath}` };
  });
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
    const effective = clampAutonomy(watch.autonomy, ceiling);
    const entry = stateEntry(state, watch.qualifiedName);
    const interval = watchInterval(watch.cadence, entry.lastRun, now);
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
        since: interval.since,
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

      const digest = await assembleWatchDigest({ paths, watch, since: interval.since, now, seams: options.seams });
      if (effective === "act" && digest.actCandidateCount === 0) {
        entry.lastRun = toIsoTimestamp(now);
        entry.lastDigests = delta.fingerprints;
        entry.lastOutcome = "no-delta";
        entry.lastError = null;
        await saveWatchState(paths, state);
        report({ outcome: "no-delta", detail: "no eligible Act ticket", durationMs: Date.now() - startMs });
        continue;
      }
      if (digest.empty && !forced) {
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
      const question = renderWatchQuestion(watch.question, interval);
      const userContent = `${digest.text}\n\n# Standing question\n${question}`;

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
      } else if (watch.venue === "dispatch") {
        if (effective !== "act") {
          const heading = `## ${toIsoTimestamp(now)} — watch:${watch.qualifiedName}\n\n`;
          artifactPath = watch.project ? getProjectPaths(paths, watch.project).inbox : join(paths.home, "inbox.md");
          await appendInbox(artifactPath, watch.project ? `# Inbox: ${watch.project}` : "# Inbox", `${heading}${output}\n\n`);
          outcome = "surfaced";
          detail = `act clamped to ${effective}; proposal surfaced without dispatch`;
        } else {
          const selections = [...output.matchAll(ACT_SELECTION)];
          if (selections.length !== 1) {
            outcome = "quiet";
            detail = "act output dropped — expected exactly one `ACT project/TK-NNN`";
          } else {
            const selected = selections[0]!;
            const project = selected[1]!;
            const ticketId = selected[2]!;
            const candidateTag = `[A:${project}/${ticketId}]`;
            if (!digest.provenance.includes(candidateTag) || !output.includes(candidateTag)) {
              outcome = "quiet";
              detail = "act selection dropped — ticket was not in the eligible shortlist";
            } else {
              let dispatched: WatchDispatchResult;
              try {
                dispatched = await dispatcher({ project, ticketId, watch: watch.qualifiedName });
              } catch (dispatchError) {
                const message = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
                entry.lastOutcome = "error";
                entry.lastError = message;
                await saveWatchState(paths, state);
                try {
                  await writeInvocationLog({
                    paths, watch, now, modelId, autonomy: effective, reasons: delta.reasons,
                    systemPrompt, userContent, output: null, outcome: "error",
                    error: `Dispatch failed: ${message}\n\nModel output:\n${output}`,
                    durationMs: completion.durationMs,
                  });
                } catch (logErr) {
                  warnings.push(`${watch.qualifiedName}: invocation log write failed (${logErr instanceof Error ? logErr.message : String(logErr)})`);
                }
                report({ outcome: "error", error: message, reasons: delta.reasons, durationMs: Date.now() - startMs });
                continue;
              }
              const heading = `## ${toIsoTimestamp(now)} — watch:${watch.qualifiedName}\n\n`;
              const body = `${heading}${candidateTag} dispatched ${dispatched.runId} to an isolated review branch. It will not merge or push.\n\n`;
              artifactPath = watch.project ? getProjectPaths(paths, watch.project).inbox : join(paths.home, "inbox.md");
              await appendInbox(artifactPath, watch.project ? `# Inbox: ${watch.project}` : "# Inbox", body);
              outcome = "surfaced";
              detail = `${dispatched.runId} dispatched for human review`;
            }
          }
        }
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
        // Ticket creation remains a future venue; Act dispatches existing work.
        outcome = "error";
        detail = `venue "${watch.venue}" is not implemented`;
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

export async function runWatches(options: RunWatchesOptions): Promise<RunWatchesResult> {
  const release = await acquireWatchRunLock(options.paths);
  try {
    return await runWatchesUnlocked(options);
  } finally {
    await release();
  }
}
