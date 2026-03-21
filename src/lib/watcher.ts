import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { readMessageFile } from "./messages";
import {
  getHivePaths,
  getProjectPaths,
  listProjects,
  type HivePaths,
} from "./paths";

export type WatcherEvents = {
  onAssignment?: (msgPath: string) => void;
  onRunChange?: (runPath: string) => void;
  onBoardChange?: () => void;
  onFeedEntry?: () => void;
  onMessageChange?: (msgPath: string) => void;
};

export type HiveWatcher = {
  start(): void;
  stop(): void;
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

function tryWatchFile(
  path: string,
  watchers: FSWatcher[],
  onEvent: () => void,
): void {
  if (!path) return;

  pathExists(path)
    .then((exists) => {
      if (!exists) return;

      try {
        const debouncedEvent = debounced(onEvent, DEBOUNCE_MS);
        const watcher = watch(path, () => {
          debouncedEvent();
        });
        watchers.push(watcher);
      } catch {
        // Path may not exist yet
      }
    })
    .catch(() => {
      // ignore
    });
}

function tryWatchDir(
  dirPath: string,
  watchers: FSWatcher[],
  onEvent: (filename: string | null) => void,
): void {
  if (!dirPath) return;

  pathExists(dirPath)
    .then((exists) => {
      if (!exists) return;

      try {
        const watcher = watch(
          dirPath,
          { recursive: true },
          (_event, filename) => {
            onEvent(typeof filename === "string" ? filename : null);
          },
        );
        watchers.push(watcher);
      } catch {
        // Directory may not exist yet
      }
    })
    .catch(() => {
      // ignore
    });
}

function closeWatchers(watchers: FSWatcher[]): void {
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  watchers.length = 0;
}

async function isNewAssignment(msgPath: string): Promise<boolean> {
  const message = await readMessageFile(msgPath);

  if (!message) {
    return false;
  }

  if (message.attributes.type !== "assign") {
    return false;
  }

  if ((message.attributes.status ?? "open") !== "open") {
    return false;
  }

  if ((message.attributes.launch ?? "").trim().toLowerCase() === "manual") {
    return false;
  }

  // Assignments to steward are processed internally, not auto-launched.
  if (message.attributes.to === "steward") {
    return false;
  }

  return true;
}

export function createWatcher(
  hivePaths: HivePaths,
  events: WatcherEvents,
): HiveWatcher {
  const watchers: FSWatcher[] = [];
  let started = false;

  function start(): void {
    if (started) return;
    started = true;

    // Watch feed.md
    if (events.onFeedEntry) {
      const handler = events.onFeedEntry;
      tryWatchFile(hivePaths.feed, watchers, () => {
        handler();
      });
    }

    // Watch msg/ directory
    if (events.onMessageChange || events.onAssignment) {
      const debouncedMessageChange = events.onMessageChange
        ? debounced(() => events.onMessageChange!(hivePaths.msgDir), DEBOUNCE_MS)
        : null;

      tryWatchDir(hivePaths.msgDir, watchers, (filename) => {
        if (filename && filename.endsWith(".md")) {
          const fullPath = join(hivePaths.msgDir, filename);

          if (events.onMessageChange) {
            events.onMessageChange(fullPath);
          }

          if (events.onAssignment) {
            const handler = events.onAssignment;
            isNewAssignment(fullPath)
              .then((isAssign) => {
                if (isAssign) {
                  handler(fullPath);
                }
              })
              .catch(() => {
                // File may still be mid-write; next watcher event will retry.
              });
          }
        } else if (debouncedMessageChange) {
          // Non-.md change in the msg directory; still signal to listeners.
          debouncedMessageChange();
        }
      });
    }

    // Watch per-project paths (board, runs/active)
    void watchProjectPaths();
  }

  async function watchProjectPaths(): Promise<void> {
    if (!events.onBoardChange && !events.onRunChange) {
      return;
    }

    let projectIds: string[];

    try {
      projectIds = await listProjects(hivePaths);
    } catch {
      return;
    }

    for (const projectId of projectIds) {
      const projectPaths = getProjectPaths(hivePaths, projectId);

      if (events.onBoardChange) {
        const handler = events.onBoardChange;
        tryWatchFile(projectPaths.board, watchers, () => {
          handler();
        });
      }

      if (events.onRunChange) {
        const handler = events.onRunChange;
        const debouncedRunChange = debounced(() => {
          handler(projectPaths.runsActiveDir);
        }, DEBOUNCE_MS);

        tryWatchDir(
          projectPaths.runsActiveDir,
          watchers,
          (filename) => {
            if (filename && filename.endsWith(".md")) {
              handler(join(projectPaths.runsActiveDir, filename));
            } else {
              debouncedRunChange();
            }
          },
        );
      }
    }
  }

  function stop(): void {
    started = false;
    closeWatchers(watchers);
  }

  return { start, stop };
}

/**
 * Convenience: create a watcher from just a projectId, resolving paths
 * automatically from the default hive home.
 */
export function createProjectWatcher(
  projectId: string,
  events: WatcherEvents,
): HiveWatcher {
  const hivePaths = getHivePaths();
  return createWatcher(hivePaths, events);
}
