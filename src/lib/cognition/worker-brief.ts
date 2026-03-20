import { join } from "node:path";

import { readJson, writeJson } from "../json";
import type { HiveMessage } from "../messages";
import type { ProjectPaths } from "../paths";
import type { PlanAgent, TeamAgent } from "../project";
import { resolveAgentScopeRoots } from "../project";

import type {
  CompilerCacheIndex,
  MaterializedPacket,
} from "./packets";
import { fingerprintParts } from "./packets";
import { truncateInline } from "./tasks/shared";

const MAX_OPEN_MESSAGES = 6;
const MAX_RELEVANT_RESULTS = 5;

type WorkerBriefMessage = {
  filename: string;
  type: string;
  from: string;
  to: string;
  summary: string;
  body: string;
  task: string | null;
  scope: string | null;
  path: string;
};

type WorkerBriefRunResult = {
  runId: string;
  agentId: string;
  status: string;
  summary: string;
  changedFiles: string[];
  assignmentMessage: string | null;
  path: string | null;
};

export type WorkerBriefPacketDetails = {
  agentId: string;
  persona: string;
  descriptor: string;
  assignment: string;
  planSection: string | null;
  assignmentMessage: WorkerBriefMessage | null;
  openMessages: WorkerBriefMessage[];
  scopeRoots: string[] | null;
  relevantRunResults: WorkerBriefRunResult[];
};

function firstLine(value: string, max = 220): string {
  return truncateInline(value.split("\n")[0] ?? "", max);
}

function capBody(value: string, max = 1_200): string {
  const trimmed = value.trim();

  if (trimmed.length <= max) {
    return trimmed;
  }

  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function getDetailsRecord(
  packet: MaterializedPacket | null,
): Record<string, unknown> | null {
  return packet?.details != null &&
    typeof packet.details === "object" &&
    !Array.isArray(packet.details)
    ? packet.details
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function messageSummary(message: HiveMessage): WorkerBriefMessage {
  return {
    filename: message.filename,
    type: message.attributes.type ?? "message",
    from: message.attributes.from ?? "?",
    to: message.attributes.to ?? "?",
    summary: firstLine(message.body),
    body: capBody(message.body, 1_500),
    task: message.attributes.task ?? null,
    scope: message.attributes.scope ?? null,
    path: message.path,
  };
}

function matchesMessageReference(message: HiveMessage, reference: string): boolean {
  const normalizedReference = reference.trim();
  const filenameWithoutExtension = message.filename.replace(/\.md$/, "");

  return (
    message.filename === normalizedReference ||
    filenameWithoutExtension === normalizedReference ||
    message.filename.startsWith(normalizedReference) ||
    filenameWithoutExtension.startsWith(normalizedReference)
  );
}

function selectAssignmentMessage(input: {
  openMessages: HiveMessage[];
  preferredAssignmentMessage?: string | null;
}): HiveMessage | null {
  const assignments = input.openMessages.filter(
    (message) => message.attributes.type === "assign",
  );

  if (input.preferredAssignmentMessage?.trim()) {
    return assignments.find((message) =>
      matchesMessageReference(message, input.preferredAssignmentMessage!),
    ) ?? null;
  }

  return assignments[0] ?? null;
}

function scopeMatchesChangedFiles(
  scopeRoots: string[] | null,
  changedFiles: string[],
): boolean {
  if (!scopeRoots || scopeRoots.length === 0) {
    return false;
  }

  return changedFiles.some((file) =>
    scopeRoots.some((scopeRoot) => file === scopeRoot || file.startsWith(`${scopeRoot}/`)),
  );
}

async function loadRelatedRunResultPackets(input: {
  compilerCacheIndex: CompilerCacheIndex | null;
  scopeRoots: string[] | null;
  assignmentMessage: WorkerBriefMessage | null;
}): Promise<WorkerBriefRunResult[]> {
  const packetRefs = input.compilerCacheIndex?.packets.filter(
    (packet) => packet.kind === "run-result",
  ) ?? [];

  const packets = (await Promise.all(
    packetRefs.map(async (packetRef) => ({
      ref: packetRef,
      packet: await readJson<MaterializedPacket>(packetRef.path),
    })),
  ))
    .filter(
      (entry): entry is { ref: MaterializedPacketRef; packet: MaterializedPacket } =>
        entry.packet?.kind === "run-result",
    )
    .sort((left, right) => right.ref.producedAt.localeCompare(left.ref.producedAt));

  return packets
    .filter(({ packet }) => {
      const details = getDetailsRecord(packet);
      const changedFiles = getStringArray(details?.changedFiles);
      const assignmentMessage = getString(details?.assignmentMessage);

      return (
        scopeMatchesChangedFiles(input.scopeRoots, changedFiles) ||
        (input.assignmentMessage != null &&
          assignmentMessage === input.assignmentMessage.filename)
      );
    })
    .slice(0, MAX_RELEVANT_RESULTS)
    .map(({ packet }) => {
      const details = getDetailsRecord(packet);

      return {
        runId: getString(details?.runId) ?? packet.packetId,
        agentId: getString(details?.agentId) ?? "unknown",
        status: getString(details?.status) ?? "unknown",
        summary: packet.summary,
        changedFiles: getStringArray(details?.changedFiles),
        assignmentMessage: getString(details?.assignmentMessage),
        path: getString(details?.path),
      };
    });
}

export function getWorkerBriefPacketPath(
  projectPaths: ProjectPaths,
  agentId: string,
): string {
  return join(projectPaths.statePacketWorkerBriefsDir, `${agentId}.json`);
}

export async function materializeWorkerBriefPacket(input: {
  projectId: string;
  projectPaths: ProjectPaths;
  agentId: string;
  resolvedAgent: PlanAgent | TeamAgent;
  plan: string;
  projectConfig: string;
  openMessages: HiveMessage[];
  compilerCacheIndex: CompilerCacheIndex | null;
  preferredAssignmentMessage?: string | null;
}): Promise<MaterializedPacket> {
  const openMessages = input.openMessages
    .filter((message) => message.attributes.to === input.agentId)
    .sort((left, right) =>
      (right.attributes.ts ?? right.filename).localeCompare(
        left.attributes.ts ?? left.filename,
      ),
    );
  const assignmentMessage = selectAssignmentMessage({
    openMessages,
    preferredAssignmentMessage: input.preferredAssignmentMessage ?? null,
  });
  const scopeRoots = resolveAgentScopeRoots({
    plan: input.plan,
    projectConfig: input.projectConfig,
    agentId: input.agentId,
    assignmentScope: assignmentMessage?.attributes.scope ?? null,
  });
  const relevantRunResults = await loadRelatedRunResultPackets({
    compilerCacheIndex: input.compilerCacheIndex,
    scopeRoots,
    assignmentMessage: assignmentMessage ? messageSummary(assignmentMessage) : null,
  });
  const assignment =
    "body" in input.resolvedAgent && input.resolvedAgent.body
      ? input.resolvedAgent.body
      : assignmentMessage?.body.trim() ||
        "No active assignment in PLAN.md. Default to the project configuration and the live board.";
  const openMessageSummaries = openMessages
    .slice(0, MAX_OPEN_MESSAGES)
    .map(messageSummary);
  const packetPath = getWorkerBriefPacketPath(input.projectPaths, input.agentId);
  const summaryParts = [
    `Worker brief for ${input.agentId}`,
    scopeRoots?.length ? `scope ${scopeRoots.join(", ")}` : "scope *",
    `${openMessageSummaries.length} open message(s)`,
    `${relevantRunResults.length} related result(s)`,
  ];
  const fingerprint = fingerprintParts(
    "worker-brief",
    input.projectId,
    input.agentId,
    input.resolvedAgent.descriptor,
    input.resolvedAgent.persona,
    assignment,
    "body" in input.resolvedAgent ? input.resolvedAgent.body : null,
    assignmentMessage?.filename ?? null,
    assignmentMessage?.raw ?? null,
    openMessageSummaries.map((message) => ({
      filename: message.filename,
      body: message.body,
      type: message.type,
    })),
    scopeRoots,
    relevantRunResults.map((result) => ({
      runId: result.runId,
      summary: result.summary,
      changedFiles: result.changedFiles,
      assignmentMessage: result.assignmentMessage,
    })),
  );

  const packet: MaterializedPacket = {
    packetId: input.agentId,
    kind: "worker-brief",
    projectId: input.projectId,
    fingerprint,
    producedAt: new Date().toISOString(),
    expiresAt: null,
    tier: 0,
    summary: `${summaryParts.join(" | ")}.`,
    details: {
      agentId: input.agentId,
      persona: input.resolvedAgent.persona,
      descriptor: input.resolvedAgent.descriptor,
      assignment,
      planSection:
        "body" in input.resolvedAgent && input.resolvedAgent.body
          ? input.resolvedAgent.body
          : null,
      assignmentMessage: assignmentMessage ? messageSummary(assignmentMessage) : null,
      openMessages: openMessageSummaries,
      scopeRoots,
      relevantRunResults,
    } satisfies WorkerBriefPacketDetails,
    source: {
      taskId: "worker-brief",
      trigger: "turn-start",
      path: packetPath,
    },
  };

  const existing = await readJson<MaterializedPacket>(packetPath);

  if (existing?.fingerprint === packet.fingerprint) {
    return existing;
  }

  await writeJson(packetPath, packet);
  return packet;
}
