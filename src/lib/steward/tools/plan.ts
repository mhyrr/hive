import { Type } from "@mariozechner/pi-ai";

import { planGoal } from "../../dream-planner";
import { extractRepoPath } from "../../project";
import { getProjectPaths, type HivePaths } from "../../paths";

type PlanContext = {
  hivePaths: HivePaths;
  projectId: string;
};

export function createPlanTools(ctx: PlanContext) {
  return [
    {
      name: "plan_goal",
      description:
        "Decompose a goal into 2-6 parallel tasks with non-overlapping scopes. Returns a structured plan. Use this to think through how to break down a large goal before delegating individual tasks.",
      parameters: Type.Object({
        goal: Type.String({
          description: "The goal to decompose into tasks",
        }),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const goal = String(args.goal ?? "").trim();

        if (!goal) {
          throw new Error("goal is required.");
        }

        const projectPaths = getProjectPaths(ctx.hivePaths, ctx.projectId);
        const projectConfig = await Bun.file(projectPaths.config)
          .text()
          .catch(() => "");
        const repoPath = extractRepoPath(projectConfig) ?? undefined;

        const plan = await planGoal(goal, {
          hivePaths: ctx.hivePaths,
          projectId: ctx.projectId,
          projectPaths,
          repoPath,
        });

        const lines: string[] = [];
        lines.push(`Plan: ${plan.goal}`);
        lines.push(`Summary: ${plan.summary}`);
        lines.push(`Tasks: ${plan.tasks.length} | Est. cost: $${plan.costEstimateUsd.toFixed(2)}`);
        lines.push("");

        for (const [i, task] of plan.tasks.entries()) {
          lines.push(`${i + 1}. [${task.agentId}] ${task.title}`);
          if (task.scope.length > 0) {
            lines.push(`   scope: ${task.scope.join(", ")}`);
          }
          lines.push(`   done: ${task.doneCondition}`);
          lines.push(`   assignment: ${task.assignment}`);
          lines.push("");
        }

        lines.push(
          "Use the delegate tool to dispatch each task. Match agentId, scope, and assignment from this plan.",
        );

        return lines.join("\n");
      },
    },
  ];
}
