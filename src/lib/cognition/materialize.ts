import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { readJson, writeJson } from "../json";
import type { HiveMessage } from "../messages";
import { ensureDirectory, type ProjectPaths } from "../paths";
import type { RunResult } from "../runs";
import { defaultCognitionWorkbench } from "./default-workbench";
import {
  preprocessHumanMessageTask,
  triageRunDiffForStewardTask,
} from ".";
import type {
  CompilerCacheIndex,
  MaterializedPacket,
  StewardWorkingSet,
} from "./packets";
import {
  fingerprintParts,
  mergeMaterializedPacketRefs,
  packetExpiresAt,
  toMaterializedPacketRef,
  upsertPacket,
} from "./packets";
import { normalizeText, truncateInline } from "./tasks/shared";
import type {
  ActiveRunsSummary,
  BoardSummary,
  HumanInboxSummary,
  OpenMessagesSummary,
  ProjectStateRevision,
  RecentResultsSummary,
} from "../state";

const MAX_WORKING_SET_HUMAN_REQUESTS = 4;
const MAX_WORKING_SET_RUN_RESULTS = 6;

function firstLine(value: string, max = 180): string {
  return truncateInline(value.split("\n")[0] ?? "", max);
}

async function readPacket(path: string): Promise<MaterializedPacket | null> {
  return readJson<MaterializedPacket>(path);
}

async function prunePacketDirectory(
  dir: string,
  validNames: Set<string>,
): Promise<void> {
  await ensureDirectory(dir);

  const entries = await readdir(dir).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => !validNames.has(entry))
      .map((entry) => rm(join(dir, entry), { recursive: true, force: true })),
  );
}

function buildBoardHealthPacket(input: {
  projectId: string;
  revision: ProjectStateRevision;
  boardSummary: BoardSummary;
  openMessagesSummary: OpenMessagesSummary;
  activeRunsSummary: ActiveRunsSummary;
  producedAt: string;
  path: string;
}): MaterializedPacket {
  const blockers = input.boardSummary.blockers.length;
  const active = input.boardSummary.activeCount;
  const waiting = input.boardSummary.waitingCount;
  const runs = input.activeRunsSummary.count;
  const messages = input.openMessagesSummary.count;

  return {
    packetId: "board-health",
    kind: "board-health",
    projectId: input.projectId,
    fingerprint: fingerprintParts(
      "board-health",
      input.revision.fingerprints.board,
      input.revision.fingerprints.activeRuns,
      input.revision.fingerprints.openMessages,
    ),
    producedAt: input.producedAt,
    expiresAt: null,
    tier: 0,
    summary: `Board health: ${active} active, ${waiting} waiting, ${blockers} blocker(s), ${runs} active run(s), ${messages} open message(s).`,
    details: {
      sourcePath: input.boardSummary.sourcePath,
      digest: input.boardSummary.digest,
      openMessagesDigest: input.openMessagesSummary.digest,
      activeRunsDigest: input.activeRunsSummary.digest,
      taskCount: input.boardSummary.taskCount,
      activeCount: active,
      waitingCount: waiting,
      doneCount: input.boardSummary.doneCount,
      blockers: input.boardSummary.blockers,
      decisions: input.boardSummary.decisions,
      activeRuns: runs,
      openMessages: messages,
    },
    source: {
      taskId: "board-health",
      trigger: "derived-state",
      path: input.path,
    },
  };
}

function buildOpenDecisionsPacket(input: {
  projectId: string;
  revision: ProjectStateRevision;
  boardSummary: BoardSummary;
  humanInboxSummary: HumanInboxSummary;
  producedAt: string;
  path: string;
}): MaterializedPacket {
  const blockers = input.boardSummary.blockers;
  const decisions = input.boardSummary.decisions;
  const waitingOnHuman = input.humanInboxSummary.items
    .filter((item) => item.needsHumanReply)
    .map((item) => item.summary)
    .slice(0, 6);
  const summary =
    blockers.length === 0 && decisions.length === 0 && waitingOnHuman.length === 0
      ? "No open decisions, blockers, or pending human replies."
      : `Open decisions: ${blockers.length} blocker(s), ${decisions.length} recent decision(s), ${waitingOnHuman.length} pending human repl${waitingOnHuman.length === 1 ? "y" : "ies"}.`;

  return {
    packetId: "open-decisions",
    kind: "open-decisions",
    projectId: input.projectId,
    fingerprint: fingerprintParts(
      "open-decisions",
      input.revision.fingerprints.board,
      input.revision.fingerprints.humanInbox,
      input.revision.fingerprints.openMessages,
    ),
    producedAt: input.producedAt,
    expiresAt: null,
    tier: 0,
    summary,
    details: {
      blockers,
      decisions,
      pendingHumanReplies: input.humanInboxSummary.pendingHumanReplies,
      waitingOnHuman,
    },
    source: {
      taskId: "open-decisions",
      trigger: "derived-state",
      path: input.path,
    },
  };
}

function buildRunResultPacket(input: {
  projectId: string;
  result: RunResult;
  summary: string;
  producedAt: string;
  path: string;
}): MaterializedPacket {
  return {
    packetId: input.result.runId,
    kind: "run-result",
    projectId: input.projectId,
    fingerprint: fingerprintParts(
      "run-result",
      input.result.runId,
      input.result.status,
      input.result.exitCode,
      input.result.ended,
      input.result.changedFiles,
      input.result.gitSummaryLines,
      input.result.finalVisibleOutput,
      input.result.cognitiveDigest ?? null,
    ),
    producedAt: input.producedAt,
    expiresAt: null,
    tier: input.result.cognitiveDigest ? 1 : 0,
    summary: input.summary,
    details: {
      runId: input.result.runId,
      agentId: input.result.agentId,
      status: input.result.status,
      ended: input.result.ended,
      assignmentMessage: input.result.assignmentMessage,
      changedFiles: input.result.changedFiles,
      gitSummaryLines: input.result.gitSummaryLines,
      outputPreview: firstLine(input.result.finalVisibleOutput, 280),
      cognitiveDigest: input.result.cognitiveDigest,
      path: input.result.path,
    },
    source: {
      taskId: "compress-completed-run-output",
      trigger: "event",
      path: input.path,
    },
  };
}

function buildHumanRequestCompactContext(input: {
  projectId: string;
  boardSummary: BoardSummary;
  openMessagesSummary: OpenMessagesSummary;
  activeRunsSummary: ActiveRunsSummary;
  recentResultsSummary: RecentResultsSummary;
  humanInboxSummary: HumanInboxSummary;
}): string {
  return [
    `project: ${input.projectId}`,
    `board: ${input.boardSummary.digest}`,
    `active-runs: ${input.activeRunsSummary.count}`,
    `open-messages: ${input.openMessagesSummary.count}`,
    `pending-human-replies: ${input.humanInboxSummary.pendingHumanReplies}`,
    input.recentResultsSummary.items[0]
      ? `recent-result: ${input.recentResultsSummary.items[0]!.summary}`
      : "recent-result: none",
  ].join("\n");
}

function isHumanRequestMessage(message: HiveMessage): boolean {
  return (
    message.attributes.from === "human" ||
    (message.attributes.type === "nudge" && message.attributes.to === "steward")
  );
}

async function materializeDiffTriagePacket(input: {
  projectId: string;
  result: RunResult;
  globalConfig: string;
  packetPath: string;
}): Promise<MaterializedPacket> {
  const taskInput = {
    globalConfig: input.globalConfig,
    result: input.result,
  };
  const fingerprint = triageRunDiffForStewardTask.fingerprint(taskInput);
  const existing = await readPacket(input.packetPath);

  if (existing?.fingerprint === fingerprint) {
    return existing;
  }

  const packet = await defaultCognitionWorkbench.runTask(
    triageRunDiffForStewardTask,
    taskInput,
  );

  if (!packet) {
    throw new Error(`Expected diff triage packet for ${input.result.runId}`);
  }

  const producedAt = packet.compiledAt;
  const materialized: MaterializedPacket = {
    packetId: input.result.runId,
    kind: "diff-triage",
    projectId: input.projectId,
    fingerprint: packet.fingerprint,
    producedAt,
    expiresAt: packetExpiresAt(producedAt, triageRunDiffForStewardTask.freshnessMs),
    tier: packet.data.handledBy === "tier1" ? 1 : 0,
    summary: packet.data.stewardWorthy
      ? `Steward review recommended: ${packet.data.reason}`
      : `Routine result: ${packet.data.reason}`,
    details: {
      runId: input.result.runId,
      agentId: input.result.agentId,
      stewardWorthy: packet.data.stewardWorthy,
      reason: packet.data.reason,
      handledBy: packet.data.handledBy,
      provider: packet.data.provider,
      model: packet.data.model,
      path: input.result.path,
      ended: input.result.ended,
    },
    source: {
      taskId: packet.taskId,
      trigger: triageRunDiffForStewardTask.trigger,
      path: input.packetPath,
    },
  };

  const result = await upsertPacket(input.packetPath, materialized);
  return result.packet;
}

async function materializeHumanRequestPacket(input: {
  projectId: string;
  message: HiveMessage;
  globalConfig: string;
  compactContext: string;
  packetPath: string;
}): Promise<MaterializedPacket> {
  const taskInput = {
    globalConfig: input.globalConfig,
    message: input.message.body,
    compactContext: input.compactContext,
  };

  if (!preprocessHumanMessageTask.shouldRun(taskInput)) {
    const producedAt = input.message.attributes.ts ?? new Date().toISOString();
    const deterministicPacket: MaterializedPacket = {
      packetId: input.message.filename,
      kind: "human-request",
      projectId: input.projectId,
      fingerprint: fingerprintParts(
        "human-request-deterministic",
        input.message.filename,
        input.message.attributes.ts ?? null,
        input.message.body,
      ),
      producedAt,
      expiresAt: null,
      tier: 0,
      summary: `Human request needs steward review: ${firstLine(input.message.body)}`,
      details: {
        filename: input.message.filename,
        type: input.message.attributes.type ?? "message",
        from: input.message.attributes.from ?? "?",
        to: input.message.attributes.to ?? "?",
        ts: input.message.attributes.ts ?? null,
        classification: "complex",
        answer: "",
        reason: "Message did not qualify for conservative tier-1 preprocessing.",
        body: firstLine(input.message.body, 320),
        path: input.message.path,
      },
      source: {
        taskId: "human-request-deterministic",
        trigger: "derived-state",
        path: input.packetPath,
      },
    };

    const deterministicResult = await upsertPacket(input.packetPath, deterministicPacket);
    return deterministicResult.packet;
  }

  const fingerprint = preprocessHumanMessageTask.fingerprint(taskInput);
  const existing = await readPacket(input.packetPath);

  if (existing?.fingerprint === fingerprint) {
    return existing;
  }

  const packet = await defaultCognitionWorkbench.runTask(
    preprocessHumanMessageTask,
    taskInput,
  );

  if (!packet) {
    const fallbackProducedAt = input.message.attributes.ts ?? new Date().toISOString();
    const fallbackPacket: MaterializedPacket = {
      packetId: input.message.filename,
      kind: "human-request",
      projectId: input.projectId,
      fingerprint,
      producedAt: fallbackProducedAt,
      expiresAt: null,
      tier: 0,
      summary: `Human request needs steward review: ${firstLine(input.message.body)}`,
      details: {
        filename: input.message.filename,
        type: input.message.attributes.type ?? "message",
        from: input.message.attributes.from ?? "?",
        to: input.message.attributes.to ?? "?",
        ts: input.message.attributes.ts ?? null,
        classification: "complex",
        answer: "",
        reason: "Tier-1 preprocessing returned no classification.",
        body: firstLine(input.message.body, 320),
        path: input.message.path,
      },
      source: {
        taskId: preprocessHumanMessageTask.id,
        trigger: preprocessHumanMessageTask.trigger,
        path: input.packetPath,
      },
    };

    const fallbackResult = await upsertPacket(input.packetPath, fallbackPacket);
    return fallbackResult.packet;
  }

  const producedAt = packet.compiledAt;
  const summary =
    packet.data.classification === "simple_query" && packet.data.answer
      ? `Human request (${packet.data.classification}): ${packet.data.answer}`
      : `Human request (${packet.data.classification}): ${packet.data.reason || firstLine(input.message.body)}`;
  const materialized: MaterializedPacket = {
    packetId: input.message.filename,
    kind: "human-request",
    projectId: input.projectId,
    fingerprint: packet.fingerprint,
    producedAt,
    expiresAt: packetExpiresAt(producedAt, preprocessHumanMessageTask.freshnessMs),
    tier: 1,
    summary,
    details: {
      filename: input.message.filename,
      type: input.message.attributes.type ?? "message",
      from: input.message.attributes.from ?? "?",
      to: input.message.attributes.to ?? "?",
      ts: input.message.attributes.ts ?? null,
      classification: packet.data.classification,
      answer: packet.data.answer,
      reason: packet.data.reason,
      provider: packet.data.provider,
      model: packet.data.model,
      body: firstLine(input.message.body, 320),
      path: input.message.path,
    },
    source: {
      taskId: packet.taskId,
      trigger: preprocessHumanMessageTask.trigger,
      path: input.packetPath,
    },
  };

  const materializedResult = await upsertPacket(input.packetPath, materialized);
  return materializedResult.packet;
}

export async function materializeProjectCognition(input: {
  projectId: string;
  projectPaths: ProjectPaths;
  globalConfig: string;
  revision: ProjectStateRevision;
  boardSummary: BoardSummary;
  openMessages: HiveMessage[];
  openMessagesSummary: OpenMessagesSummary;
  recentResults: RunResult[];
  recentResultsSummary: RecentResultsSummary;
  activeRunsSummary: ActiveRunsSummary;
  humanInboxSummary: HumanInboxSummary;
}): Promise<{
  compilerCacheIndex: CompilerCacheIndex;
  workingSet: StewardWorkingSet;
}> {
  await Promise.all([
    ensureDirectory(input.projectPaths.statePacketsDir),
    ensureDirectory(input.projectPaths.statePacketRunResultsDir),
    ensureDirectory(input.projectPaths.statePacketDiffTriageDir),
    ensureDirectory(input.projectPaths.statePacketHumanRequestsDir),
    ensureDirectory(input.projectPaths.stateCompilerDir),
    ensureDirectory(input.projectPaths.stateWorkingSetDir),
  ]);

  const boardResult = await upsertPacket(
    input.projectPaths.statePacketBoardHealth,
    buildBoardHealthPacket({
      projectId: input.projectId,
      revision: input.revision,
      boardSummary: input.boardSummary,
      openMessagesSummary: input.openMessagesSummary,
      activeRunsSummary: input.activeRunsSummary,
      producedAt: input.revision.updatedAt,
      path: input.projectPaths.board,
    }),
  );
  const boardPacket = boardResult.packet;

  const openDecisionsResult = await upsertPacket(
    input.projectPaths.statePacketOpenDecisions,
    buildOpenDecisionsPacket({
      projectId: input.projectId,
      revision: input.revision,
      boardSummary: input.boardSummary,
      humanInboxSummary: input.humanInboxSummary,
      producedAt: input.revision.updatedAt,
      path: input.projectPaths.board,
    }),
  );
  const openDecisionsPacket = openDecisionsResult.packet;

  const runResultPackets = await Promise.all(
    input.recentResults.map(async (result) => {
      const packetPath = join(
        input.projectPaths.statePacketRunResultsDir,
        `${result.runId}.json`,
      );
      const runResult = await upsertPacket(
        packetPath,
        buildRunResultPacket({
          projectId: input.projectId,
          result,
          summary: truncateInline(
            result.cognitiveDigest?.summary || firstLine(result.finalVisibleOutput),
          ),
          producedAt: result.ended,
          path: packetPath,
        }),
      );

      return {
        packet: runResult.packet,
        path: packetPath,
        result,
      };
    }),
  );

  const diffTriagePackets = await Promise.all(
    input.recentResults.map(async (result) => {
      const packetPath = join(
        input.projectPaths.statePacketDiffTriageDir,
        `${result.runId}.json`,
      );
      const packet = await materializeDiffTriagePacket({
        projectId: input.projectId,
        result,
        globalConfig: input.globalConfig,
        packetPath,
      });

      return {
        packet,
        path: packetPath,
        result,
      };
    }),
  );

  const compactContext = buildHumanRequestCompactContext({
    projectId: input.projectId,
    boardSummary: input.boardSummary,
    openMessagesSummary: input.openMessagesSummary,
    activeRunsSummary: input.activeRunsSummary,
    recentResultsSummary: input.recentResultsSummary,
    humanInboxSummary: input.humanInboxSummary,
  });
  const humanMessages = input.openMessages.filter(isHumanRequestMessage);
  const humanRequestPackets = await Promise.all(
    humanMessages.map(async (message) => {
      const packetPath = join(
        input.projectPaths.statePacketHumanRequestsDir,
        `${message.filename}.json`,
      );
      const packet = await materializeHumanRequestPacket({
        projectId: input.projectId,
        message,
        globalConfig: input.globalConfig,
        compactContext,
        packetPath,
      });

      return {
        packet,
        path: packetPath,
        message,
      };
    }),
  );

  await Promise.all([
    prunePacketDirectory(
      input.projectPaths.statePacketRunResultsDir,
      new Set(runResultPackets.map(({ result }) => `${result.runId}.json`)),
    ),
    prunePacketDirectory(
      input.projectPaths.statePacketDiffTriageDir,
      new Set(diffTriagePackets.map(({ result }) => `${result.runId}.json`)),
    ),
    prunePacketDirectory(
      input.projectPaths.statePacketHumanRequestsDir,
      new Set(humanRequestPackets.map(({ message }) => `${message.filename}.json`)),
    ),
  ]);

  const packetRefs = [
    toMaterializedPacketRef(boardPacket, input.projectPaths.statePacketBoardHealth),
    toMaterializedPacketRef(openDecisionsPacket, input.projectPaths.statePacketOpenDecisions),
    ...runResultPackets.map(({ packet, path }) => toMaterializedPacketRef(packet, path)),
    ...diffTriagePackets.map(({ packet, path }) => toMaterializedPacketRef(packet, path)),
    ...humanRequestPackets.map(({ packet, path }) => toMaterializedPacketRef(packet, path)),
  ];
  const existingCacheIndex = await readJson<CompilerCacheIndex>(input.projectPaths.stateCompilerCacheIndex);
  const compilerCacheIndex: CompilerCacheIndex = {
    projectId: input.projectId,
    revision: input.revision.revision,
    updatedAt: input.revision.updatedAt,
    packets: mergeMaterializedPacketRefs({
      existing: existingCacheIndex?.packets ?? [],
      replaceKinds: ["board-health", "open-decisions", "run-result", "diff-triage", "human-request"],
      next: packetRefs,
    }),
  };

  const IDLE_PACKET_KINDS_FOR_WORKING_SET: Set<string> = new Set([
    "log-rollup",
    "phase-summary",
    "memory-hotset",
    "stale-memory",
  ]);
  const idlePacketsFromCache = (existingCacheIndex?.packets ?? [])
    .filter((ref) => IDLE_PACKET_KINDS_FOR_WORKING_SET.has(ref.kind));

  const workingSetPackets = [
    toMaterializedPacketRef(boardPacket, input.projectPaths.statePacketBoardHealth),
    toMaterializedPacketRef(openDecisionsPacket, input.projectPaths.statePacketOpenDecisions),
    ...humanRequestPackets
      .sort((left, right) =>
        (right.message.attributes.ts ?? right.message.filename).localeCompare(
          left.message.attributes.ts ?? left.message.filename,
        ),
      )
      .slice(0, MAX_WORKING_SET_HUMAN_REQUESTS)
      .map(({ packet, path }) => toMaterializedPacketRef(packet, path)),
    ...runResultPackets
      .slice(0, MAX_WORKING_SET_RUN_RESULTS)
      .map(({ packet, path }) => toMaterializedPacketRef(packet, path)),
    ...diffTriagePackets
      .slice(0, MAX_WORKING_SET_RUN_RESULTS)
      .map(({ packet, path }) => toMaterializedPacketRef(packet, path)),
    ...idlePacketsFromCache,
  ];
  const workingSet: StewardWorkingSet = {
    consumer: "steward-refresh",
    projectId: input.projectId,
    revision: input.revision.revision,
    producedAt: input.revision.updatedAt,
    packets: workingSetPackets,
  };

  await Promise.all([
    writeJson(input.projectPaths.stateCompilerCacheIndex, compilerCacheIndex),
    writeJson(input.projectPaths.stateWorkingSetSteward, workingSet),
  ]);

  return {
    compilerCacheIndex,
    workingSet,
  };
}
