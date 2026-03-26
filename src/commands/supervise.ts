import { join } from "node:path";

import {
  formatDetachedSupervisorState,
  markDetachedSupervisorStopRequested,
  markDetachedSupervisorStopped,
  noteDetachedSupervisorPass,
  readDetachedSupervisorState,
  reconcileDetachedSupervisorState,
  startDetachedSupervisor,
  writeDetachedSupervisorState,
} from "../lib/detached-supervisor";
import { appendFeedEntry } from "../lib/feed";
import { UsageError } from "../lib/errors";
import { section } from "../lib/format";
import { appendLogEntry } from "../lib/log";
import { readGatewayState } from "../lib/gateway-state";
import { closeMessage, createMessage, findMessage, listOpenProjectMessages } from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import {
  finalizeRun,
  listActiveRuns,
  listAllRuns,
  listRecentRunResults,
  listRecentRuns,
  markRunStopRequested,
  readRunRecord,
  RunRecord,
  RunResult,
  writeRunResult,
} from "../lib/runs";
import {
  assessPulse,
  assessRecoveredRuns,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_PULSE_INTERVAL_TICKS,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
  extractVerificationSpec,
  formatPulse,
  isProcessAlive,
  RecoveredRun,
  runVerification,
  type VerificationOutcome,
} from "../lib/supervisor";
import { extractRepoPath } from "../lib/project";
import { toIsoTimestamp } from "../lib/time";
import { hasPersistentStewardSession, notifyStewardRunCompleted } from "../lib/persistent-steward";
import { launchAgentPass } from "./launch";
import { dispatchWorkerLaunchPass } from "./worker-launch-dispatch";

// ── Types ───────────────────────────────────────────────────────────────────────

type SuperviseOptions = {
  intervalSeconds: number;
  maxParallel: number;
  once: boolean;
  detach: boolean;
  child: boolean;
  managed: boolean;
  parentPid: number | null;
  action: "run" | "status" | "stop" | "logs";
};

// ── Helpers ─────────────────────────────────────────────────────────────────────

function formatNaturalList(items: string[]): string {
  if (items.length === 0) return "(none)";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatRecoveredRuns(recovered: RecoveredRun[]): string {
  if (recovered.length === 0) return "- none";
  return recovered
    .map(
      (entry) =>
        `- ${entry.run.agentId} | ${entry.status} | ${entry.run.runId}\n  ${entry.reason}`,
    )
    .join("\n\n");
}

function formatLaunchSettledResult(input: {
  agentId: string;
  messageFilename?: string | null;
  result: PromiseSettledResult<string>;
}): string {
  if (input.result.status === "fulfilled") {
    return `- ${input.agentId}: ${input.result.value}`;
  }

  const message =
    input.result.reason instanceof Error
      ? input.result.reason.message
      : String(input.result.reason);

  if (input.messageFilename) {
    return `- ${input.agentId}: failed to launch (${message}) [${input.messageFilename}]`;
  }

  return `- ${input.agentId}: failed to launch (${message})`;
}

function formatVerificationResults(results: { agentId: string; summary: string }[]): string {
  if (results.length === 0) return "No verifications this pass.";
  return results.map((r) => `- ${r.agentId}: ${r.summary}`).join("\n");
}

function endedAfter(value: string, reference: string | null): boolean {
  if (!reference) return true;
  return new Date(value).getTime() > new Date(reference).getTime();
}

function resolveGatewayBaseUrl(input: {
  url: string;
  port: number | null;
}): string | null {
  const trimmedUrl = input.url.trim();
  if (trimmedUrl) return trimmedUrl.replace(/\/+$/, "");
  if (input.port !== null) return `http://localhost:${input.port}`;
  return null;
}

// ── Persistent steward wake (simplified) ────────────────────────────────────────

async function requestPersistentStewardWake(input: {
  paths: Awaited<ReturnType<typeof ensureHiveScaffold>>;
  projectId: string;
  message: string;
}): Promise<{ status: "triggered" | "failed"; detail: string }> {
  const gatewayState = await readGatewayState(input.paths.home);

  if (!gatewayState || gatewayState.status !== "active") {
    return { status: "failed", detail: "gateway is not active" };
  }

  const baseUrl = resolveGatewayBaseUrl({
    url: gatewayState.url,
    port: gatewayState.port,
  });

  if (!baseUrl) {
    return { status: "failed", detail: "gateway URL is unavailable" };
  }

  try {
    const response = await fetch(`${baseUrl}/api/steward/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: input.projectId,
        message: input.message,
      }),
    });

    if (!response.ok) {
      return { status: "failed", detail: `gateway wake failed (${response.status})` };
    }

    return { status: "triggered", detail: "wake requested via gateway" };
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Run recovery ────────────────────────────────────────────────────────────────

async function reconcileRecoveredRuns(input: {
  paths: Awaited<ReturnType<typeof ensureHiveScaffold>>;
  activeProject: string;
  projectPaths: ReturnType<typeof getProjectPaths>;
  recovered: RecoveredRun[];
}): Promise<void> {
  for (const entry of input.recovered) {
    const persistedRun = (await readRunRecord(entry.run.path)) ?? entry.run;
    const finalizedRun = await finalizeRun({
      projectPaths: input.projectPaths,
      run: persistedRun,
      status: entry.status,
      exitCode: persistedRun.exitCode,
    });
    const assignmentAfterExit = finalizedRun.sourceMessage
      ? await findMessage(input.paths.msgDir, finalizedRun.sourceMessage, input.activeProject)
      : null;

    const runResult = await writeRunResult(finalizedRun, {
      assignmentStatusAfterExit: assignmentAfterExit?.attributes.status ?? null,
      assignmentResolvedByWorker: assignmentAfterExit?.attributes.status === "resolved",
      changedFiles: [],
      gitSummaryLines: [entry.reason],
      finalVisibleOutput: entry.status === "cancelled"
        ? "Supervisor recovered a cancelled run after the process exited before the owning launcher finalized it."
        : "Supervisor recovered a stale active run whose process was no longer alive.",
    });
    await notifyStewardRunCompleted(input.paths.home, input.activeProject, runResult);
    await appendFeedEntry(input.paths, {
      project: input.activeProject,
      headline: `Recovered ${finalizedRun.agentId} ${entry.status}`,
      details: [`run: ${finalizedRun.runId}`, entry.reason],
    });
    await appendLogEntry(
      input.projectPaths.log,
      "hive supervise",
      `Recovered ${finalizedRun.agentId} ${entry.status}: ${entry.reason}`,
    );
  }
}

// ── Verification ────────────────────────────────────────────────────────────────

async function verifyCompletedWorker(input: {
  paths: import("../lib/paths").HivePaths;
  projectPaths: import("../lib/paths").ProjectPaths;
  activeProject: string;
  agentId: string;
  sourceMessage: import("../lib/messages").HiveMessage;
  scope: string[] | null;
}): Promise<{ outcome: VerificationOutcome; summary: string } | null> {
  const spec = extractVerificationSpec(input.sourceMessage);
  if (!spec) return null;

  const projectConfig = await Bun.file(input.projectPaths.config).text();
  const repoPath = extractRepoPath(projectConfig);
  if (!repoPath) return null;

  const attempt = parseInt(input.sourceMessage.attributes.attempt ?? "1", 10) || 1;
  const outcome = runVerification({ spec, repoPath, attempt, scope: input.scope });

  if (outcome.action === "keep") {
    const summary = `verify PASS: ${spec.command} (attempt ${attempt}/${spec.maxAttempts})`;
    await appendLogEntry(input.projectPaths.log, "hive supervise verify", `${input.agentId}: ${summary}`);
    await appendFeedEntry(input.paths, {
      project: input.activeProject,
      headline: `${input.agentId} verified`,
      details: [`command: ${spec.command}`, `result: PASS`, `attempt: ${attempt}/${spec.maxAttempts}`],
    });
    return { outcome, summary };
  }

  if (outcome.action === "retry") {
    const summary = `verify FAIL: ${spec.command} (attempt ${outcome.attempt}/${outcome.maxAttempts}, will retry)`;

    await closeMessage(
      input.paths.msgDir,
      input.sourceMessage.filename,
      "supervisor",
      `Verification failed (attempt ${outcome.attempt}/${outcome.maxAttempts}). Retrying.`,
      input.activeProject,
    );

    const revertNote = outcome.reverted
      ? `The previous changes within scope (${input.scope?.join(", ") ?? "unknown"}) have been reverted.`
      : `WARNING: Revert was not performed (${outcome.revertSummary}). The working tree may contain changes from the previous attempt.`;

    const retryBody = [
      input.sourceMessage.body,
      "",
      `## Verification Failure (attempt ${outcome.attempt}/${outcome.maxAttempts})`,
      `Command: ${spec.command}`,
      `Exit code: ${outcome.verifyResult.exitCode}`,
      "Output:", "```", outcome.verifyResult.output.slice(0, 1000), "```",
      "", revertNote, "", "Fix the issue and try again.",
    ].join("\n");

    const preserveKeys = ["task", "launch", "scope", "persona", "runtime", "model", "verify", "max-attempts", "auto-revert"];
    const retryAttrs: Record<string, string> = {};
    for (const key of preserveKeys) {
      const value = input.sourceMessage.attributes[key];
      if (value) retryAttrs[key] = value;
    }
    retryAttrs.attempt = String(attempt + 1);

    await createMessage(input.paths.msgDir, {
      from: input.sourceMessage.attributes.from ?? "supervisor",
      to: input.sourceMessage.attributes.to ?? input.agentId,
      type: "assign",
      project: input.activeProject,
      body: retryBody,
      attributes: retryAttrs,
    });

    await appendLogEntry(input.projectPaths.log, "hive supervise verify", `${input.agentId}: ${summary}\nReverted: ${outcome.revertSummary}`);
    await appendFeedEntry(input.paths, {
      project: input.activeProject,
      headline: `${input.agentId} verify failed, retrying`,
      details: [`command: ${spec.command}`, `attempt: ${outcome.attempt}/${outcome.maxAttempts}`, `revert: ${outcome.revertSummary}`],
    });
    return { outcome, summary };
  }

  // action === "block"
  const summary = `verify FAIL: ${spec.command} (attempt ${outcome.attempt}/${outcome.maxAttempts}, exhausted)`;

  await closeMessage(
    input.paths.msgDir,
    input.sourceMessage.filename,
    "supervisor",
    `Verification failed after ${outcome.maxAttempts} attempt(s). Blocked for steward review.\nCommand: ${spec.command}\nExit: ${outcome.verifyResult.exitCode}`,
    input.activeProject,
  );

  await appendLogEntry(input.projectPaths.log, "hive supervise verify", `${input.agentId}: ${summary}\nReverted: ${outcome.revertSummary}`);
  await appendFeedEntry(input.paths, {
    project: input.activeProject,
    headline: `${input.agentId} verify exhausted, blocked`,
    details: [`command: ${spec.command}`, `attempts: ${outcome.maxAttempts}`, `revert: ${outcome.revertSummary}`],
  });
  return { outcome, summary };
}

// ── Terminate supervisor-owned runs ─────────────────────────────────────────────

async function terminateSupervisorOwnedRuns(projectPaths: ReturnType<typeof getProjectPaths>): Promise<void> {
  const activeRuns = await listActiveRuns(projectPaths);
  for (const run of activeRuns) {
    if (!run.pid || run.source === "console" || run.pid === process.pid) continue;
    try {
      await markRunStopRequested(run, "supervisor");
      process.kill(run.pid, "SIGTERM");
    } catch {
      // process already gone
    }
  }
}

// ── Options parsing ─────────────────────────────────────────────────────────────

function parseOptions(args: string[]): SuperviseOptions {
  const usage =
    "Usage: hive supervise [--interval <seconds>] [--max-parallel <count>] [--once|--detach]\n       hive supervise status\n       hive supervise stop\n       hive supervise logs";
  const first = args[0]?.trim().toLowerCase();

  if (first === "status" || first === "stop" || first === "logs") {
    if (args.length !== 1) throw new UsageError(usage);
    return {
      intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
      maxParallel: DEFAULT_MAX_PARALLEL,
      once: false, detach: false, child: false, managed: false, parentPid: null,
      action: first,
    };
  }

  let intervalSeconds = DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
  let maxParallel = DEFAULT_MAX_PARALLEL;
  let once = false;
  let detach = false;
  let child = false;
  let managed = false;
  let parentPid: number | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--interval") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new UsageError(usage);
      intervalSeconds = value;
      index += 1;
    } else if (arg === "--max-parallel") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new UsageError(usage);
      maxParallel = value;
      index += 1;
    } else if (arg === "--once") {
      once = true;
    } else if (arg === "--detach") {
      detach = true;
    } else if (arg === "--supervisor-child") {
      child = true;
    } else if (arg === "--managed") {
      managed = true;
    } else if (arg === "--parent-pid") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new UsageError(usage);
      parentPid = value;
      index += 1;
    } else {
      throw new UsageError(usage);
    }
  }

  if (once && detach) throw new UsageError("`hive supervise` cannot combine `--once` with `--detach`.");
  if (child && (once || detach)) throw new UsageError("Internal supervisor child mode cannot be combined with `--once` or `--detach`.");
  if (!child && (managed || parentPid !== null)) throw new UsageError("Supervisor parent flags are only valid in child mode.");

  return { intervalSeconds, maxParallel, once, detach, child, managed, parentPid, action: "run" };
}

// ── Core supervisor pass ────────────────────────────────────────────────────────
// Pure mechanics: recover zombies, dispatch workers, wake steward, verify results.
// No LLM calls. No triage. No work graphs. No goal waves.

let supervisorTickCount = 0;

async function runSupervisorPass(options: SuperviseOptions): Promise<string> {
  supervisorTickCount++;
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  // 1. Recover zombie runs
  const activeRuns = await listActiveRuns(projectPaths);
  const recoveredRuns = assessRecoveredRuns(activeRuns);

  if (recoveredRuns.length > 0) {
    await reconcileRecoveredRuns({ paths, activeProject, projectPaths, recovered: recoveredRuns });
  }

  // 2. Dispatch workers from open assignment messages
  const workerDispatch = await dispatchWorkerLaunchPass({
    hivePaths: paths,
    projectId: activeProject,
    maxParallel: options.maxParallel,
    source: "hive supervise",
    actor: "hive supervise",
    logActor: "hive supervise",
  });

  let workerSection = "No worker launches this pass.";
  if (workerDispatch.outcomes.length > 0) {
    workerSection = workerDispatch.outcomes
      .map((outcome) => formatLaunchSettledResult(outcome))
      .join("\n");
  }

  // 3. Verify completed workers
  const verificationResults: { agentId: string; summary: string }[] = [];
  for (const outcome of workerDispatch.outcomes) {
    if (outcome.result.status !== "fulfilled") continue;
    const msg = await findMessage(paths.msgDir, outcome.messageFilename, activeProject);
    if (!msg?.attributes.verify) continue;

    const scopeAttr = msg.attributes.scope?.trim();
    const scope = scopeAttr ? scopeAttr.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const result = await verifyCompletedWorker({
      paths, projectPaths, activeProject,
      agentId: outcome.agentId,
      sourceMessage: msg,
      scope,
    });
    if (result) verificationResults.push({ agentId: outcome.agentId, summary: result.summary });
  }

  // 4. Wake persistent steward if worker results landed
  let stewardSection = "No steward action this pass.";
  const persistentStewardActive = hasPersistentStewardSession(paths.home);
  const recentResults = await listRecentRunResults(projectPaths, 20);
  const recentRuns = await listRecentRuns(projectPaths, 10);
  const lastStewardRun = recentRuns.find((run) => run.agentId === "steward" && Boolean(run.ended)) ?? null;
  const resultsSinceLastSteward = recentResults.filter(
    (result) =>
      result.agentId !== "steward" &&
      result.agentId !== "console" &&
      endedAfter(result.ended, lastStewardRun?.ended ?? null),
  );

  if (persistentStewardActive && resultsSinceLastSteward.length > 0) {
    const agentIds = [...new Set(resultsSinceLastSteward.map((r) => r.agentId))].sort();
    const wakeMessage = [
      agentIds.length === 1
        ? `Your delegated worker ${agentIds[0]} has completed.`
        : `Your delegated workers ${formatNaturalList(agentIds)} have completed.`,
      "",
      "Review the new worker run results and report the answer to the human.",
    ].join("\n");

    const wakeResult = await requestPersistentStewardWake({
      paths,
      projectId: activeProject,
      message: wakeMessage,
    });
    stewardSection = `Persistent steward wake: ${wakeResult.status} — ${wakeResult.detail}`;
  } else if (persistentStewardActive) {
    stewardSection = "Persistent steward active, no new results to report.";
  } else {
    stewardSection = "No persistent steward session.";
  }

  // 5. Health pulse (periodic)
  const isPulseTick = supervisorTickCount % DEFAULT_PULSE_INTERVAL_TICKS === 0;
  let pulseSection = "";

  if (isPulseTick) {
    const openMessages = await listOpenProjectMessages(paths.msgDir, activeProject);
    const boardText = await Bun.file(projectPaths.board).text().catch(() => "");
    const freshActiveRuns = await listActiveRuns(projectPaths);
    const pulseSignals = assessPulse({
      activeRuns: freshActiveRuns,
      openMessages,
      boardText,
    });
    const workerRuns = freshActiveRuns.filter(
      (r) => r.agentId !== "steward" && r.source !== "console",
    );
    pulseSection = section("Health Pulse", formatPulse(pulseSignals, workerRuns.length));

    if (pulseSignals.length > 0) {
      await appendFeedEntry(paths, {
        project: activeProject,
        headline: formatPulse(pulseSignals, workerRuns.length).split("\n")[0]!,
        details: pulseSignals.map((s) => s.message),
      });
    }
  }

  const skippedSection =
    workerDispatch.skipped.length > 0
      ? workerDispatch.skipped.map((reason) => `- ${reason}`).join("\n")
      : "- none";

  return [
    `Project: ${activeProject}`,
    section("Recovered Runs", formatRecoveredRuns(recoveredRuns)),
    section("Steward", stewardSection),
    section("Worker Launches", workerSection),
    ...(verificationResults.length > 0 ? [section("Verification", formatVerificationResults(verificationResults))] : []),
    section("Skipped Assignments", skippedSection),
    ...(pulseSection ? [pulseSection] : []),
    section(
      "Supervisor",
      [
        `tick-interval: ${options.intervalSeconds}s`,
        `max-parallel: ${options.maxParallel}`,
        `tick: ${supervisorTickCount}${isPulseTick ? " (pulse)" : ""}`,
      ].join("\n"),
    ),
  ].join("\n\n");
}

// ── Command entry point ─────────────────────────────────────────────────────────

export async function superviseCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  if (options.action === "logs") {
    const state = await readDetachedSupervisorState(projectPaths);
    if (!state?.logPath) throw new UsageError("No detached supervisor log found.");
    const file = Bun.file(state.logPath);
    if (!(await file.exists())) return `Supervisor log: ${state.logPath}\n\n(empty)`;
    const content = await file.text();
    return `Supervisor log: ${state.logPath}\n\n${content.split("\n").slice(-50).join("\n")}`;
  }

  if (options.action === "status") {
    const state = await reconcileDetachedSupervisorState(projectPaths);
    return formatDetachedSupervisorState(state, activeProject);
  }

  if (options.action === "stop") {
    const state = await markDetachedSupervisorStopRequested(projectPaths, "human");
    if (!state || !state.pid) throw new UsageError("No detached supervisor is currently active.");
    process.kill(state.pid, "SIGTERM");
    await appendFeedEntry(paths, {
      project: activeProject,
      headline: "Detached supervisor stop requested",
      details: [`pid: ${state.pid}`, `state: ${state.path}`],
    });
    await appendLogEntry(projectPaths.log, "human → hive supervise stop", `Requested detached supervisor stop pid ${state.pid}`);
    return `Signaled detached supervisor pid ${state.pid}`;
  }

  if (options.detach) {
    const state = await startDetachedSupervisor({
      projectPaths,
      projectId: activeProject,
      intervalSeconds: options.intervalSeconds,
      maxParallel: options.maxParallel,
    });
    await appendFeedEntry(paths, {
      project: activeProject,
      headline: "Detached supervisor started",
      details: [`pid: ${state.pid ?? "unknown"}`, `interval: ${state.intervalSeconds}s`],
    });
    await appendLogEntry(
      projectPaths.log,
      "human → hive supervise --detach",
      `Started detached supervisor pid ${state.pid ?? "unknown"} interval ${state.intervalSeconds}s max-parallel ${state.maxParallel}`,
    );
    return [
      `Started detached supervisor for ${activeProject}`,
      `pid: ${state.pid ?? "unknown"}`,
      `interval: ${state.intervalSeconds}s`,
      `max-parallel: ${state.maxParallel}`,
      `state: ${state.path}`,
      `log: ${state.logPath}`,
    ].join("\n");
  }

  if (options.child) {
    const existingState = await reconcileDetachedSupervisorState(projectPaths);
    const startedAt = existingState?.startedAt ?? toIsoTimestamp();

    await writeDetachedSupervisorState(projectPaths, {
      projectId: activeProject,
      pid: process.pid,
      status: "active",
      mode: options.managed ? "managed" : "detached",
      intervalSeconds: options.intervalSeconds,
      maxParallel: options.maxParallel,
      startedAt,
      updatedAt: toIsoTimestamp(),
      lastPassAt: existingState?.lastPassAt ?? null,
      stoppedAt: null,
      stopRequestedAt: null,
      stopRequestedBy: null,
      logPath: join(projectPaths.supervisorDir, "detached.log"),
    });

    const stopChild = async (status: "stopped" | "exited") => {
      await terminateSupervisorOwnedRuns(projectPaths);
      await markDetachedSupervisorStopped(projectPaths, status);
      process.exit(status === "stopped" ? 0 : 1);
    };

    process.on("SIGTERM", () => { void stopChild("stopped"); });
    process.on("SIGINT", () => { void stopChild("stopped"); });
    process.on("uncaughtException", (error) => {
      console.error(error);
      void stopChild("exited");
    });

    for (;;) {
      if (options.parentPid && !isProcessAlive(options.parentPid)) {
        await stopChild("stopped");
      }

      try {
        const output = await runSupervisorPass(options);
        console.log(output);
        console.log("");
        await noteDetachedSupervisorPass(projectPaths);

        const sleepUntil = Date.now() + options.intervalSeconds * 1000;
        while (Date.now() < sleepUntil) {
          if (options.parentPid && !isProcessAlive(options.parentPid)) {
            await stopChild("stopped");
          }
          await Bun.sleep(250);
        }
      } catch (error) {
        console.error(error);
        await stopChild("exited");
      }
    }
  }

  if (options.once) {
    return runSupervisorPass(options);
  }

  for (;;) {
    const output = await runSupervisorPass(options);
    console.log(output);
    console.log("");
    await Bun.sleep(options.intervalSeconds * 1000);
  }
}
