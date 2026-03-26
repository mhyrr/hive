/**
 * Worker launch dispatch — simplified.
 *
 * Selects eligible assignment messages and launches worker agents.
 * No lease-based locking. The supervisor is the single dispatcher.
 */

import { listOpenProjectMessages } from "../lib/messages";
import { getProjectPaths, type HivePaths } from "../lib/paths";
import { listActiveRuns, listAllRuns } from "../lib/runs";
import { selectWorkerLaunches } from "../lib/supervisor";
import { launchAgentPass } from "./launch";

export type WorkerLaunchDispatchOutcome = {
  agentId: string;
  messageFilename: string;
  result: PromiseSettledResult<string>;
};

export type WorkerLaunchDispatchResult = {
  status: "idle" | "dispatched";
  skipped: string[];
  outcomes: WorkerLaunchDispatchOutcome[];
};

export async function dispatchWorkerLaunchPass(input: {
  hivePaths: HivePaths;
  projectId: string;
  maxParallel: number;
  source: string;
  actor?: string;
  logActor?: string;
}): Promise<WorkerLaunchDispatchResult> {
  const projectPaths = getProjectPaths(input.hivePaths, input.projectId);
  const actor = input.actor ?? input.source;

  const projectConfig = await Bun.file(projectPaths.config).text();
  const plan = await Bun.file(projectPaths.plan).text();
  const openMessages = await listOpenProjectMessages(input.hivePaths.msgDir, input.projectId);
  const activeRuns = await listActiveRuns(projectPaths);
  const historicalRuns = await listAllRuns(projectPaths);

  const dispatch = selectWorkerLaunches({
    projectConfig,
    plan,
    openMessages,
    activeRuns,
    historicalRuns,
    maxParallel: input.maxParallel,
  });

  if (dispatch.launches.length === 0) {
    return {
      status: "idle",
      skipped: dispatch.skipped,
      outcomes: [],
    };
  }

  const settled = await Promise.allSettled(
    dispatch.launches.map(async (launch) => {
      return await launchAgentPass({
        activeProject: input.projectId,
        paths: input.hivePaths,
        agentId: launch.agentId,
        goal: null,
        runtimeOverride: null,
        modelOverride: null,
        dryRun: false,
        source: input.source,
        sourceMessage: launch.message.filename,
        logActor: input.logActor ?? actor,
      });
    }),
  );

  return {
    status: "dispatched",
    skipped: dispatch.skipped,
    outcomes: dispatch.launches.map((launch, index) => ({
      agentId: launch.agentId,
      messageFilename: launch.message.filename,
      result: settled[index]!,
    })),
  };
}
