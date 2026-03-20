/**
 * Simplified context assembly for the steward.
 *
 * Replaces the cognition packet/workbench/working-set system with direct
 * rendering from runtime state summaries.
 */

import type { ProjectPaths } from "./paths";
import type {
  ActiveRunsSummary,
  BoardSummary,
  HumanInboxSummary,
  OpenMessagesSummary,
  ProjectRuntimeState,
  RecentResultsSummary,
  StewardDeltaChange,
  StewardDeltaPacket,
} from "./state";

// ---------------------------------------------------------------------------
// Bootstrap context — full snapshot for cold-start / first turn
// ---------------------------------------------------------------------------

export type BootstrapContextInput = {
  projectId: string;
  runtimeState: ProjectRuntimeState;
  projectMemory?: string | null;
  logRollupDigest?: string | null;
  phaseSummaryDigest?: string | null;
  memoryHotsetDigest?: string | null;
  staleMemoryDigest?: string | null;
};

/**
 * Assemble a full text snapshot from project runtime state.
 *
 * This replaces `buildCompiledStateView` + `materializeProjectCognition` —
 * it renders the same digests that `renderCompactState` in sections.ts
 * consumes, but directly from the summaries that `refreshProjectRuntimeState`
 * already produces.
 */
export function buildBootstrapContext(input: BootstrapContextInput): string {
  const state = input.runtimeState;

  const sections: string[] = [
    "## Compact State",
    "",
    "### Board",
    state.boardSummary.digest,
    "",
    "### Open Decisions",
    renderOpenDecisions(state.boardSummary, state.humanInboxSummary),
    "",
    "### Open Messages",
    state.openMessagesSummary.digest,
    "",
    "### Active Runs",
    state.activeRunsSummary.digest,
    "",
    "### Recent Results",
    renderRecentResults(state.recentResultsSummary),
    "",
    "### Human Inbox",
    renderHumanInbox(state.humanInboxSummary),
  ];

  if (input.phaseSummaryDigest) {
    sections.push("", "### Plan Progress", input.phaseSummaryDigest);
  }

  if (input.logRollupDigest) {
    sections.push("", "### Recent Activity", input.logRollupDigest);
  }

  if (input.memoryHotsetDigest) {
    sections.push("", "### Memory Snapshot", input.memoryHotsetDigest);
  }

  if (input.staleMemoryDigest) {
    sections.push("", "### Stale Memory", input.staleMemoryDigest);
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Delta context — lightweight string for warm turns
// ---------------------------------------------------------------------------

export type DeltaChange = {
  type:
    | "human-message"
    | "run-completed"
    | "message-resolved"
    | "board-changed"
    | "run-started"
    | "run-finished"
    | "message-opened"
    | "message-cleared"
    | "message-updated"
    | "worker-result"
    | "steward-result"
    | "session-update";
  summary: string;
  agent?: string;
  task?: string;
  runId?: string;
  filename?: string;
  path?: string;
};

/**
 * Format delta changes into a simple human-readable string.
 * Replaces the packet-based diff-triage + working-set delta rendering.
 */
export function buildDeltaContext(changes: DeltaChange[]): string {
  if (changes.length === 0) {
    return "(no changes since last seen)";
  }

  return changes
    .map((change) => {
      switch (change.type) {
        case "human-message":
          return `Human said: ${change.summary}`;
        case "worker-result":
        case "steward-result":
        case "run-completed":
          return `${change.agent ?? "Worker"} completed: ${change.summary}`;
        case "run-started":
          return `Run started: ${change.summary}`;
        case "run-finished":
          return `Run finished: ${change.summary}`;
        case "message-resolved":
        case "message-cleared":
          return `Message resolved: ${change.summary}`;
        case "board-changed":
          return `Board updated: ${change.summary}`;
        case "message-opened":
          return `Message opened: ${change.summary}`;
        case "message-updated":
          return `Message updated: ${change.summary}`;
        case "session-update":
          return `Session: ${change.summary}`;
        default:
          return change.summary;
      }
    })
    .map((line) => `- ${line}`)
    .join("\n");
}

/**
 * Convert a StewardDeltaPacket (from state.ts) into DeltaChange array.
 */
export function deltaChangesFromPacket(packet: StewardDeltaPacket): DeltaChange[] {
  return packet.changes.map((change) => ({
    type: change.type as DeltaChange["type"],
    summary: change.summary,
    agent: change.agent,
    task: change.task,
    runId: change.runId,
    filename: change.filename,
    path: change.path,
  }));
}

// ---------------------------------------------------------------------------
// Helpers — rendering digests from runtime state summaries
// ---------------------------------------------------------------------------

function renderOpenDecisions(
  boardSummary: BoardSummary,
  humanInboxSummary: HumanInboxSummary,
): string {
  const waitingOnHuman = humanInboxSummary.items
    .filter((item) => item.needsHumanReply)
    .map((item) => item.summary)
    .slice(0, 6);

  if (
    boardSummary.blockers.length === 0 &&
    boardSummary.decisions.length === 0 &&
    waitingOnHuman.length === 0
  ) {
    return "No open decisions, blockers, or pending human replies.";
  }

  const lines = [
    `Open decisions: ${boardSummary.blockers.length} blocker(s), ${boardSummary.decisions.length} recent decision(s), ${waitingOnHuman.length} pending human repl${waitingOnHuman.length === 1 ? "y" : "ies"}.`,
  ];

  for (const blocker of boardSummary.blockers.slice(0, 4)) {
    lines.push(`- blocker: ${blocker}`);
  }

  for (const item of waitingOnHuman.slice(0, 4)) {
    lines.push(`- human: ${item}`);
  }

  return lines.join("\n");
}

function renderRecentResults(
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

function renderHumanInbox(
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
