import { createHash } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { listOpenProjectMessages } from "../lib/messages";
import { ensureDirectory, getProjectPaths, type HivePaths } from "../lib/paths";
import { listActiveRuns, listAllRuns } from "../lib/runs";
import { selectWorkerLaunches } from "../lib/supervisor";
import { toIsoTimestamp } from "../lib/time";
import { launchAgentPass } from "./launch";

type DispatchLeaseRecord = {
  pid: number;
  actor: string;
  projectId: string;
  claimedAt: string;
  agentId?: string | null;
  messageFilename?: string | null;
  scope?: string[] | null;
};

type DispatchLease = {
  release: () => Promise<void>;
};

type ClaimedWorkerLaunch = {
  agentId: string;
  messageFilename: string;
  releaseClaim: () => Promise<void>;
};

export type WorkerLaunchDispatchOutcome = {
  agentId: string;
  messageFilename: string;
  result: PromiseSettledResult<string>;
};

export type WorkerLaunchDispatchResult = {
  status: "idle" | "busy" | "dispatched";
  skipped: string[];
  outcomes: WorkerLaunchDispatchOutcome[];
};

const PROJECT_DISPATCH_LOCK_FILE = "worker-launch-dispatch.lock.json";
const ASSIGNMENT_CLAIMS_DIR = "worker-launch-claims";

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : null;

    if (code === "EPERM") {
      return true;
    }

    if (code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

function projectDispatchLockPath(projectPaths: ReturnType<typeof getProjectPaths>): string {
  return join(projectPaths.supervisorDir, PROJECT_DISPATCH_LOCK_FILE);
}

function assignmentClaimPath(
  projectPaths: ReturnType<typeof getProjectPaths>,
  messageFilename: string,
): string {
  const digest = createHash("sha1").update(messageFilename).digest("hex").slice(0, 16);

  return join(projectPaths.supervisorDir, ASSIGNMENT_CLAIMS_DIR, `${digest}.json`);
}

async function readDispatchLease(path: string): Promise<DispatchLeaseRecord | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<DispatchLeaseRecord>;

    if (
      typeof parsed.pid !== "number" ||
      !Number.isFinite(parsed.pid) ||
      typeof parsed.actor !== "string" ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.claimedAt !== "string"
    ) {
      return null;
    }

    return {
      pid: parsed.pid,
      actor: parsed.actor,
      projectId: parsed.projectId,
      claimedAt: parsed.claimedAt,
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
      messageFilename:
        typeof parsed.messageFilename === "string" ? parsed.messageFilename : null,
      scope: Array.isArray(parsed.scope)
        ? parsed.scope.filter((value): value is string => typeof value === "string")
        : null,
    };
  } catch {
    return null;
  }
}

async function tryAcquireLease(
  path: string,
  record: DispatchLeaseRecord,
): Promise<DispatchLease | null> {
  await ensureDirectory(dirname(path));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.close();

      let released = false;

      return {
        release: async () => {
          if (released) {
            return;
          }

          released = true;
          await rm(path, { force: true });
        },
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: string }).code
          : null;

      if (code !== "EEXIST") {
        throw error;
      }

      const existing = await readDispatchLease(path);

      if (!existing || !isProcessAlive(existing.pid)) {
        await rm(path, { force: true }).catch(() => {
          // Another dispatcher may have cleaned it up first.
        });
        continue;
      }

      return null;
    }
  }

  return null;
}

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
  const dispatchLease = await tryAcquireLease(projectDispatchLockPath(projectPaths), {
    pid: process.pid,
    actor,
    projectId: input.projectId,
    claimedAt: toIsoTimestamp(),
  });

  if (!dispatchLease) {
    return {
      status: "busy",
      skipped: ["worker launch dispatch already in progress"],
      outcomes: [],
    };
  }

  const claimedLaunches: Array<
    ClaimedWorkerLaunch & {
      releaseClaim: () => Promise<void>;
    }
  > = [];
  const skipped: string[] = [];

  try {
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

    skipped.push(...dispatch.skipped);

    for (const launch of dispatch.launches) {
      const claim = await tryAcquireLease(
        assignmentClaimPath(projectPaths, launch.message.filename),
        {
          pid: process.pid,
          actor,
          projectId: input.projectId,
          claimedAt: toIsoTimestamp(),
          agentId: launch.agentId,
          messageFilename: launch.message.filename,
          scope: launch.scope,
        },
      );

      if (!claim) {
        skipped.push(`${launch.message.filename}: launch already claimed by another dispatcher`);
        continue;
      }

      claimedLaunches.push({
        agentId: launch.agentId,
        messageFilename: launch.message.filename,
        releaseClaim: claim.release,
      });
    }
  } finally {
    await dispatchLease.release();
  }

  if (claimedLaunches.length === 0) {
    return {
      status: skipped.length > 0 ? "busy" : "idle",
      skipped,
      outcomes: [],
    };
  }

  const settled = await Promise.allSettled(
    claimedLaunches.map(async (launch) => {
      try {
        return await launchAgentPass({
          activeProject: input.projectId,
          paths: input.hivePaths,
          agentId: launch.agentId,
          goal: null,
          runtimeOverride: null,
          modelOverride: null,
          dryRun: false,
          source: input.source,
          sourceMessage: launch.messageFilename,
          logActor: input.logActor ?? actor,
        });
      } finally {
        await launch.releaseClaim();
      }
    }),
  );

  return {
    status: "dispatched",
    skipped,
    outcomes: claimedLaunches.map((launch, index) => ({
      agentId: launch.agentId,
      messageFilename: launch.messageFilename,
      result: settled[index]!,
    })),
  };
}
