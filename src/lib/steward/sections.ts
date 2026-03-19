import type { HiveMessage } from "../messages";
import type { HivePaths, ProjectPaths } from "../paths";
import type { RunRecord, RunResult } from "../runs";
import type { getSessionHistory } from "../sessions";
import type { ProjectRuntimeState } from "../state";
import { formatRuntimeTokenSummary, listRuntimeAdapters } from "../runtime";

export type DeltaHistoryEntry = {
  revision: number;
  changes: string[];
};

export function renderPathList(
  title: string,
  items: Array<{ label: string; value: string }>,
): string {
  return [`## ${title}`, ...items.map((item) => `- ${item.label}: ${item.value}`)].join("\n");
}

export function renderRecentTurns(
  turns: Awaited<ReturnType<typeof getSessionHistory>>,
  limit = 8,
): string {
  const recent = turns.slice(-limit);

  if (recent.length === 0) {
    return "(no prior conversation)";
  }

  return recent
    .map((turn) => `### ${turn.role} (${turn.ts})\n${turn.content}`)
    .join("\n\n");
}

export function renderDeltaHistory(
  deltaHistory: DeltaHistoryEntry[],
  lastSeenRevision: number,
): string {
  if (lastSeenRevision === 0 || deltaHistory.length === 0) {
    return "(bootstrap: no prior session revision)";
  }

  return deltaHistory
    .map((entry) =>
      [`### revision ${entry.revision}`, ...entry.changes.map((change) => `- ${change}`)].join("\n"),
    )
    .join("\n\n");
}

export function renderRecentResultsDigest(
  items: ProjectRuntimeState["recentResultsSummary"]["items"],
): string {
  if (items.length === 0) {
    return "(none)";
  }

  return items
    .slice(0, 5)
    .map((item) => `- ${item.agentId} | ${item.status} | ${item.summary || "no visible output"}`)
    .join("\n");
}

export function renderHumanInboxDigest(
  items: ProjectRuntimeState["humanInboxSummary"]["items"],
): string {
  if (items.length === 0) {
    return "(none)";
  }

  return items
    .slice(0, 6)
    .map((item) => `- ${item.from} -> ${item.to} [${item.type}] ${item.summary}`)
    .join("\n");
}

export function renderCompactState(input: {
  boardDigest: string;
  openMessagesDigest: string;
  activeRunsDigest: string;
  recentResultsDigest: string;
  humanInboxDigest: string;
  heading?: string;
}): string {
  return [
    `## ${input.heading ?? "Compact State"}`,
    "### Board",
    input.boardDigest,
    "",
    "### Open Messages",
    input.openMessagesDigest,
    "",
    "### Active Runs",
    input.activeRunsDigest,
    "",
    "### Recent Results",
    input.recentResultsDigest,
    "",
    "### Human Inbox",
    input.humanInboxDigest,
  ].join("\n");
}

export function renderDurableMemory(input: {
  knowledgeDigest?: string | null;
  recentDecisionsDigest: string;
  projectEntityDigest: string;
}): string {
  const lines = ["## Durable Memory"];

  if (input.knowledgeDigest != null) {
    lines.push("### Global Knowledge", input.knowledgeDigest, "");
  }

  lines.push("### Recent Decisions", input.recentDecisionsDigest, "");
  lines.push("### Project Entity Memory", input.projectEntityDigest);
  return lines.join("\n");
}

export function renderMessages(messages: HiveMessage[]): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages.map((message) => `### ${message.filename}\n${message.raw}`).join("\n\n");
}

export function renderList(items: string[]): string {
  if (items.length === 0) {
    return "- (none)";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export async function renderAvailableRuntimes(): Promise<string> {
  const adapters = listRuntimeAdapters();
  const lines: string[] = [];

  for (const adapter of adapters) {
    const installed = await adapter.detectInstalled();
    const status = installed ? "installed" : "not installed";
    const aliases = adapter.aliases.length ? ` (aliases: ${adapter.aliases.join(", ")})` : "";
    lines.push(`- ${adapter.name}: ${status}${aliases}`);
  }

  lines.push("");
  lines.push("To assign a specific runtime to an agent, include `runtime: <name>` in the assignment message frontmatter.");
  lines.push("The team config may also specify runtimes via `agent: persona via <runtime>` syntax.");

  return lines.join("\n");
}

export function renderActiveRuns(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "(none)";
  }

  return runs
    .map((run) =>
      [
        `### ${run.agentId}`,
        `status: ${run.status}`,
        `runtime: ${run.runtime}${run.model ? ` (${run.model})` : ""}`,
        `started: ${run.started}`,
        `pid: ${run.pid ?? "unknown"}`,
        `scope: ${run.scope?.join(", ") || "*"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function renderRunResults(results: RunResult[]): string {
  if (results.length === 0) {
    return "(none)";
  }

  return results
    .map((result) => {
      const lines = [
        `### ${result.runId} (${result.agentId})`,
        `status: ${result.status}`,
        `exit-code: ${result.exitCode ?? "unknown"}`,
        `assignment: ${result.assignmentMessage ?? "(none)"}`,
        `assignment-status-after-exit: ${result.assignmentStatusAfterExit ?? "(none)"}`,
        `assignment-resolved-by-worker: ${result.assignmentResolvedByWorker ? "yes" : "no"}`,
        `files-changed: ${result.changedFiles.join(", ") || "(none detected)"}`,
        `git-summary: ${result.gitSummaryLines.join("; ") || "(none detected)"}`,
      ];

      if (
        result.authMode ||
        result.durationMs ||
        result.numTurns ||
        result.costUsd ||
        result.inputTokens ||
        result.outputTokens ||
        result.cacheCreationInputTokens ||
        result.cacheReadInputTokens ||
        result.totalTokens
      ) {
        const usage: string[] = [];

        if (result.authMode) {
          usage.push(`auth ${result.authMode}`);
        }

        if (result.durationMs) {
          usage.push(`${(result.durationMs / 1000).toFixed(1)}s`);
        }

        if (result.numTurns) {
          usage.push(`${result.numTurns} turns`);
        }

        const tokenSummary = formatRuntimeTokenSummary({
          authMode: result.authMode ?? "unknown",
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          durationApiMs: null,
          numTurns: result.numTurns,
          sessionId: null,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          totalTokens: result.totalTokens,
        });

        if (tokenSummary) {
          usage.push(tokenSummary);
        }

        if (result.costUsd) {
          usage.push(`$${result.costUsd.toFixed(4)}`);
        }

        lines.push(`usage: ${usage.join(" | ")}`);
      }

      lines.push("final-visible-output:", result.finalVisibleOutput || "(none)");

      return lines.join("\n");
    })
    .join("\n\n");
}

export function renderStewardProjectPaths(input: {
  hivePaths: Pick<HivePaths, "msgDir">;
  projectPaths: ProjectPaths;
  memorySummaryPath: string;
  memoryHeatPath: string;
  recentDecisionsPath: string;
  projectEntitySummaryPath: string;
  journalPath: string;
}): string {
  return renderPathList("Project", [
    { label: "repo", value: input.projectPaths.root },
    { label: "project-config", value: input.projectPaths.config },
    { label: "PLAN.md", value: input.projectPaths.plan },
    { label: "BOARD.md", value: input.projectPaths.board },
    { label: "LOG.md", value: input.projectPaths.log },
    { label: "project-memory", value: input.projectPaths.memory },
    { label: "memory-summary-json", value: input.memorySummaryPath },
    { label: "memory-heat-json", value: input.memoryHeatPath },
    { label: "recent-decisions-json", value: input.recentDecisionsPath },
    { label: "project-entity-summary", value: input.projectEntitySummaryPath },
    { label: "journal", value: input.journalPath },
    { label: "messages-dir", value: input.hivePaths.msgDir },
    { label: "state-dir", value: input.projectPaths.stateDir },
    { label: "board-summary-json", value: input.projectPaths.stateBoardSummary },
    { label: "open-messages-json", value: input.projectPaths.stateOpenMessages },
    { label: "active-runs-json", value: input.projectPaths.stateActiveRuns },
    { label: "recent-results-json", value: input.projectPaths.stateRecentResults },
    { label: "human-inbox-json", value: input.projectPaths.stateHumanInbox },
    { label: "latest-delta-json", value: input.projectPaths.stateStewardDelta },
    { label: "delta-history-jsonl", value: input.projectPaths.stateDeltaHistory },
  ]);
}
