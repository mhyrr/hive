import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export type WatcherEvent = {
  type: "feed" | "board-changed" | "message-changed" | "run-changed";
  ts: string;
  project: string;
  data?: Record<string, unknown>;
};

type WatcherPaths = {
  feed: string;
  msgDir: string;
  boardPath: string;
  runsActiveDir: string;
};

type BroadcastFn = (event: WatcherEvent) => void;

type WatcherHooks = {
  onMessageChanged?: (path: string) => void;
};

const DEBOUNCE_MS = 200;

function debounced(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function startWatcher(
  paths: WatcherPaths,
  broadcast: BroadcastFn,
  hooks: WatcherHooks = {},
): () => void {
  const watchers: FSWatcher[] = [];

  // Watch feed.md for changes
  const tryWatchFile = (
    path: string,
    eventType: WatcherEvent["type"],
  ) => {
    if (!path) return;

    pathExists(path).then((exists) => {
      if (!exists) return;

      try {
        const debouncedBroadcast = debounced(() => {
          broadcast({
            type: eventType,
            ts: new Date().toISOString(),
            project: "global",
          });
        }, DEBOUNCE_MS);

        const watcher = watch(path, () => {
          debouncedBroadcast();
        });
        watchers.push(watcher);
      } catch {
        // Path may not exist yet — that's fine
      }
    }).catch(() => {
      // ignore
    });
  };

  // Watch a directory recursively
  const tryWatchDir = (
    dirPath: string,
    eventType: WatcherEvent["type"],
  ) => {
    if (!dirPath) return;

    pathExists(dirPath).then((exists) => {
      if (!exists) return;

      try {
        const debouncedBroadcast = debounced(() => {
          broadcast({
            type: eventType,
            ts: new Date().toISOString(),
            project: "global",
          });
        }, DEBOUNCE_MS);

        const watcher = watch(dirPath, { recursive: true }, (_event, filename) => {
          if (
            eventType === "message-changed" &&
            hooks.onMessageChanged &&
            typeof filename === "string" &&
            filename.endsWith(".md")
          ) {
            hooks.onMessageChanged(join(dirPath, filename));
          }

          debouncedBroadcast();
        });
        watchers.push(watcher);
      } catch {
        // Directory may not exist yet — that's fine
      }
    }).catch(() => {
      // ignore
    });
  };

  tryWatchFile(paths.feed, "feed");
  tryWatchDir(paths.msgDir, "message-changed");
  tryWatchFile(paths.boardPath, "board-changed");
  tryWatchDir(paths.runsActiveDir, "run-changed");

  // Return cleanup function
  return () => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    watchers.length = 0;
  };
}
