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
};

async function evaluateAndRoute(
  signal: Signal,
  config: DispatcherConfig,
  callOriginal: () => void,
  patchOnComplete?: boolean,
): Promise<void> {
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

/**
 * Wraps WatcherEvents with an evaluation pass inserted before each handler.
 * Returns new WatcherEvents that should be passed to createWatcher() instead of
 * the original events.
 *
 * Callbacks are sync (watcher requirement). Evaluation is async; we use
 * fire-and-forget so the watcher is never blocked.
 */
export function createEvaluatedWatcherEvents(
  original: WatcherEvents,
  config: DispatcherConfig,
): WatcherEvents {
  const evaluated: WatcherEvents = {};

  if (original.onAssignment) {
    const handler = original.onAssignment;
    evaluated.onAssignment = (msgPath: string) => {
      const signal: Signal = {
        type: "message",
        description: "new assignment message",
        payload: basename(msgPath),
      };
      void evaluateAndRoute(signal, config, () => handler(msgPath), false);
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
      void evaluateAndRoute(signal, config, () => handler(runPath), true);
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
      void evaluateAndRoute(signal, config, () => handler(), true);
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
      void evaluateAndRoute(signal, config, () => handler(), false);
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
      void evaluateAndRoute(signal, config, () => handler(msgPath), false);
    };
  }

  return evaluated;
}
