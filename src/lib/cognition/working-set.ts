import { readJson } from "../json";
import type { ProjectPaths } from "../paths";
import type {
  ActiveRunsSummary,
  BoardSummary,
  HumanInboxSummary,
  OpenMessagesSummary,
  RecentResultsSummary,
} from "../state";

import type {
  MaterializedPacket,
  StewardWorkingSet,
} from "./packets";

export type CompiledStateView = {
  boardDigest: string;
  openDecisionsDigest: string;
  openMessagesDigest: string;
  activeRunsDigest: string;
  recentResultsDigest: string;
  humanInboxDigest: string;
};

type LoadedWorkingSetPackets = {
  boardHealth: MaterializedPacket | null;
  openDecisions: MaterializedPacket | null;
  runResults: MaterializedPacket[];
  diffTriage: MaterializedPacket[];
  humanRequests: MaterializedPacket[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

async function resolveWorkingSet(
  input: {
    projectPaths: ProjectPaths;
    workingSet?: StewardWorkingSet | null;
  },
): Promise<StewardWorkingSet | null> {
  if (input.workingSet) {
    return input.workingSet;
  }

  return readJson<StewardWorkingSet>(input.projectPaths.stateWorkingSetSteward);
}

async function loadWorkingSetPackets(input: {
  projectPaths: ProjectPaths;
  workingSet?: StewardWorkingSet | null;
}): Promise<LoadedWorkingSetPackets> {
  const workingSet = await resolveWorkingSet(input);

  if (!workingSet) {
    return {
      boardHealth: null,
      openDecisions: null,
      runResults: [],
      diffTriage: [],
      humanRequests: [],
    };
  }

  const packets = (await Promise.all(
    workingSet.packets.map(async (packetRef) => readJson<MaterializedPacket>(packetRef.path)),
  )).filter((packet): packet is MaterializedPacket => packet != null);

  return {
    boardHealth: packets.find((packet) => packet.kind === "board-health") ?? null,
    openDecisions: packets.find((packet) => packet.kind === "open-decisions") ?? null,
    runResults: packets.filter((packet) => packet.kind === "run-result"),
    diffTriage: packets.filter((packet) => packet.kind === "diff-triage"),
    humanRequests: packets.filter((packet) => packet.kind === "human-request"),
  };
}

function renderFallbackOpenDecisions(input: {
  boardSummary: BoardSummary;
  humanInboxSummary: HumanInboxSummary;
}): string {
  const waitingOnHuman = input.humanInboxSummary.items
    .filter((item) => item.needsHumanReply)
    .map((item) => item.summary)
    .slice(0, 6);

  if (
    input.boardSummary.blockers.length === 0 &&
    input.boardSummary.decisions.length === 0 &&
    waitingOnHuman.length === 0
  ) {
    return "No open decisions, blockers, or pending human replies.";
  }

  const lines = [
    `Open decisions: ${input.boardSummary.blockers.length} blocker(s), ${input.boardSummary.decisions.length} recent decision(s), ${waitingOnHuman.length} pending human repl${waitingOnHuman.length === 1 ? "y" : "ies"}.`,
  ];

  for (const blocker of input.boardSummary.blockers.slice(0, 4)) {
    lines.push(`- blocker: ${blocker}`);
  }

  for (const item of waitingOnHuman.slice(0, 4)) {
    lines.push(`- human: ${item}`);
  }

  return lines.join("\n");
}

function renderFallbackRecentResultsDigest(
  recentResultsSummary: RecentResultsSummary,
): string {
  if (recentResultsSummary.items.length === 0) {
    return "(none)";
  }

  return recentResultsSummary.items
    .slice(0, 5)
    .map((item) => `- ${item.agentId} | ${item.status} | ${item.summary || "no visible output"}`)
    .join("\n");
}

function renderFallbackHumanInboxDigest(
  humanInboxSummary: HumanInboxSummary,
): string {
  if (humanInboxSummary.items.length === 0) {
    return "(none)";
  }

  return humanInboxSummary.items
    .slice(0, 6)
    .map((item) => `- ${item.from} -> ${item.to} [${item.type}] ${item.summary}`)
    .join("\n");
}

function renderCompiledOpenDecisions(
  packet: MaterializedPacket | null,
): string | null {
  if (!packet) {
    return null;
  }

  const details = asRecord(packet.details);
  const blockers = asStringArray(details?.blockers).slice(0, 4);
  const waitingOnHuman = asStringArray(details?.waitingOnHuman).slice(0, 4);
  const lines = [packet.summary];

  for (const blocker of blockers) {
    lines.push(`- blocker: ${blocker}`);
  }

  for (const item of waitingOnHuman) {
    lines.push(`- human: ${item}`);
  }

  return lines.join("\n");
}

function renderCompiledOpenMessagesDigest(input: {
  boardHealth: MaterializedPacket | null;
  openDecisions: MaterializedPacket | null;
  humanRequests: MaterializedPacket[];
}): string | null {
  const boardDetails = asRecord(input.boardHealth?.details);
  const packetDigest = asString(boardDetails?.openMessagesDigest);

  if (packetDigest) {
    return packetDigest;
  }

  const count = asNumber(boardDetails?.openMessages);

  if (count === 0) {
    return "(none)";
  }

  const lines: string[] = [];

  if (count != null) {
    lines.push(`${count} open message(s) in queue.`);
  }

  if (input.humanRequests.length > 0) {
    lines.push(
      ...input.humanRequests
        .slice(0, 4)
        .map((packet) => `- ${packet.summary}`),
    );
  } else if (input.openDecisions) {
    lines.push(`- ${input.openDecisions.summary}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function renderCompiledActiveRunsDigest(
  boardHealth: MaterializedPacket | null,
): string | null {
  const boardDetails = asRecord(boardHealth?.details);
  const packetDigest = asString(boardDetails?.activeRunsDigest);

  if (packetDigest) {
    return packetDigest;
  }

  const count = asNumber(boardDetails?.activeRuns);

  if (count == null) {
    return null;
  }

  if (count === 0) {
    return "(none)";
  }

  return `${count} active run(s) in progress. Inspect active-runs.json if the current turn needs run-level detail.`;
}

function renderCompiledRecentResultsDigest(input: {
  runResults: MaterializedPacket[];
  diffTriage: MaterializedPacket[];
}): string | null {
  if (input.runResults.length === 0) {
    return null;
  }

  const triageByRunId = new Map<string, MaterializedPacket>();

  for (const packet of input.diffTriage) {
    triageByRunId.set(packet.packetId, packet);
  }

  return input.runResults
    .slice(0, 5)
    .map((packet) => {
      const details = asRecord(packet.details);
      const agentId = asString(details?.agentId) ?? "unknown";
      const status = asString(details?.status) ?? "unknown";
      const triage = triageByRunId.get(packet.packetId);
      const triageDetails = asRecord(triage?.details);
      const stewardWorthy = asBoolean(triageDetails?.stewardWorthy);
      const reason = asString(triageDetails?.reason);
      const suffix =
        stewardWorthy && reason ? ` | steward review: ${reason}` : "";

      return `- ${agentId} | ${status} | ${packet.summary}${suffix}`;
    })
    .join("\n");
}

function renderCompiledHumanInboxDigest(input: {
  humanRequests: MaterializedPacket[];
  openDecisions: MaterializedPacket | null;
}): string | null {
  if (input.humanRequests.length > 0) {
    return input.humanRequests
      .slice(0, 6)
      .map((packet) => {
        const details = asRecord(packet.details);
        const from = asString(details?.from) ?? "?";
        const to = asString(details?.to) ?? "?";
        const type = asString(details?.type) ?? "message";
        const body = asString(details?.body) ?? packet.summary;

        return `- ${from} -> ${to} [${type}] ${body}`;
      })
      .join("\n");
  }

  const openDecisionDetails = asRecord(input.openDecisions?.details);
  const waitingOnHuman = asStringArray(openDecisionDetails?.waitingOnHuman).slice(0, 6);

  if (waitingOnHuman.length === 0) {
    return null;
  }

  return waitingOnHuman.map((item) => `- ${item}`).join("\n");
}

export async function buildCompiledStateView(input: {
  projectPaths: ProjectPaths;
  workingSet?: StewardWorkingSet | null;
  fallback: {
    boardSummary: BoardSummary;
    openMessagesSummary: OpenMessagesSummary;
    activeRunsSummary: ActiveRunsSummary;
    recentResultsSummary: RecentResultsSummary;
    humanInboxSummary: HumanInboxSummary;
  };
}): Promise<CompiledStateView> {
  const packets = await loadWorkingSetPackets({
    projectPaths: input.projectPaths,
    workingSet: input.workingSet,
  });
  const boardDetails = asRecord(packets.boardHealth?.details);

  return {
    boardDigest:
      asString(boardDetails?.digest) ??
      packets.boardHealth?.summary ??
      input.fallback.boardSummary.digest,
    openDecisionsDigest:
      renderCompiledOpenDecisions(packets.openDecisions) ??
      renderFallbackOpenDecisions({
        boardSummary: input.fallback.boardSummary,
        humanInboxSummary: input.fallback.humanInboxSummary,
      }),
    openMessagesDigest:
      renderCompiledOpenMessagesDigest({
        boardHealth: packets.boardHealth,
        openDecisions: packets.openDecisions,
        humanRequests: packets.humanRequests,
      }) ??
      input.fallback.openMessagesSummary.digest,
    activeRunsDigest:
      renderCompiledActiveRunsDigest(packets.boardHealth) ??
      input.fallback.activeRunsSummary.digest,
    recentResultsDigest:
      renderCompiledRecentResultsDigest({
        runResults: packets.runResults,
        diffTriage: packets.diffTriage,
      }) ??
      renderFallbackRecentResultsDigest(input.fallback.recentResultsSummary),
    humanInboxDigest:
      renderCompiledHumanInboxDigest({
        humanRequests: packets.humanRequests,
        openDecisions: packets.openDecisions,
      }) ??
      renderFallbackHumanInboxDigest(input.fallback.humanInboxSummary),
  };
}
