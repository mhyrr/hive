import { UsageError } from "../lib/errors";
import { reconcileGatewayState } from "../lib/gateway-state";
import { createProjectOodaWatcher } from "../lib/ooda-watcher";
import { ensureHiveScaffold, getActiveProject, getProjectPaths } from "../lib/paths";
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

  const gatewayState = await reconcileGatewayState(paths.home);

  if (gatewayState?.status === "active" && gatewayState.supervisorProject === activeProject) {
    throw new UsageError(
      `Gateway is already running the OODA loop for project '${activeProject}'. Stop \`hive gateway\` before starting \`hive think\`.`,
    );
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const baseEvents: WatcherEvents = {
    onRunChange: () => {},
    onBoardChange: () => {},
    onAssignment: (msgPath) => {
      console.log(`[think] assignment arrived: ${msgPath}`);
    },
    onMessageChange: () => {},
    onFeedEntry: () => {},
  };

  const oodaWatcher = createProjectOodaWatcher({
    hivePaths: paths,
    projectId: activeProject,
    projectPaths,
    baseEvents,
    onStrategicTrigger: (evaluation) => {
      // Step 6: strategic loop wiring goes here.
      // For now, log the trigger so it appears in the terminal and eval log.
      console.log(
        `[think] strategic trigger — ${evaluation.classification} ${evaluation.urgency}: ${evaluation.reasoning.slice(0, 100)}`,
      );
    },
  });

  await oodaWatcher.warm();

  const watcher = createWatcher(paths, oodaWatcher.events);
  watcher.start();

  console.log(`[think] OODA tactical loop active — project: ${activeProject}`);
  console.log(`[think] eval log: ${projectPaths.evalLog}`);
  console.log("[think] watching for signals. Ctrl-C to stop.");

  // Keep the process alive — the watcher holds the event loop open.
  await new Promise<never>(() => {});
}
