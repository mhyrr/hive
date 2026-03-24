import { UsageError } from "../lib/errors";
import { reconcileGatewayState } from "../lib/gateway-state";
import { createMessage } from "../lib/messages";
import { createProjectOodaWatcher } from "../lib/ooda-watcher";
import { ensureHiveScaffold, getActiveProject, getProjectPaths } from "../lib/paths";
import { runStrategicPass, type StrategicLoopConfig } from "../lib/strategic-loop";
import { createWatcher, type WatcherEvents } from "../lib/watcher";

/**
 * `hive think` — starts the OODA tactical evaluation loop for the active project.
 *
 * The tactical loop watches for filesystem signals (watcher events), classifies
 * each via a Haiku evaluation pass, and routes them: discard noise, log updates,
 * trigger strategic reasoning on significant events, or interrupt workers that
 * have been made moot by new evidence.
 *
 * Strategic triggers invoke runStrategicPass (orient→decide→act). A 60s cooldown
 * prevents burst re-evaluation. Stuck detection escalates if >= 3 triggers fire
 * in 5 minutes without a dispatch decision.
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

  const strategicConfig: StrategicLoopConfig = {
    hivePaths: paths,
    projectId: activeProject,
    projectPaths,
  };

  // Cooldown: suppress rapid re-triggering of the strategic pass
  let lastStrategicPassAt = 0;
  const STRATEGIC_COOLDOWN_MS = 60_000;

  // Stuck detection: track recent triggers and their outcomes within a 5-minute window
  const STUCK_WINDOW_MS = 5 * 60 * 1000;
  const STUCK_THRESHOLD = 3;

  type TriggerRecord = { ts: number; hadDispatch: boolean };
  const recentTriggers: TriggerRecord[] = [];

  async function checkAndEscalateIfStuck(): Promise<void> {
    const now = Date.now();
    const windowStart = now - STUCK_WINDOW_MS;

    // Prune entries outside the window
    while (recentTriggers.length > 0 && recentTriggers[0].ts < windowStart) {
      recentTriggers.shift();
    }

    const noDispatchCount = recentTriggers.filter((r) => !r.hadDispatch).length;

    if (noDispatchCount >= STUCK_THRESHOLD) {
      console.log(
        `[think] stuck detected — ${noDispatchCount} strategic triggers without dispatch in 5m, escalating`,
      );

      try {
        await createMessage(paths.msgDir, {
          from: "alpha",
          to: "steward",
          type: "nudge",
          project: activeProject,
          body: `# Strategic Loop Stuck

${noDispatchCount} strategic triggers fired in the last 5 minutes without any dispatch decision. The loop may be cycling without making progress.

Recent trigger count in window: ${recentTriggers.length}
Non-dispatch triggers: ${noDispatchCount}

Please review the board and strategic-eval.log.`,
        });
      } catch (err) {
        console.warn(
          `[think] failed to write stuck escalation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Clear records after escalation to avoid repeat spam
      recentTriggers.length = 0;
    }
  }

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
      const now = Date.now();

      if (now - lastStrategicPassAt < STRATEGIC_COOLDOWN_MS) {
        console.log("[think] strategic trigger suppressed (cooldown)");
        return;
      }

      lastStrategicPassAt = now;

      // Fire-and-forget async pass — keep sync callback signature
      void (async () => {
        try {
          const decision = await runStrategicPass(strategicConfig, evaluation);
          console.log(
            `[think] strategic decision: ${decision.action} — ${decision.reasoning.slice(0, 80)}`,
          );

          const hadDispatch = decision.action === "dispatch";
          recentTriggers.push({ ts: now, hadDispatch });

          await checkAndEscalateIfStuck();
        } catch (err) {
          console.warn(
            `[think] strategic pass error: ${err instanceof Error ? err.message : String(err)}`,
          );
          recentTriggers.push({ ts: now, hadDispatch: false });
          await checkAndEscalateIfStuck();
        }
      })();
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
