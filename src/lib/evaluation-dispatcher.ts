import { basename } from "node:path";

import { OrientationCache } from "./orientation";
import type { WatcherEvents } from "./watcher";
import { evaluateSignal } from "./tactical-evaluator";
import type { ActiveContext, TacticalEvaluation, Signal } from "./tactical-evaluator";
import { interruptWorker } from "./interrupt-handler";

export type DispatcherConfig = {
  orientationCache: OrientationCache;
  evalLogPath: string;
  projectId: string;
  // Absolute path to the project's runs/active directory — used by interrupt handler
  projectRunsActiveDir: string;
  // Called when tactical evaluator says wake_strategic
  onStrategicTrigger?: (evaluation: TacticalEvaluation) => void;
  // Optional notification callback after interrupt handler runs.
  // workerId is the agent's ID string (e.g. craftsman-gpt53-codex-39d6), not a run ID.
  onInterruptRequest?: (workerId: string, evaluation: TacticalEvaluation) => void;
  // Function to get current active context (board digest, workers, etc.)
  getActiveContext: () => ActiveContext;
  // Best-effort refresh hook to run before evaluation.
  beforeEvaluate?: (signal: Signal) => Promise<void>;
};

async function evaluateAndRoute(
  signal: Signal,
  config: DispatcherConfig,
  callOriginal: () => void,
  patchOnComplete?: boolean,
): Promise<void> {
  if (config.beforeEvaluate) {
    try {
      await config.beforeEvaluate(signal);
    } catch (err) {
      console.warn(
        `[evaluation-dispatcher] pre-evaluation refresh failed, falling through: ${err instanceof Error ? err.message : String(err)}`,
      );
      callOriginal();
      return;
    }
  }

  const orientation = config.orientationCache.get();

  // No orientation yet — skip evaluation and pass through
  if (!orientation) {
    callOriginal();
    return;
  }

  let evaluation: TacticalEvaluation;

  try {
    evaluation = await evaluateSignal({
      signal,
      orientation: config.orientationCache.format(),
      context: config.getActiveContext(),
      evalLogPath: config.evalLogPath,
    });
  } catch (err) {
    console.warn(
      `[evaluation-dispatcher] evaluation error, falling through: ${err instanceof Error ? err.message : String(err)}`,
    );
    callOriginal();
    return;
  }

  const { action } = evaluation.routing;

  switch (action) {
    case "discard":
      // Drop the event entirely
      break;

    case "log":
      callOriginal();
      break;

    case "tactical":
      callOriginal();
      console.log(
        `[evaluation-dispatcher] tactical command queued: ${(evaluation.routing as { action: "tactical"; command: string }).command}`,
      );
      break;

    case "wake_strategic":
      callOriginal();
      config.onStrategicTrigger?.(evaluation);
      break;

    case "interrupt": {
      const workerId = (evaluation.routing as { action: "interrupt"; workerId: string }).workerId;
      // Interrupt supersedes the original handler — do NOT call it.
      // Call the interrupt handler directly, then notify via optional callback.
      void interruptWorker({
        runId: workerId,
        reason: evaluation.reasoning,
        evaluation,
        projectRunsActiveDir: config.projectRunsActiveDir,
      }).then((result) => {
        if (!result.ok) {
          console.warn(`[evaluation-dispatcher] interrupt failed for ${workerId}: ${result.reason}`);
        }
      });
      config.onInterruptRequest?.(workerId, evaluation);
      break;
    }
  }

  // Mechanical orientation patch after routing
  if (patchOnComplete) {
    config.orientationCache.patch({ updatedAt: new Date().toISOString() });
  }
}

type PendingEvaluation = {
  queueKey: string;
  signal: Signal;
  callbacks: Array<() => void>;
  patchOnComplete: boolean;
};

class EvaluationQueue {
  private readonly pending = new Map<string, PendingEvaluation>();
  private readonly order: string[] = [];
  private activeKey: string | null = null;
  private draining = false;

  constructor(private readonly config: DispatcherConfig) {}

  enqueue(
    queueKey: string,
    signal: Signal,
    callback: () => void,
    patchOnComplete: boolean,
  ): void {
    const existing = this.pending.get(queueKey);

    if (existing) {
      existing.signal = signal;
      existing.callbacks.push(callback);
      existing.patchOnComplete ||= patchOnComplete;
      return;
    }

    this.pending.set(queueKey, {
      queueKey,
      signal,
      callbacks: [callback],
      patchOnComplete,
    });

    if (this.activeKey !== queueKey && !this.order.includes(queueKey)) {
      this.order.push(queueKey);
    }

    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }

    this.draining = true;

    try {
      while (this.order.length > 0) {
        const queueKey = this.order.shift();

        if (!queueKey) {
          continue;
        }

        const pending = this.pending.get(queueKey);

        if (!pending) {
          continue;
        }

        this.pending.delete(queueKey);
        this.activeKey = queueKey;

        await evaluateAndRoute(
          pending.signal,
          this.config,
          () => {
            for (const callback of pending.callbacks) {
              try {
                callback();
              } catch (err) {
                console.warn(
                  `[evaluation-dispatcher] original handler failed for ${pending.queueKey}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          },
          pending.patchOnComplete,
        );
        this.activeKey = null;

        if (this.pending.has(queueKey) && !this.order.includes(queueKey)) {
          this.order.unshift(queueKey);
        }
      }
    } finally {
      this.activeKey = null;
      this.draining = false;

      if (this.order.length > 0) {
        void this.drain();
      }
    }
  }
}

/**
 * Wraps WatcherEvents with an evaluation pass inserted before each handler.
 * Returns new WatcherEvents that should be passed to createWatcher() instead of
 * the original events.
 *
 * Callbacks are sync (watcher requirement). Evaluation stays async and is
 * serialized through a small coalescing queue so watcher bursts do not fan out
 * into unbounded model calls.
 */
export function createEvaluatedWatcherEvents(
  original: WatcherEvents,
  config: DispatcherConfig,
): WatcherEvents {
  const evaluated: WatcherEvents = {};
  const queue = new EvaluationQueue(config);

  if (original.onAssignment) {
    const handler = original.onAssignment;
    evaluated.onAssignment = (msgPath: string) => {
      const signal: Signal = {
        type: "message",
        description: "new assignment message",
        payload: basename(msgPath),
      };
      queue.enqueue("assignment", signal, () => handler(msgPath), false);
    };
  }

  if (original.onRunChange) {
    const handler = original.onRunChange;
    evaluated.onRunChange = (runPath: string) => {
      const signal: Signal = {
        type: "run_change",
        description: "run state changed",
        payload: basename(runPath),
      };
      queue.enqueue("run_change", signal, () => handler(runPath), true);
    };
  }

  if (original.onBoardChange) {
    const handler = original.onBoardChange;
    evaluated.onBoardChange = () => {
      const signal: Signal = {
        type: "board_change",
        description: "board updated",
        payload: undefined,
      };
      queue.enqueue("board_change", signal, () => handler(), true);
    };
  }

  if (original.onFeedEntry) {
    const handler = original.onFeedEntry;
    evaluated.onFeedEntry = () => {
      const signal: Signal = {
        type: "feed_entry",
        description: "feed entry added",
        payload: undefined,
      };
      queue.enqueue("feed_entry", signal, () => handler(), false);
    };
  }

  if (original.onMessageChange) {
    const handler = original.onMessageChange;
    evaluated.onMessageChange = (msgPath: string) => {
      const signal: Signal = {
        type: "message",
        description: "message changed",
        payload: basename(msgPath),
      };
      queue.enqueue("message_change", signal, () => handler(msgPath), false);
    };
  }

  return evaluated;
}
