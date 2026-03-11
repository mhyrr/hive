import { parseBoard, minutesSince } from "./board";
import { HiveMessage } from "./messages";
import {
  extractProjectConfigValue,
  resolveAgentScopeRoots,
} from "./project";
import { RunRecord, RunResult } from "./runs";

export const DEFAULT_SUPERVISOR_INTERVAL_SECONDS = 30;
export const DEFAULT_STEWARD_REASSESS_SECONDS = 120;
export const DEFAULT_MAX_PARALLEL = 3;

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
    input.recentRuns.find((run) => run.agentId === "orchestrator" && Boolean(run.ended)) ?? null;
  const lastStewardEnded = lastStewardRun?.ended ?? null;
  const messagesToOrchestrator = input.openMessages.filter(
    (message) => message.attributes.to === "orchestrator",
  );
  const workerActiveRuns = input.activeRuns.filter(
    (run) => run.agentId !== "orchestrator" && run.source !== "console",
  );
  const boardActiveAgents = board.agents.filter((agent) =>
    (agent.fields.status ?? "").toLowerCase().includes("active"),
  );
  const resultsSinceLastSteward = input.recentRunResults.filter(
    (result) => result.agentId !== "orchestrator" && endedAfter(result.ended, lastStewardEnded),
  );

  if (!lastStewardEnded) {
    reasons.push("no prior steward run recorded");
  }

  if (messagesToOrchestrator.length > 0) {
    reasons.push(`${messagesToOrchestrator.length} open message(s) addressed to orchestrator`);
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
    (run) => run.agentId !== "orchestrator" && run.source !== "console",
  );
  const activeOrchestratorRun = input.activeRuns.find((run) => run.agentId === "orchestrator");

  if (activeOrchestratorRun) {
    return {
      launches,
      skipped: [`orchestrator is already active (${activeOrchestratorRun.runId})`],
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
        message.attributes.type === "assign" && message.attributes.to !== "orchestrator",
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
