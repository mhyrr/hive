/**
 * Worker brief builder — assembles a prompt context string for a worker agent.
 *
 * Moved from cognition/worker-brief.ts. Stripped of packet/MaterializedPacket
 * wrapper; produces a plain details object and optional JSON persistence.
 */

import { join } from "node:path";

import { readJson, writeJson } from "./json";
import type { HiveMessage } from "./messages";
import type { ProjectPaths } from "./paths";
import type { PlanAgent, TeamAgent } from "./project";
import { resolveAgentScopeRoots } from "./project";
import type { RunResult } from "./runs";

const MAX_OPEN_MESSAGES = 6;
const MAX_RELEVANT_RESULTS = 5;
const MAX_SUMMARY_CHARS = 220;

function truncateInline(value: string, maxChars = MAX_SUMMARY_CHARS): string {
  const normalized = value.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

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

export type WorkerBriefDetails = {
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

/** @deprecated alias — use WorkerBriefDetails */
export type WorkerBriefPacketDetails = WorkerBriefDetails;

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

function selectRelatedRunResults(input: {
  recentResults: RunResult[];
  scopeRoots: string[] | null;
  assignmentMessage: WorkerBriefMessage | null;
}): WorkerBriefRunResult[] {
  const sorted = [...input.recentResults].sort((left, right) =>
    right.ended.localeCompare(left.ended),
  );

  return sorted
    .filter((result) => {
      return (
        scopeMatchesChangedFiles(input.scopeRoots, result.changedFiles) ||
        (input.assignmentMessage != null &&
          result.assignmentMessage === input.assignmentMessage.filename)
      );
    })
    .slice(0, MAX_RELEVANT_RESULTS)
    .map((result) => ({
      runId: result.runId,
      agentId: result.agentId,
      status: result.status,
      summary: truncateInline(
        result.cognitiveDigest?.summary || result.finalVisibleOutput.split("\n")[0] || "",
      ),
      changedFiles: result.changedFiles,
      assignmentMessage: result.assignmentMessage,
      path: result.path,
    }));
}

export function getWorkerBriefPath(
  projectPaths: ProjectPaths,
  agentId: string,
): string {
  return join(projectPaths.statePacketWorkerBriefsDir, `${agentId}.json`);
}

/** @deprecated alias */
export const getWorkerBriefPacketPath = getWorkerBriefPath;

export async function buildWorkerBrief(input: {
  projectId: string;
  projectPaths: ProjectPaths;
  agentId: string;
  resolvedAgent: PlanAgent | TeamAgent;
  plan: string;
  projectConfig: string;
  openMessages: HiveMessage[];
  recentResults: RunResult[];
  preferredAssignmentMessage?: string | null;
}): Promise<WorkerBriefDetails> {
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
  const relevantRunResults = selectRelatedRunResults({
    recentResults: input.recentResults,
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

  return {
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
  };
}

/**
 * Build and persist a worker brief JSON. Returns the details.
 * This is a thin persistence wrapper around `buildWorkerBrief`.
 */
export async function materializeWorkerBrief(input: {
  projectId: string;
  projectPaths: ProjectPaths;
  agentId: string;
  resolvedAgent: PlanAgent | TeamAgent;
  plan: string;
  projectConfig: string;
  openMessages: HiveMessage[];
  recentResults: RunResult[];
  preferredAssignmentMessage?: string | null;
}): Promise<WorkerBriefDetails> {
  const details = await buildWorkerBrief(input);
  const briefPath = getWorkerBriefPath(input.projectPaths, input.agentId);

  await writeJson(briefPath, details);
  return details;
}

/** @deprecated — use materializeWorkerBrief; this wrapper exists for backward compat */
export async function materializeWorkerBriefPacket(input: {
  projectId: string;
  projectPaths: ProjectPaths;
  agentId: string;
  resolvedAgent: PlanAgent | TeamAgent;
  plan: string;
  projectConfig: string;
  openMessages: HiveMessage[];
  recentResults: RunResult[];
  compilerCacheIndex?: unknown;
  preferredAssignmentMessage?: string | null;
}): Promise<{ details: WorkerBriefDetails }> {
  const details = await materializeWorkerBrief({
    projectId: input.projectId,
    projectPaths: input.projectPaths,
    agentId: input.agentId,
    resolvedAgent: input.resolvedAgent,
    plan: input.plan,
    projectConfig: input.projectConfig,
    openMessages: input.openMessages,
    recentResults: input.recentResults,
    preferredAssignmentMessage: input.preferredAssignmentMessage,
  });
  return { details };
}
