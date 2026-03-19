import { dirname, join } from "node:path";

import type { GatewayOptions } from "./server";

import { listApprovals, type ApprovalRequest } from "../lib/approvals";
import { reconcileDetachedSupervisorState } from "../lib/detached-supervisor";
import { listRecentEvents, type EventRecord } from "../lib/events";
import { parseStructuredFeedEntries } from "../lib/feed";
import { getProjectPaths, type ProjectPaths } from "../lib/paths";
import {
  findPlanAgent,
  parseDefaultTeam,
  stripRuntimeHintsFromDescriptor,
} from "../lib/project";
import {
  readRunOutputTail,
  readRunRecord,
  type RunRecord,
  type RunResult,
} from "../lib/runs";
import {
  readStewardDeltaHistory,
  refreshProjectRuntimeState,
  type ProjectRuntimeState,
} from "../lib/state";

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

export async function readProjectAgentContext(projectPaths: ProjectPaths): Promise<{
  plan: string;
  projectConfig: string;
}> {
  const [plan, projectConfig] = await Promise.all([
    Bun.file(projectPaths.plan).text().catch(() => ""),
    Bun.file(projectPaths.config).text().catch(() => ""),
  ]);

  return { plan, projectConfig };
}

function resolveAgentPresentation(input: {
  plan: string;
  projectConfig: string;
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
  const agentContext = await readProjectAgentContext(projectPaths);
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
      const tail = await readRunOutputTail(run, 12);

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

  const recentCompletions = await Promise.all(
    runtimeState.recentResultsSummary.items.slice(0, 6).map(async (result) => {
      const run = await readRunRecordForResult(result);
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
        runtime: run?.runtime ?? null,
        model: run?.model ?? null,
      };
    }),
  );

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

async function readRunRecordForResult(result: RunResult): Promise<RunRecord | null> {
  return readRunRecord(join(dirname(result.path), "run.md"));
}
