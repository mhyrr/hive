import {
  createEvaluatedWatcherEvents,
  type DispatcherConfig,
} from "./evaluation-dispatcher";
import { OrientationCache } from "./orientation";
import {
  getProjectPaths,
  type HivePaths,
  type ProjectPaths,
} from "./paths";
import {
  refreshProjectRuntimeState,
  type ProjectRuntimeState,
} from "./state";
import type {
  ActiveContext,
  TacticalEvaluation,
} from "./tactical-evaluator";
import type { WatcherEvents } from "./watcher";

export type ProjectOodaWatcherConfig = {
  hivePaths: HivePaths;
  projectId: string;
  projectPaths?: ProjectPaths;
  baseEvents: WatcherEvents;
  onStrategicTrigger?: (evaluation: TacticalEvaluation) => void;
  onInterruptRequest?: (workerId: string, evaluation: TacticalEvaluation) => void;
  orientationStaleMinutes?: number;
};

export type ProjectOodaWatcherHandle = {
  events: WatcherEvents;
  orientationCache: OrientationCache;
  refreshState: () => Promise<ProjectRuntimeState>;
  warm: () => Promise<void>;
  getRuntimeState: () => ProjectRuntimeState | null;
};

export function buildProjectActiveContext(
  projectId: string,
  runtimeState: ProjectRuntimeState | null,
): ActiveContext {
  const activeRuns = runtimeState?.activeRuns ?? [];

  return {
    goalTitle: projectId,
    workerCount: activeRuns.length,
    workerSummaries:
      activeRuns.length === 0
        ? "none"
        : activeRuns.map((run) => `${run.agentId} (${run.runId})`).join(", "),
    boardDigest: runtimeState?.boardSummary.digest ?? "(board digest unavailable)",
    lastStrategicEval: runtimeState?.revision.updatedAt ?? "never",
  };
}

export function createProjectOodaWatcher(
  input: ProjectOodaWatcherConfig,
): ProjectOodaWatcherHandle {
  const projectPaths =
    input.projectPaths ?? getProjectPaths(input.hivePaths, input.projectId);
  const orientationCache = new OrientationCache();
  const staleThresholdMinutes = input.orientationStaleMinutes ?? 10;
  let runtimeState: ProjectRuntimeState | null = null;
  let refreshInFlight: Promise<ProjectRuntimeState> | null = null;

  async function refreshState(): Promise<ProjectRuntimeState> {
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      const nextState = await refreshProjectRuntimeState({
        hivePaths: input.hivePaths,
        projectId: input.projectId,
        projectPaths,
      });

      runtimeState = nextState;

      if (!orientationCache.get() || orientationCache.isStale(staleThresholdMinutes)) {
        await orientationCache.regenerate({
          goal: input.projectId,
          board: nextState.boardSummary.digest,
          evidence:
            nextState.delta.changes
              .map((change) => change.summary)
              .slice(0, 6)
              .join(" | ") || "none",
          workers:
            nextState.activeRuns.length === 0
              ? "none"
              : nextState.activeRuns.map((run) => run.runId).join(", "),
        });
      }

      return nextState;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  const dispatcherConfig: DispatcherConfig = {
    orientationCache,
    evalLogPath: projectPaths.evalLog,
    projectId: input.projectId,
    projectRunsActiveDir: projectPaths.runsActiveDir,
    onStrategicTrigger: input.onStrategicTrigger,
    onInterruptRequest: input.onInterruptRequest,
    getActiveContext: () => buildProjectActiveContext(input.projectId, runtimeState),
    beforeEvaluate: async () => {
      await refreshState();
    },
  };

  return {
    events: createEvaluatedWatcherEvents(input.baseEvents, dispatcherConfig),
    orientationCache,
    refreshState,
    warm: async () => {
      await refreshState();
    },
    getRuntimeState: () => runtimeState,
  };
}
