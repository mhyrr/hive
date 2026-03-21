import type { BoardSummary, RecentResultsSummary } from "../../state";
import type { CompileTask } from "../packets";
import { fingerprintParts } from "../packets";
import { DEFAULT_PACKET_FRESHNESS_MS, truncateInline } from "./shared";

export type PhaseSummaryInput = {
  projectId: string;
  plan: string;
  boardSummary: BoardSummary;
  recentResultsSummary: RecentResultsSummary;
};

export type PhaseSummaryData = {
  goal: string | null;
  completedTasks: string[];
  recentSuccessfulResults: Array<{
    agentId: string;
    summary: string;
    runId: string;
  }>;
};

function extractGoal(plan: string): string | null {
  const match = plan.match(/^## Goal\s*\n([\s\S]*?)(?=^##\s|\Z)/m);
  const goal = match?.[1]?.trim() ?? "";

  return goal && goal !== "Describe the current mission." ? truncateInline(goal, 220) : null;
}

export const phaseSummaryTask: CompileTask<PhaseSummaryInput, PhaseSummaryData> = {
  id: "phase-summary",
  kind: "phase-summary",
  trigger: "idle",
  freshnessMs: DEFAULT_PACKET_FRESHNESS_MS,
  priority: "background",
  shouldRun(input) {
    return (
      input.boardSummary.tasks.some((task) => task.status === "done") ||
      input.recentResultsSummary.items.some(
        (item) => item.status === "exited" && item.cognitiveOutcome !== "failed",
      )
    );
  },
  fingerprint(input) {
    return fingerprintParts(
      "phase-summary",
      input.projectId,
      input.plan,
      input.boardSummary.tasks,
      input.recentResultsSummary.items.map((item) => ({
        runId: item.runId,
        status: item.status,
        summary: item.summary,
        outcome: item.cognitiveOutcome,
      })),
    );
  },
  classify() {
    return "deterministic";
  },
  async run(input) {
    return {
      goal: extractGoal(input.plan),
      completedTasks: input.boardSummary.tasks
        .filter((task) => task.status === "done")
        .map((task) => task.summary)
        .slice(0, 8),
      recentSuccessfulResults: input.recentResultsSummary.items
        .filter((item) => item.status === "exited" && item.cognitiveOutcome !== "failed")
        .slice(0, 6)
        .map((item) => ({
          agentId: item.agentId,
          summary: truncateInline(item.summary, 220),
          runId: item.runId,
        })),
    };
  },
};
