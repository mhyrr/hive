import { createProjectOodaWatcher } from "../lib/ooda-watcher";
import { getProjectPaths, type HivePaths } from "../lib/paths";
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

export function startGatewayWatcher(
  hivePaths: HivePaths,
  broadcast: BroadcastFn,
  hooks: GatewayWatcherHooks = {},
  projectId: string | null = null,
): () => void {
  const projectPaths = projectId ? getProjectPaths(hivePaths, projectId) : null;

  const rawEvents: WatcherEvents = {
    onFeedEntry: () => emitBroadcast(broadcast, "feed"),
    onBoardChange: () => {
      emitBroadcast(broadcast, "board-changed");
    },
    onRunChange: (runPath) => {
      emitBroadcast(broadcast, "run-changed");
      if (hooks.onRunChanged && runPath) {
        hooks.onRunChanged(runPath);
      }
    },
    onMessageChange: () => {
      emitBroadcast(broadcast, "message-changed");
    },
  };

  // The core watcher handles assignment-detection filtering (type: assign,
  // status: open, launch != manual, to != steward), so the gateway hook
  // receives only qualifying message paths.
  if (hooks.onAssignment) {
    rawEvents.onAssignment = (msgPath) => {
      hooks.onAssignment?.(msgPath);
    };
  }

  let events = rawEvents;

  if (projectId && projectPaths) {
    const oodaWatcher = createProjectOodaWatcher({
      hivePaths,
      projectId,
      projectPaths,
      baseEvents: rawEvents,
      onStrategicTrigger: (evaluation) => {
        console.log("[ooda] strategic trigger:", evaluation.routing);
      },
      onInterruptRequest: (workerId, evaluation) => {
        // Notification only — dispatcher already called interruptWorker before this callback.
        console.log(
          `[gateway-watcher] interrupt dispatched for ${workerId}: ${evaluation.reasoning}`,
        );
      },
    });

    events = oodaWatcher.events;
    void oodaWatcher.warm().catch(() => {
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
