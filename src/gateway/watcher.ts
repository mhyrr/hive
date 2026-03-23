import { createEvaluatedWatcherEvents, type DispatcherConfig } from "../lib/evaluation-dispatcher";
import { OrientationCache } from "../lib/orientation";
import { getProjectPaths, type HivePaths } from "../lib/paths";
import { refreshProjectRuntimeState, type ProjectRuntimeState } from "../lib/state";
import type { ActiveContext } from "../lib/tactical-evaluator";
import { createWatcher, type HiveWatcher, type WatcherEvents } from "../lib/watcher";

export type WatcherEvent = {
  type: "feed" | "board-changed" | "message-changed" | "run-changed";
  ts: string;
  project: string;
  data?: Record<string, unknown>;
};

type BroadcastFn = (event: WatcherEvent) => void;

export type GatewayWatcherHooks = {
  onAssignment?: (msgPath: string) => void;
  onRunChanged?: (runActiveDirPath: string) => void;
};

function emitBroadcast(broadcast: BroadcastFn, type: WatcherEvent["type"]): void {
  broadcast({
    type,
    ts: new Date().toISOString(),
    project: "global",
  });
}

function buildActiveContext(
  projectId: string,
  runtimeState: ProjectRuntimeState | null,
): ActiveContext {
  const activeRunIds = runtimeState?.activeRuns.map((run) => run.runId) ?? [];

  return {
    goalTitle: projectId,
    workerCount: activeRunIds.length,
    workerSummaries: activeRunIds.length > 0 ? activeRunIds.join(", ") : "none",
    boardDigest: runtimeState?.boardSummary.digest ?? "(board digest unavailable)",
    lastStrategicEval: runtimeState?.revision.updatedAt ?? "never",
  };
}

export function startGatewayWatcher(
  hivePaths: HivePaths,
  broadcast: BroadcastFn,
  hooks: GatewayWatcherHooks = {},
  projectId: string | null = null,
): () => void {
  const orientationCache = new OrientationCache();
  const projectPaths = projectId ? getProjectPaths(hivePaths, projectId) : null;
  let runtimeState: ProjectRuntimeState | null = null;

  const refreshEvaluationState = async (): Promise<void> => {
    if (!projectId || !projectPaths) {
      return;
    }

    const nextState = await refreshProjectRuntimeState({
      hivePaths,
      projectId,
      projectPaths,
    });

    runtimeState = nextState;

    if (!orientationCache.get() || orientationCache.isStale(10)) {
      const activeRunIds = nextState.activeRuns.map((run) => run.runId);
      await orientationCache.regenerate({
        goal: projectId,
        board: nextState.boardSummary.digest,
        evidence:
          nextState.delta.changes.map((change) => change.summary).slice(0, 6).join(" | ") || "none",
        workers: activeRunIds.join(", ") || "none",
      });
    }
  };

  const rawEvents: WatcherEvents = {
    onFeedEntry: () => emitBroadcast(broadcast, "feed"),
    onBoardChange: () => {
      emitBroadcast(broadcast, "board-changed");
      void refreshEvaluationState().catch(() => {
        // Best-effort refresh; stale context falls back to last known state.
      });
    },
    onRunChange: (runPath) => {
      emitBroadcast(broadcast, "run-changed");
      if (hooks.onRunChanged && runPath) {
        hooks.onRunChanged(runPath);
      }
      void refreshEvaluationState().catch(() => {
        // Best-effort refresh; stale context falls back to last known state.
      });
    },
    onMessageChange: () => {
      emitBroadcast(broadcast, "message-changed");
      void refreshEvaluationState().catch(() => {
        // Best-effort refresh; stale context falls back to last known state.
      });
    },
  };

  // The core watcher handles assignment-detection filtering (type: assign,
  // status: open, launch != manual, to != steward), so the gateway hook
  // receives only qualifying message paths.
  if (hooks.onAssignment) {
    rawEvents.onAssignment = (msgPath) => {
      hooks.onAssignment?.(msgPath);
      void refreshEvaluationState().catch(() => {
        // Best-effort refresh; stale context falls back to last known state.
      });
    };
  }

  let events = rawEvents;

  if (projectId && projectPaths) {
    const dispatcherConfig: DispatcherConfig = {
      orientationCache,
      evalLogPath: projectPaths.evalLog,
      projectId,
      projectRunsActiveDir: projectPaths.runsActiveDir,
      onStrategicTrigger: (evaluation) => {
        console.log("[ooda] strategic trigger:", evaluation.routing);
      },
      onInterruptRequest: (workerId, evaluation) => {
        // Notification only — dispatcher already called interruptWorker before this callback.
        console.log(
          `[gateway-watcher] interrupt dispatched for ${workerId}: ${evaluation.reasoning}`,
        );
      },
      getActiveContext: () => buildActiveContext(projectId, runtimeState),
    };

    events = createEvaluatedWatcherEvents(rawEvents, dispatcherConfig);
    void refreshEvaluationState().catch(() => {
      // Best-effort warmup; dispatcher falls through while orientation is absent.
    });
  }

  const watcher: HiveWatcher = createWatcher(hivePaths, events);
  watcher.start();

  return () => watcher.stop();
}

// Keep backward-compatible export name so existing call sites still compile
// during the transition.
export const startWatcher = startGatewayWatcher;
