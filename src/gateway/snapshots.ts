import { join } from "node:path";

import type { GatewayOptions } from "./server";

import { listApprovals, type ApprovalRequest } from "../lib/approvals";
import { reconcileDetachedSupervisorState } from "../lib/detached-supervisor";
import { listRecentEvents, type EventRecord } from "../lib/events";
import { parseStructuredFeedEntries } from "../lib/feed";
import { readJson } from "../lib/json";
import { getProjectPaths, type ProjectPaths } from "../lib/paths";
import {
  extractPersonaName,
  findPlanAgent,
  inferModelPoolFromAgentId,
  parseDefaultTeam,
  parseModelPool,
  stripRuntimeHintsFromDescriptor,
} from "../lib/project";
import {
  readRunOutputTail,
  type RunRecord,
  type RunResult,
} from "../lib/runs";

/**
 * Lightweight stand-in for the removed cognition MaterializedPacket type.
 * Only used by the dashboard snapshot to render cached packet data.
 */
type MaterializedPacket = {
  kind: string;
  summary: string;
  details: Record<string, unknown>;
  updatedAt: string;
};

function getLogRollupPacketPath(projectPaths: ProjectPaths): string {
  return `${projectPaths.stateDir}/log-rollup.json`;
}

function getPhaseSummaryPacketPath(projectPaths: ProjectPaths): string {
  return `${projectPaths.stateDir}/phase-summary.json`;
}
import {
  readStewardDeltaHistory,
  refreshProjectRuntimeState,
  type ActiveRunsSummary,
  type BoardSummary,
  type HumanInboxSummary,
  type OpenMessagesSummary,
  type ProjectRuntimeState,
  type RecentResultsSummary,
} from "../lib/state";
import { sanitizeStewardOutput } from "../lib/steward/sanitize";

export type GatewayLiveAgent = {
  runId: string;
  agentId: string;
  displayName: string;
  persona: string;
  descriptor: string;
  status: string;
  runtime: string;
  model: string | null;
  started: string;
  pid: number | null;
  taskId: string | null;
  source: string;
  latestOutput: string | null;
  tail: string[];
};

export type GatewayRecentCompletion = {
  runId: string;
  agentId: string;
  displayName: string;
  persona: string;
  descriptor: string;
  status: string;
  ended: string;
  summary: string;
  changedFiles: string[];
  runtime: string | null;
  model: string | null;
};

export type GatewayActivityItem = {
  id: string;
  ts: string;
  source: "delta" | "event";
  kind: string;
  actor: string | null;
  title: string;
  detail: string;
  tone: "info" | "warning" | "error" | "success";
};

export type GatewayQueueIncident = {
  id: string;
  ts: string;
  kind: string;
  source: string;
  severity: "warning" | "error";
  summary: string;
  details: string[];
  routed: boolean;
};

export type GatewayTimelineItem = {
  id: string;
  ts: string;
  source: "feed" | "event";
  project: string | null;
  title: string;
  details: string[];
  tone: "info" | "warning" | "error" | "success";
};

export type GatewayCompiledDigest = {
  id: string;
  label: string;
  body: string;
};

export type GatewayIdlePacketSummary = {
  id: string;
  label: string;
  kicker: string | null;
  body: string;
  tone: "info" | "warning" | "success";
  producedAt: string | null;
};

export type GatewayProjectCognitionSnapshot = {
  workingSetRevision: number | null;
  workingSetProducedAt: string | null;
  compilerUpdatedAt: string | null;
  workingSetDigests: GatewayCompiledDigest[];
  idlePackets: GatewayIdlePacketSummary[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function sanitizeGatewayText(text: string): string {
  return sanitizeStewardOutput(text).trim();
}

function classifyTone(text: string): GatewayTimelineItem["tone"] {
  const normalized = text.toLowerCase();

  if (
    normalized.includes("error") ||
    normalized.includes("failed") ||
    normalized.includes("crash") ||
    normalized.includes("rejected")
  ) {
    return "error";
  }

  if (
    normalized.includes("warning") ||
    normalized.includes("blocked") ||
    normalized.includes("approval requested") ||
    normalized.includes("stale")
  ) {
    return "warning";
  }

  if (
    normalized.includes("done") ||
    normalized.includes("completed") ||
    normalized.includes("approved") ||
    normalized.includes("resolved")
  ) {
    return "success";
  }

  return "info";
}

function toneFromSeverity(
  severity: EventRecord["severity"],
): GatewayTimelineItem["tone"] {
  if (severity === "error") {
    return "error";
  }

  if (severity === "warning") {
    return "warning";
  }

  return "info";
}

export async function readProjectAgentContext(
  projectPaths: ProjectPaths,
  globalConfigPath?: string,
): Promise<{
  plan: string;
  projectConfig: string;
  globalConfig: string;
}> {
  const [plan, projectConfig, globalConfig] = await Promise.all([
    Bun.file(projectPaths.plan).text().catch(() => ""),
    Bun.file(projectPaths.config).text().catch(() => ""),
    globalConfigPath ? Bun.file(globalConfigPath).text().catch(() => "") : Promise.resolve(""),
  ]);

  return { plan, projectConfig, globalConfig };
}

function resolveAgentPresentation(input: {
  plan: string;
  projectConfig: string;
  globalConfig: string;
  agentId: string;
}): { displayName: string; persona: string; descriptor: string } {
  if (input.agentId === "console") {
    return {
      displayName: "steward",
      persona: "steward",
      descriptor: "live steward session",
    };
  }

  if (input.agentId === "steward") {
    return {
      displayName: "background steward",
      persona: "steward",
      descriptor: "background coordination steward",
    };
  }

  const planAgent = findPlanAgent(input.plan, input.agentId);

  if (planAgent) {
    return {
      displayName: input.agentId,
      persona: planAgent.persona,
      descriptor: stripRuntimeHintsFromDescriptor(planAgent.descriptor),
    };
  }

  const teamAgent = parseDefaultTeam(input.projectConfig).find(
    (agent) => agent.id === input.agentId,
  );

  if (teamAgent) {
    return {
      displayName: input.agentId,
      persona: teamAgent.persona,
      descriptor: stripRuntimeHintsFromDescriptor(teamAgent.descriptor),
    };
  }

  // Try to resolve from ephemeral agent ID pattern (e.g. craftsman-opus-001).
  const segments = input.agentId.split("-");
  const inferredPersona = extractPersonaName(segments[0] ?? "");
  const modelPoolEntry = inferModelPoolFromAgentId(input.agentId, input.globalConfig || input.projectConfig);

  if (modelPoolEntry) {
    return {
      displayName: input.agentId,
      persona: inferredPersona || "worker",
      descriptor: `${inferredPersona || "worker"} via ${modelPoolEntry.name} (${modelPoolEntry.model})`,
    };
  }

  if (inferredPersona && inferredPersona !== input.agentId) {
    return {
      displayName: input.agentId,
      persona: inferredPersona,
      descriptor: `ephemeral ${inferredPersona}`,
    };
  }

  return {
    displayName: input.agentId,
    persona: "worker",
    descriptor: "active worker",
  };
}

function toneFromDeltaKind(kind: string): GatewayActivityItem["tone"] {
  if (kind === "worker-result" || kind === "steward-result") {
    return "success";
  }

  if (kind === "human-message") {
    return "warning";
  }

  if (kind === "message-cleared" || kind === "run-finished") {
    return "info";
  }

  return "info";
}

function mapDeltaActivity(input: {
  revision: number;
  ts: string;
  change: Awaited<ReturnType<typeof readStewardDeltaHistory>>[number]["changes"][number];
}): GatewayActivityItem {
  return {
    id: `delta-${input.revision}-${input.change.type}-${input.change.runId ?? input.change.filename ?? input.change.summary}`,
    ts: input.ts,
    source: "delta",
    kind: input.change.type,
    actor: input.change.agent ?? null,
    title: input.change.agent
      ? `${input.change.agent} · ${input.change.type}`
      : input.change.type.replace(/-/g, " "),
    detail: input.change.summary,
    tone: toneFromDeltaKind(input.change.type),
  };
}

function mapEventActivity(event: EventRecord): GatewayActivityItem {
  return {
    id: `event-${event.id}`,
    ts: event.ts,
    source: "event",
    kind: event.kind,
    actor: event.source,
    title: event.kind,
    detail: event.summary,
    tone: toneFromSeverity(event.severity),
  };
}

function renderLogRollupBody(packet: MaterializedPacket): string {
  const details = asRecord(packet.details);
  const logEntries = Array.isArray(details?.logEntries)
    ? details.logEntries
      .map((entry) => {
        const record = asRecord(entry);
        const actor = asString(record?.actor) ?? "unknown";
        const summary = asString(record?.summary);

        return summary ? `- ${actor}: ${summary}` : null;
      })
      .filter((line): line is string => line != null)
      .slice(0, 4)
    : [];
  const feedHeadlines = asStringArray(details?.feedHeadlines)
    .slice(0, 3)
    .map((headline) => `- ${headline}`);

  return sanitizeGatewayText([packet.summary, ...logEntries, ...feedHeadlines].join("\n"));
}

function renderPhaseSummaryBody(packet: MaterializedPacket): string {
  const details = asRecord(packet.details);
  const goal = asString(details?.goal);
  const completedTasks = asStringArray(details?.completedTasks)
    .slice(0, 5)
    .map((task) => `- done: ${task}`);
  const recentSuccessfulResults = Array.isArray(details?.recentSuccessfulResults)
    ? details.recentSuccessfulResults
      .map((item) => {
        const record = asRecord(item);
        const agentId = asString(record?.agentId) ?? "unknown";
        const summary = asString(record?.summary);

        return summary ? `- result: ${agentId} · ${summary}` : null;
      })
      .filter((line): line is string => line != null)
      .slice(0, 4)
    : [];
  const lines = [packet.summary];

  if (goal) {
    lines.push(`Goal: ${goal}`);
  }

  return sanitizeGatewayText([...lines, ...completedTasks, ...recentSuccessfulResults].join("\n"));
}

function renderMemoryHotsetBody(packet: MaterializedPacket): string {
  const details = asRecord(packet.details);
  const projectStatus = asString(details?.projectStatus);
  const globalKnowledge = asStringArray(details?.globalKnowledge)
    .slice(0, 3)
    .map((line) => `- global: ${line}`);
  const facts = asStringArray(details?.facts)
    .slice(0, 3)
    .map((line) => `- fact: ${line}`);
  const conventions = asStringArray(details?.conventions)
    .slice(0, 2)
    .map((line) => `- convention: ${line}`);
  const recentDecisions = asStringArray(details?.recentDecisions)
    .slice(0, 3)
    .map((line) => `- decision: ${line}`);
  const openQuestions = asStringArray(details?.openQuestions)
    .slice(0, 2)
    .map((line) => `- question: ${line}`);
  const lines = [packet.summary];

  if (projectStatus) {
    lines.push(`Project status: ${projectStatus}`);
  }

  return sanitizeGatewayText([
    ...lines,
    ...globalKnowledge,
    ...facts,
    ...conventions,
    ...recentDecisions,
    ...openQuestions,
  ].join("\n"));
}

function renderStaleMemoryBody(packet: MaterializedPacket): string {
  const details = asRecord(packet.details);
  const status = asString(details?.status);
  const reasons = asStringArray(details?.reasons)
    .slice(0, 4)
    .map((line) => `- ${line}`);
  const accessCount = asNumber(details?.accessCount);
  const signalCount = asNumber(details?.signalCount);
  const memoryItems = asNumber(details?.memoryItems);
  const metrics = [
    accessCount != null ? `accesses ${accessCount}` : "",
    signalCount != null ? `signals ${signalCount}` : "",
    memoryItems != null ? `items ${memoryItems}` : "",
  ].filter(Boolean);
  const lines = [packet.summary];

  if (status) {
    lines.push(`Status: ${status}`);
  }

  if (metrics.length > 0) {
    lines.push(metrics.join(" · "));
  }

  if (reasons.length === 0) {
    lines.push("No stale-memory review issues are currently flagged.");
  }

  return sanitizeGatewayText([...lines, ...reasons].join("\n"));
}

function summarizeIdlePacket(
  packet: MaterializedPacket | null,
): GatewayIdlePacketSummary | null {
  if (!packet) {
    return null;
  }

  if (packet.kind === "log-rollup") {
    return {
      id: packet.packetId,
      label: "log rollup",
      kicker: "recent project/feed digest",
      body: renderLogRollupBody(packet),
      tone: "info",
      producedAt: packet.producedAt,
    };
  }

  if (packet.kind === "phase-summary") {
    return {
      id: packet.packetId,
      label: "phase summary",
      kicker: "completed work",
      body: renderPhaseSummaryBody(packet),
      tone: "success",
      producedAt: packet.producedAt,
    };
  }

  if (packet.kind === "memory-hotset") {
    const details = asRecord(packet.details);

    return {
      id: packet.packetId,
      label: "memory hotset",
      kicker: asString(details?.projectStatus) ?? "memory focus",
      body: renderMemoryHotsetBody(packet),
      tone: "info",
      producedAt: packet.producedAt,
    };
  }

  if (packet.kind === "stale-memory") {
    const details = asRecord(packet.details);
    const status = asString(details?.status);

    return {
      id: packet.packetId,
      label: "stale memory",
      kicker: status ?? "memory review",
      body: renderStaleMemoryBody(packet),
      tone: status === "review" ? "warning" : "success",
      producedAt: packet.producedAt,
    };
  }

  return null;
}

type GatewayCompiledFallbackState = {
  boardSummary: BoardSummary;
  openMessagesSummary: OpenMessagesSummary;
  activeRunsSummary: ActiveRunsSummary;
  recentResultsSummary: RecentResultsSummary;
  humanInboxSummary: HumanInboxSummary;
};

async function readGatewayCompiledFallbackState(
  projectPaths: ProjectPaths,
): Promise<GatewayCompiledFallbackState | null> {
  const [
    boardSummary,
    openMessagesSummary,
    activeRunsSummary,
    recentResultsSummary,
    humanInboxSummary,
  ] = await Promise.all([
    readJson<BoardSummary>(projectPaths.stateBoardSummary),
    readJson<OpenMessagesSummary>(projectPaths.stateOpenMessages),
    readJson<ActiveRunsSummary>(projectPaths.stateActiveRuns),
    readJson<RecentResultsSummary>(projectPaths.stateRecentResults),
    readJson<HumanInboxSummary>(projectPaths.stateHumanInbox),
  ]);

  if (
    !boardSummary ||
    !openMessagesSummary ||
    !activeRunsSummary ||
    !recentResultsSummary ||
    !humanInboxSummary
  ) {
    return null;
  }

  return {
    boardSummary,
    openMessagesSummary,
    activeRunsSummary,
    recentResultsSummary,
    humanInboxSummary,
  };
}

function renderGatewayOpenDecisions(state: GatewayCompiledFallbackState): string {
  const waitingOnHuman = state.humanInboxSummary.items
    .filter((item) => item.needsHumanReply)
    .map((item) => item.summary)
    .slice(0, 6);

  if (
    state.boardSummary.blockers.length === 0 &&
    state.boardSummary.decisions.length === 0 &&
    waitingOnHuman.length === 0
  ) {
    return "No open decisions, blockers, or pending human replies.";
  }

  const lines = [
    `Open decisions: ${state.boardSummary.blockers.length} blocker(s), ${state.boardSummary.decisions.length} recent decision(s), ${waitingOnHuman.length} pending human repl${waitingOnHuman.length === 1 ? "y" : "ies"}.`,
  ];
  for (const b of state.boardSummary.blockers.slice(0, 4)) lines.push(`- blocker: ${b}`);
  for (const h of waitingOnHuman.slice(0, 4)) lines.push(`- human: ${h}`);
  return lines.join("\n");
}

function renderGatewayRecentResults(state: GatewayCompiledFallbackState): string {
  if (state.recentResultsSummary.items.length === 0) return "(none)";
  return state.recentResultsSummary.items
    .slice(0, 5)
    .map((item) => `- ${item.agentId} | ${item.status} | ${item.summary || "no visible output"}`)
    .join("\n");
}

function renderGatewayHumanInbox(state: GatewayCompiledFallbackState): string {
  if (state.humanInboxSummary.items.length === 0) return "(none)";
  return state.humanInboxSummary.items
    .slice(0, 6)
    .map((item) => `- ${item.from} -> ${item.to} [${item.type}] ${item.summary}`)
    .join("\n");
}

export async function buildGatewayProjectCognitionSnapshot(input: {
  options: GatewayOptions;
  projectId: string | null;
}): Promise<GatewayProjectCognitionSnapshot | null> {
  if (!input.projectId || input.projectId === "default") {
    return null;
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.projectId);
  const fallbackState = await readGatewayCompiledFallbackState(projectPaths);
  const runtimeState = fallbackState
    ? null
    : await refreshProjectRuntimeState({
      hivePaths: input.options.hivePaths,
      projectId: input.projectId,
      projectPaths,
    });
  const effectiveState = fallbackState ?? {
    boardSummary: runtimeState!.boardSummary,
    openMessagesSummary: runtimeState!.openMessagesSummary,
    activeRunsSummary: runtimeState!.activeRunsSummary,
    recentResultsSummary: runtimeState!.recentResultsSummary,
    humanInboxSummary: runtimeState!.humanInboxSummary,
  };
  const [logRollup, phaseSummary, memoryHotset, staleMemory] = await Promise.all([
    readJson<MaterializedPacket>(getLogRollupPacketPath(projectPaths)),
    readJson<MaterializedPacket>(getPhaseSummaryPacketPath(projectPaths)),
    readJson<MaterializedPacket>(projectPaths.statePacketMemoryHotset),
    readJson<MaterializedPacket>(projectPaths.statePacketStaleMemory),
  ]);

  return {
    workingSetRevision: null,
    workingSetProducedAt: null,
    compilerUpdatedAt: null,
    workingSetDigests: [
      {
        id: "board",
        label: "board",
        body: sanitizeGatewayText(effectiveState.boardSummary.digest),
      },
      {
        id: "open-decisions",
        label: "open decisions",
        body: sanitizeGatewayText(renderGatewayOpenDecisions(effectiveState)),
      },
      {
        id: "open-messages",
        label: "open messages",
        body: sanitizeGatewayText(effectiveState.openMessagesSummary.digest),
      },
      {
        id: "active-runs",
        label: "active runs",
        body: sanitizeGatewayText(effectiveState.activeRunsSummary.digest),
      },
      {
        id: "recent-results",
        label: "recent results",
        body: sanitizeGatewayText(renderGatewayRecentResults(effectiveState)),
      },
      {
        id: "human-inbox",
        label: "human inbox",
        body: sanitizeGatewayText(renderGatewayHumanInbox(effectiveState)),
      },
    ],
    idlePackets: [
      summarizeIdlePacket(logRollup?.kind === "log-rollup" ? logRollup : null),
      summarizeIdlePacket(phaseSummary?.kind === "phase-summary" ? phaseSummary : null),
      summarizeIdlePacket(memoryHotset?.kind === "memory-hotset" ? memoryHotset : null),
      summarizeIdlePacket(staleMemory?.kind === "stale-memory" ? staleMemory : null),
    ].filter((packet): packet is GatewayIdlePacketSummary => packet != null),
  };
}

export async function buildGatewayLiveSnapshot(input: {
  options: GatewayOptions;
  projectId: string | null;
}): Promise<{
  project: string | null;
  sessionId: string | null;
  summary: string | null;
  supervisor: {
    status: string;
    pid: number | null;
    tail: string[];
  } | null;
  agents: GatewayLiveAgent[];
  recentCompletions: GatewayRecentCompletion[];
  activity: GatewayActivityItem[];
}> {
  if (!input.projectId || input.projectId === "default") {
    return {
      project: null,
      sessionId: null,
      summary: null,
      supervisor: null,
      agents: [],
      recentCompletions: [],
      activity: [],
    };
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.projectId);
  const runtimeState = await refreshProjectRuntimeState({
    hivePaths: input.options.hivePaths,
    projectId: input.projectId,
    projectPaths,
  });
  const agentContext = await readProjectAgentContext(projectPaths, input.options.hivePaths.config);
  const [supervisorState, deltaHistory, recentEvents] = await Promise.all([
    reconcileDetachedSupervisorState(projectPaths),
    readStewardDeltaHistory({
      projectPaths,
      limit: 10,
    }),
    listRecentEvents({
      paths: input.options.hivePaths,
      scope: "all",
      limit: 20,
    }),
  ]);

  const agents = await Promise.all(
    runtimeState.activeRuns.map(async (run) => {
      const presentation = resolveAgentPresentation({
        ...agentContext,
        agentId: run.agentId,
      });
      const tail = await readRunOutputTail(run, 50);

      return {
        runId: run.runId,
        agentId: run.agentId,
        displayName: presentation.displayName,
        persona: presentation.persona,
        descriptor: presentation.descriptor,
        status: run.status,
        runtime: run.runtime,
        model: run.model,
        started: run.started,
        pid: run.pid,
        taskId: run.taskId,
        source: run.source,
        latestOutput: tail[tail.length - 1] ?? null,
        tail,
      };
    }),
  );

  const recentCompletions = runtimeState.recentResultsSummary.items.slice(0, 6).map((result) => {
    const presentation = resolveAgentPresentation({
      ...agentContext,
      agentId: result.agentId,
    });

    return {
      runId: result.runId,
      agentId: result.agentId,
      displayName: presentation.displayName,
      persona: presentation.persona,
      descriptor: presentation.descriptor,
      status: result.status,
      ended: result.ended,
      summary: result.summary || result.status,
      changedFiles: result.changedFiles,
      runtime: result.runtime,
      model: result.model,
    };
  });

  const deltaActivities = deltaHistory
    .flatMap((packet) =>
      packet.changes.map((change) =>
        mapDeltaActivity({
          revision: packet.revision,
          ts: packet.ts,
          change,
        }),
      ),
    );
  const eventActivities = recentEvents
    .filter(
      (event) =>
        event.project === input.projectId &&
        (
          event.kind === "approval.requested" ||
          event.kind === "approval.resolved" ||
          event.kind === "event.routed" ||
          event.kind === "memory.extracted" ||
          event.severity !== "info"
        ),
    )
    .map((event) => mapEventActivity(event));
  const activity = [...deltaActivities, ...eventActivities]
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, 12);

  const currentActivity = await buildCurrentActivitySummary({
    options: input.options,
    project: input.projectId,
  });

  return {
    project: input.projectId,
    sessionId: runtimeState.sessionMeta?.sessionId ?? null,
    summary: currentActivity.summary,
    supervisor: supervisorState
      ? {
          status: supervisorState.status,
          pid: supervisorState.pid,
          tail: await readTextTail(supervisorState.logPath, 24),
        }
      : null,
    agents,
    recentCompletions,
    activity,
  };
}

export async function buildGatewayQueueSnapshot(input: {
  options: GatewayOptions;
  projectId: string | null;
}): Promise<{
  project: string | null;
  approvals: ApprovalRequest[];
  waitingOnHuman: ProjectRuntimeState["humanInboxSummary"]["items"];
  incidents: GatewayQueueIncident[];
}> {
  if (!input.projectId || input.projectId === "default") {
    return {
      project: null,
      approvals: [],
      waitingOnHuman: [],
      incidents: [],
    };
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.projectId);
  const [runtimeState, approvals, recentExternalEvents] = await Promise.all([
    refreshProjectRuntimeState({
      hivePaths: input.options.hivePaths,
      projectId: input.projectId,
      projectPaths,
    }),
    listApprovals(input.options.hivePaths, "pending"),
    listRecentEvents({
      paths: input.options.hivePaths,
      scope: "external",
      limit: 30,
    }),
  ]);

  return {
    project: input.projectId,
    approvals: approvals.filter(
      (approval) => approval.project === null || approval.project === input.projectId,
    ),
    waitingOnHuman: runtimeState.humanInboxSummary.items.filter(
      (item) => item.needsHumanReply,
    ),
    incidents: recentExternalEvents
      .filter(
        (event) =>
          event.project === input.projectId &&
          event.severity !== "info",
      )
      .map((event) => ({
        id: event.id,
        ts: event.ts,
        kind: event.kind,
        source: event.source,
        severity: event.severity === "error" ? "error" : "warning",
        summary: event.summary,
        details: event.details,
        routed: event.data.routed === true,
      })),
  };
}

export async function buildGatewayTimeline(input: {
  options: GatewayOptions;
  projectId: string | null;
  count: number;
}): Promise<{
  project: string | null;
  items: GatewayTimelineItem[];
}> {
  const feedText = await Bun.file(input.options.hivePaths.feed).text().catch(() => "");
  const feedItems = parseStructuredFeedEntries(feedText)
    .filter(
      (entry) =>
        !input.projectId ||
        entry.project === null ||
        entry.project === input.projectId,
    )
    .map((entry, index) => ({
      id: `feed-${entry.ts ?? "unknown"}-${index}`,
      ts: entry.ts ?? "",
      source: "feed" as const,
      project: entry.project,
      title: entry.headline,
      details: entry.details,
      tone: classifyTone(`${entry.headline} ${entry.details.join(" ")}`),
    }));
  const eventItems = (await listRecentEvents({
    paths: input.options.hivePaths,
    scope: "all",
    limit: input.count * 2,
  }))
    .filter(
      (event) =>
        !input.projectId ||
        event.project === input.projectId,
    )
    .map((event) => ({
      id: `event-${event.id}`,
      ts: event.ts,
      source: "event" as const,
      project: event.project,
      title: event.summary,
      details: [`${event.kind} · ${event.source}`, ...event.details],
      tone: toneFromSeverity(event.severity),
    }));

  return {
    project: input.projectId,
    items: [...feedItems, ...eventItems]
      .sort((left, right) => right.ts.localeCompare(left.ts))
      .slice(0, input.count),
  };
}

export async function readTextTail(path: string, limit = 50): Promise<string[]> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return [];
  }

  return (await file.text())
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-limit);
}

export function formatActivityTime(iso: string | null): string | null {
  if (!iso) {
    return null;
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeLeadRun(run: RunRecord): string {
  if (run.agentId === "console") {
    return "I'm already working on the current conversation";
  }

  if (run.agentId === "steward") {
    return "The background steward is assessing the project and deciding the next moves";
  }

  return `${run.agentId} is actively working${run.taskId ? ` on ${run.taskId}` : ""}`;
}

export function summarizeRecentResult(input: {
  agentId: string;
  status: string;
  summary: string;
}): string {
  const base = input.agentId === "steward"
    ? "The last completed background steward pass"
    : `The last completed step from ${input.agentId}`;

  if (input.summary.trim()) {
    return `${base}: ${input.summary.trim()}`;
  }

  return `${base} finished with status ${input.status}.`;
}

export async function buildCurrentActivitySummary(input: {
  options: GatewayOptions;
  project: string;
  lead?: string;
}): Promise<{ summary: string; state: ProjectRuntimeState }> {
  const projectPaths = getProjectPaths(input.options.hivePaths, input.project);
  const state = await refreshProjectRuntimeState({
    hivePaths: input.options.hivePaths,
    projectId: input.project,
    projectPaths,
  });
  const activeRuns = state.activeRuns;
  const leadRun =
    activeRuns.find((run) => run.agentId === "console") ??
    activeRuns.find((run) => run.agentId === "steward") ??
    activeRuns[0] ??
    null;
  const lines: string[] = [];

  if (input.lead?.trim()) {
    lines.push(input.lead.trim());
    lines.push("");
  }

  lines.push("Here's what the hive is doing right now:");

  if (leadRun) {
    const since = formatActivityTime(leadRun.started);
    lines.push(
      `- ${describeLeadRun(leadRun)}${since ? ` since ${since}` : ""}.`,
    );

    const leadTail = await readRunOutputTail(leadRun, 6);
    const latestVisibleLine = leadTail[leadTail.length - 1] ?? null;

    if (latestVisibleLine) {
      lines.push(`- Latest visible output: ${latestVisibleLine}`);
    } else if (leadRun.agentId === "console") {
      lines.push("- Live reply generation is still in progress. Waiting for the first streamed update.");
    } else {
      lines.push("- No visible output from that run yet.");
    }
  } else {
    lines.push("- Nothing is actively running at the moment.");
  }

  const workerRuns = activeRuns.filter((run) => run.agentId !== "console" && run.agentId !== "steward");

  if (workerRuns.length > 0) {
    lines.push(
      `- Active workers: ${workerRuns.map((run) => run.taskId ? `${run.agentId} on ${run.taskId}` : run.agentId).join(", ")}.`,
    );
  } else if (activeRuns.some((run) => run.agentId === "steward")) {
    lines.push("- No worker handoffs have been launched yet.");
  }

  const waitingOnHuman = state.humanInboxSummary.items.find((item) => item.needsHumanReply);

  if (waitingOnHuman) {
    lines.push(`- Waiting on you: ${waitingOnHuman.summary}`);
  }

  const recentResult = state.recentResultsSummary.items[0] ?? null;

  if (recentResult) {
    lines.push(`- ${summarizeRecentResult(recentResult)}`);
  }

  if (activeRuns.length === 0 && state.openMessagesSummary.count > 0) {
    lines.push(`- ${state.openMessagesSummary.count} queued coordination item(s) are still open.`);
  }

  return {
    summary: lines.join("\n"),
    state,
  };
}

