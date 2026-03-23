import { readFile } from "node:fs/promises";

import { UsageError } from "../lib/errors";
import { digestBoard, digestRuns } from "../lib/digest";
import {
  createEvaluatedWatcherEvents,
  type DispatcherConfig,
} from "../lib/evaluation-dispatcher";
import { OrientationCache } from "../lib/orientation";
import { ensureHiveScaffold, getActiveProject, getProjectPaths } from "../lib/paths";
import { listActiveRuns } from "../lib/runs";
import type { ActiveContext } from "../lib/tactical-evaluator";
import { createWatcher, type WatcherEvents } from "../lib/watcher";

/**
 * `hive think` — starts the OODA tactical evaluation loop for the active project.
 *
 * The tactical loop watches for filesystem signals (watcher events), classifies
 * each via a Haiku evaluation pass, and routes them: discard noise, log updates,
 * trigger strategic reasoning on significant events, or interrupt workers that
 * have been made moot by new evidence.
 *
 * The full strategic loop (ORIENT→INTEGRATE) is Step 6 and will be wired in here
 * via the onStrategicTrigger callback when implemented.
 */
export async function thinkCommand(_args: string[]): Promise<never> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const orientationCache = new OrientationCache();

  // Context snapshot — rebuilt asynchronously on watcher events.
  // The dispatcher's getActiveContext is synchronous; we cache and refresh behind it.
  let cachedContext: ActiveContext = {
    goalTitle: "none",
    workerCount: 0,
    workerSummaries: "none",
    boardDigest: "",
    lastStrategicEval: "none",
  };

  async function refreshContext(): Promise<void> {
    const [boardText, activeRuns] = await Promise.all([
      readFile(projectPaths.board, "utf-8").catch(() => ""),
      listActiveRuns(projectPaths),
    ]);

    cachedContext = {
      goalTitle: "active investigation",
      workerCount: activeRuns.length,
      workerSummaries: digestRuns(activeRuns) || "none",
      boardDigest: digestBoard(boardText),
      lastStrategicEval: "none",
    };

    // Mechanical orientation patch when context refreshes
    if (orientationCache.get()) {
      orientationCache.patch({
        workers:
          activeRuns.length === 0
            ? "none"
            : activeRuns.map((r) => `${r.agentId} (${r.runId})`).join(", "),
      });
    }
  }

  // Prime the context cache before the loop starts
  await refreshContext();

  const dispatcherConfig: DispatcherConfig = {
    orientationCache,
    evalLogPath: projectPaths.evalLog,
    projectId: activeProject,
    projectRunsActiveDir: projectPaths.runsActiveDir,
    onStrategicTrigger: (evaluation) => {
      // Step 6: strategic loop wiring goes here.
      // For now, log the trigger so it appears in the terminal and eval log.
      console.log(
        `[think] strategic trigger — ${evaluation.classification} ${evaluation.urgency}: ${evaluation.reasoning.slice(0, 100)}`,
      );
    },
    getActiveContext: () => cachedContext,
  };

  const baseEvents: WatcherEvents = {
    onRunChange: () => {
      void refreshContext();
    },
    onBoardChange: () => {
      void refreshContext();
    },
    onAssignment: (msgPath) => {
      console.log(`[think] assignment arrived: ${msgPath}`);
      void refreshContext();
    },
    onMessageChange: () => {
      void refreshContext();
    },
    onFeedEntry: () => {
      // Feed entries are low-signal for the tactical loop; refresh context quietly.
      void refreshContext();
    },
  };

  const evaluatedEvents = createEvaluatedWatcherEvents(baseEvents, dispatcherConfig);
  const watcher = createWatcher(paths, evaluatedEvents);
  watcher.start();

  console.log(`[think] OODA tactical loop active — project: ${activeProject}`);
  console.log(`[think] eval log: ${projectPaths.evalLog}`);
  console.log("[think] watching for signals. Ctrl-C to stop.");

  // Keep the process alive — the watcher holds the event loop open.
  await new Promise<never>(() => {});
}
