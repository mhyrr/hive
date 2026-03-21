import { parseBoard, minutesSince } from "./board";
import { HiveMessage } from "./messages";
import {
  extractProjectConfigValue,
  resolveAgentScopeRoots,
} from "./project";
import { RunRecord, RunResult } from "./runs";

export const DEFAULT_SUPERVISOR_INTERVAL_SECONDS = 120;
export const DEFAULT_STEWARD_REASSESS_SECONDS = 120;
export const DEFAULT_MAX_PARALLEL = 3;
export const DEFAULT_PULSE_INTERVAL_TICKS = 4;
export const DEFAULT_STALE_WORKER_MINUTES = 30;

export type StewardAssessment = {
  shouldLaunch: boolean;
  reasons: string[];
  lastStewardEnded: string | null;
};

export type WorkerLaunchCandidate = {
  agentId: string;
  message: HiveMessage;
  scope: string[] | null;
};

export type WorkerLaunchAssessment = {
  launches: WorkerLaunchCandidate[];
  skipped: string[];
};

export type RecoveredRun = {
  run: RunRecord;
  status: Extract<RunRecord["status"], "failed" | "cancelled">;
  reason: string;
};

function endedAfter(value: string, reference: string | null): boolean {
  if (!reference) {
    return true;
  }

  return new Date(value).getTime() > new Date(reference).getTime();
}

function normalizePathRoot(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasPathBoundaryPrefix(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  return right.startsWith(`${left}/`);
}

function formatScope(scope: string[] | null): string {
  return scope?.length ? scope.join(", ") : "*";
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : null;

    if (code === "EPERM") {
      return true;
    }

    if (code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

function getLaunchDefault(projectConfig: string): "auto" | "manual" {
  const value = extractProjectConfigValue(projectConfig, "launch-default")?.toLowerCase();

  return value === "manual" ? "manual" : "auto";
}

function getMessageLaunchMode(message: HiveMessage, projectConfig: string): "auto" | "manual" {
  const explicit = message.attributes.launch?.trim().toLowerCase();

  if (explicit === "manual") {
    return "manual";
  }

  if (explicit === "auto") {
    return "auto";
  }

  return getLaunchDefault(projectConfig);
}

function hasConsumedAssignment(
  sourceMessage: string,
  activeRuns: RunRecord[],
  historicalRuns: RunRecord[],
): boolean {
  return (
    activeRuns.some((run) => run.sourceMessage === sourceMessage) ||
    historicalRuns.some((run) => run.sourceMessage === sourceMessage)
  );
}

export function scopesConflict(left: string[] | null, right: string[] | null): boolean {
  if (!left || !right) {
    return true;
  }

  const normalizedLeft = left.map(normalizePathRoot);
  const normalizedRight = right.map(normalizePathRoot);

  return normalizedLeft.some((leftRoot) =>
    normalizedRight.some(
      (rightRoot) =>
        hasPathBoundaryPrefix(leftRoot, rightRoot) ||
        hasPathBoundaryPrefix(rightRoot, leftRoot),
    ),
  );
}

export function assessStewardLaunch(input: {
  boardText: string;
  openMessages: HiveMessage[];
  activeRuns: RunRecord[];
  recentRuns: RunRecord[];
  recentRunResults: RunResult[];
  reassessSeconds?: number;
}): StewardAssessment {
  const reasons: string[] = [];
  const board = parseBoard(input.boardText);
  const reassessSeconds = input.reassessSeconds ?? DEFAULT_STEWARD_REASSESS_SECONDS;
  const lastStewardRun =
    input.recentRuns.find((run) => run.agentId === "steward" && Boolean(run.ended)) ?? null;
  const lastStewardEnded = lastStewardRun?.ended ?? null;
  const messagesToOrchestrator = input.openMessages.filter(
    (message) => message.attributes.to === "steward",
  );
  const workerActiveRuns = input.activeRuns.filter(
    (run) => run.agentId !== "steward" && run.source !== "console",
  );
  const boardActiveAgents = board.agents.filter((agent) =>
    (agent.fields.status ?? "").toLowerCase().includes("active"),
  );
  const resultsSinceLastSteward = input.recentRunResults.filter(
    (result) => result.agentId !== "steward" && endedAfter(result.ended, lastStewardEnded),
  );

  if (!lastStewardEnded) {
    reasons.push("no prior steward run recorded");
  }

  if (messagesToOrchestrator.length > 0) {
    reasons.push(`${messagesToOrchestrator.length} open message(s) addressed to steward`);
  }

  if (resultsSinceLastSteward.length > 0) {
    reasons.push(
      `${resultsSinceLastSteward.length} worker run result(s) landed since the last steward pass`,
    );
  }

  if (boardActiveAgents.length > 0 && workerActiveRuns.length === 0) {
    reasons.push("the board still shows active worker state but no active worker runs exist");
  }

  if (lastStewardEnded) {
    const staleMinutes = minutesSince(lastStewardEnded);

    if (staleMinutes !== null && staleMinutes * 60 >= reassessSeconds) {
      reasons.push(
        `the steward reassessment interval elapsed (${staleMinutes} minute${staleMinutes === 1 ? "" : "s"})`,
      );
    }
  }

  return {
    shouldLaunch: reasons.length > 0,
    reasons,
    lastStewardEnded,
  };
}

export function selectWorkerLaunches(input: {
  projectConfig: string;
  plan: string;
  openMessages: HiveMessage[];
  activeRuns: RunRecord[];
  historicalRuns: RunRecord[];
  maxParallel: number;
}): WorkerLaunchAssessment {
  const launches: WorkerLaunchCandidate[] = [];
  const skipped: string[] = [];
  const activeWorkerRuns = input.activeRuns.filter(
    (run) => run.agentId !== "steward" && run.source !== "console",
  );
  const activeOrchestratorRun = input.activeRuns.find((run) => run.agentId === "steward");

  if (activeOrchestratorRun) {
    return {
      launches,
      skipped: [`steward is already active (${activeOrchestratorRun.runId})`],
    };
  }

  const availableSlots = Math.max(0, input.maxParallel - activeWorkerRuns.length);

  if (availableSlots === 0) {
    return {
      launches,
      skipped: [`parallel limit reached (${input.maxParallel})`],
    };
  }

  const reservedAgents = new Set(activeWorkerRuns.map((run) => run.agentId));
  const reservedScopes = [...activeWorkerRuns.map((run) => run.scope)];
  const assignments = input.openMessages
    .filter(
      (message) =>
        message.attributes.type === "assign" && message.attributes.to !== "steward",
    )
    .sort((left, right) => {
      const leftTs = left.attributes.ts ?? left.filename;
      const rightTs = right.attributes.ts ?? right.filename;

      return leftTs.localeCompare(rightTs);
    });

  for (const message of assignments) {
    if (launches.length >= availableSlots) {
      skipped.push(`parallel limit reached (${input.maxParallel})`);
      break;
    }

    const agentId = message.attributes.to?.trim();

    if (!agentId) {
      skipped.push(`${message.filename}: missing \`to:\` agent`);
      continue;
    }

    if (getMessageLaunchMode(message, input.projectConfig) !== "auto") {
      skipped.push(`${message.filename}: launch mode is manual`);
      continue;
    }

    if (reservedAgents.has(agentId)) {
      skipped.push(`${message.filename}: ${agentId} already has an active or scheduled run`);
      continue;
    }

    if (hasConsumedAssignment(message.filename, input.activeRuns, input.historicalRuns)) {
      skipped.push(`${message.filename}: assignment already consumed its current launch attempt`);
      continue;
    }

    const scope = resolveAgentScopeRoots({
      plan: input.plan,
      projectConfig: input.projectConfig,
      agentId,
      assignmentScope: message.attributes.scope ?? null,
    });

    if (reservedScopes.some((existingScope) => scopesConflict(existingScope, scope))) {
      skipped.push(
        `${message.filename}: scope ${formatScope(scope)} conflicts with an active or queued run`,
      );
      continue;
    }

    launches.push({ agentId, message, scope });
    reservedAgents.add(agentId);
    reservedScopes.push(scope);
  }

  return { launches, skipped };
}

export function assessRecoveredRuns(
  activeRuns: RunRecord[],
): RecoveredRun[] {
  const recovered: RecoveredRun[] = [];

  for (const run of activeRuns) {
    if (run.source === "console") {
      continue;
    }

    if (isProcessAlive(run.pid)) {
      continue;
    }

    const cancelled = Boolean(run.stopRequestedAt);
    const reason = cancelled
      ? `process for ${run.runId} is gone after a recorded stop request`
      : `process for ${run.runId} is no longer alive but the active run pointer remains`;

    recovered.push({
      run,
      status: cancelled ? "cancelled" : "failed",
      reason,
    });
  }

  return recovered;
}

export type PulseSignal = {
  level: "nominal" | "warning" | "urgent";
  message: string;
};

export function assessPulse(input: {
  activeRuns: RunRecord[];
  openMessages: HiveMessage[];
  boardText: string;
  staleWorkerMinutes?: number;
}): PulseSignal[] {
  const signals: PulseSignal[] = [];
  const staleThreshold = input.staleWorkerMinutes ?? DEFAULT_STALE_WORKER_MINUTES;
  const board = parseBoard(input.boardText);

  for (const run of input.activeRuns) {
    if (run.source === "console" || run.agentId === "steward") {
      continue;
    }

    const minutes = minutesSince(run.started);

    if (minutes !== null && minutes >= staleThreshold) {
      signals.push({
        level: minutes >= staleThreshold * 2 ? "urgent" : "warning",
        message: `${run.agentId} has been running for ${minutes}m (started ${run.started})`,
      });
    }
  }

  const unansweredNudges = input.openMessages.filter(
    (msg) => msg.attributes.type === "nudge" && msg.attributes.to === "steward",
  );

  for (const nudge of unansweredNudges) {
    const minutes = minutesSince(nudge.attributes.ts ?? "");

    if (minutes !== null && minutes > 10) {
      signals.push({
        level: minutes > 30 ? "urgent" : "warning",
        message: `human nudge unanswered for ${minutes}m`,
      });
    }
  }

  const openQuestions = input.openMessages.filter(
    (msg) => msg.attributes.type === "question" && msg.attributes.status !== "resolved",
  );

  if (openQuestions.length > 3) {
    signals.push({
      level: "warning",
      message: `${openQuestions.length} open questions in message queue`,
    });
  }

  const boardBlocked = board.agents.filter((agent) =>
    (agent.fields.status ?? "").toLowerCase().includes("blocked"),
  );

  for (const agent of boardBlocked) {
    const lastActive = agent.fields["last-active"];
    const minutes = lastActive ? minutesSince(lastActive) : null;

    signals.push({
      level: minutes !== null && minutes > 20 ? "urgent" : "warning",
      message: `${agent.id} is blocked on the board${minutes !== null ? ` (${minutes}m)` : ""}`,
    });
  }

  return signals;
}

export function formatPulse(signals: PulseSignal[], activeRunCount: number): string {
  if (signals.length === 0) {
    return `◆ Pulse: ${activeRunCount} agent${activeRunCount === 1 ? "" : "s"} active, no issues`;
  }

  const urgent = signals.filter((s) => s.level === "urgent");
  const warnings = signals.filter((s) => s.level === "warning");
  const parts: string[] = [];

  if (urgent.length > 0) {
    parts.push(`${urgent.length} urgent`);
  }

  if (warnings.length > 0) {
    parts.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
  }

  const details = signals.map((s) => {
    const icon = s.level === "urgent" ? "⚠" : "▸";
    return `  ${icon} ${s.message}`;
  });

  return [`◆ Pulse: ${parts.join(", ")}`, ...details].join("\n");
}
