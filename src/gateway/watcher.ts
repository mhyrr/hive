import { type HivePaths } from "../lib/paths";
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
): () => void {
  const events: WatcherEvents = {
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
    events.onAssignment = (msgPath) => {
      hooks.onAssignment?.(msgPath);
    };
  }

  const watcher: HiveWatcher = createWatcher(hivePaths, events);
  watcher.start();

  return () => watcher.stop();
}

// Keep backward-compatible export name so existing call sites still compile
// during the transition.
export const startWatcher = startGatewayWatcher;
