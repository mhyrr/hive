import { basename } from "node:path";

import { callAnthropic } from "./anthropic-client";
import { createMessage } from "./messages";
import type { HivePaths, ProjectPaths } from "./paths";
import { listRecentRuns } from "./runs";
import { toIsoTimestamp } from "./time";
import {
  type TaskNode,
  type WorkGraph,
  createWorkGraph,
  getReadyTasks,
  readWorkGraph,
  updateTaskNode,
} from "./work-graph";

export type OrchestratorConfig = {
  projectId: string;
  projectPaths: ProjectPaths;
  hivePaths: HivePaths;
  maxParallel?: number;
};

export type AdvanceResult = {
  dispatched: TaskNode[];
  completed: TaskNode[];
  failed: TaskNode[];
  blocked: string[];
};

/**
 * Deterministically advance the work graph — no model calls.
 *
 * 1. For each active task: check whether its agent's run completed.
 *    exited → done, failed/cancelled → failed.
 * 2. Dispatch ready tasks up to (maxParallel - activeCount) slots.
 * 3. Identify tasks newly blocked by a failed dependency.
 */
export async function advanceWorkGraph(config: OrchestratorConfig): Promise<AdvanceResult> {
  const { projectPaths, hivePaths, projectId, maxParallel = 3 } = config;
  const result: AdvanceResult = { dispatched: [], completed: [], failed: [], blocked: [] };

  const graph = await readWorkGraph(projectPaths);

  if (!graph) {
    return result;
  }

  // Resolve active tasks against recent archived runs.
  // listRecentRuns returns completed (non-active) runs newest-first.
  const recentRuns = await listRecentRuns(projectPaths, 50);
  const activeTasks = graph.tasks.filter((t) => t.status === "active");

  for (const task of activeTasks) {
    if (!task.agentId) {
      continue;
    }

    const completedRun = recentRuns.find((r) => r.agentId === task.agentId);

    if (!completedRun) {
      continue;
    }

    if (completedRun.status === "exited") {
      await updateTaskNode(projectPaths, task.id, {
        status: "done",
        runId: completedRun.runId,
      });
      result.completed.push({ ...task, status: "done" });
    } else if (completedRun.status === "failed" || completedRun.status === "cancelled") {
      await updateTaskNode(projectPaths, task.id, {
        status: "failed",
        runId: completedRun.runId,
      });
      result.failed.push({ ...task, status: "failed" });
    }
  }

  // Re-read after updates to get fresh state.
  const updatedGraph = await readWorkGraph(projectPaths);

  if (!updatedGraph) {
    return result;
  }

  const stillActive = updatedGraph.tasks.filter((t) => t.status === "active").length;
  const slots = maxParallel - stillActive;

  if (slots > 0) {
    const ready = getReadyTasks(updatedGraph).slice(0, slots);

    for (const task of ready) {
      const agentId = task.agentId ?? `worker-${task.id.slice(0, 8)}`;

      await createMessage(hivePaths.msgDir, {
        from: "orchestrator",
        to: agentId,
        type: "assign",
        project: projectId,
        body: task.description,
        attributes: {
          task: task.id,
          launch: "auto",
          ...(task.scope?.length ? { scope: task.scope.join(",") } : {}),
          ...(task.model ? { model: task.model } : {}),
          ...(task.persona ? { persona: task.persona } : {}),
        },
      });

      await updateTaskNode(projectPaths, task.id, { status: "active", agentId });
      result.dispatched.push({ ...task, status: "active", agentId });
    }
  }

  // Surface tasks blocked by a failed dependency.
  const finalGraph = await readWorkGraph(projectPaths);

  if (finalGraph) {
    const failedIds = new Set(finalGraph.tasks.filter((t) => t.status === "failed").map((t) => t.id));

    const blocked = finalGraph.tasks.filter(
      (t) =>
        t.status === "pending" &&
        t.dependsOn?.some((dep) => failedIds.has(dep)),
    );

    result.blocked = blocked.map((t) => t.id);
  }

  return result;
}

/**
 * Ask claude-sonnet-4-6 to decompose a goal into 2-5 tasks, persist as a
 * WorkGraph, and return it.
 */
export async function planGoalToGraph(
  goal: string,
  projectPaths: ProjectPaths,
  hivePaths: HivePaths,
): Promise<WorkGraph> {
  // hivePaths is available for future use (e.g. reading personas/config).
  void hivePaths;

  const projectId = basename(projectPaths.root);

  const responseText = await callAnthropic({
    model: "claude-sonnet-4-6",
    system: [
      "You are a task planner. Decompose the goal into 2 to 5 concrete, independently executable tasks.",
      "Respond with a JSON array only — no markdown fences, no prose.",
      "Each element: { description: string, scope: string[] | null, model: string | null, persona: string | null, dependsOn: number[] | null }",
      "dependsOn contains zero-based indices of tasks that must complete before this one starts.",
    ].join("\n"),
    messages: [{ role: "user", content: `Goal: ${goal}` }],
    maxTokens: 2000,
    timeoutMs: 30_000,
  });

  const cleaned = responseText.replace(/^```[^\n]*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  type RawTask = {
    description: string;
    scope?: string[] | null;
    model?: string | null;
    persona?: string | null;
    dependsOn?: number[] | null;
  };

  let rawTasks: RawTask[];

  try {
    rawTasks = JSON.parse(cleaned) as RawTask[];
  } catch {
    // Fallback: treat the whole goal as one task.
    rawTasks = [{ description: goal }];
  }

  const ts = toIsoTimestamp();
  const tempIds = rawTasks.map(() => crypto.randomUUID());

  const tasks: TaskNode[] = rawTasks.map((raw, idx) => ({
    id: tempIds[idx],
    description: raw.description,
    status: "pending" as const,
    scope: raw.scope ?? undefined,
    model: raw.model ?? undefined,
    persona: raw.persona ?? undefined,
    dependsOn: raw.dependsOn?.map((i) => tempIds[i]).filter(Boolean) ?? undefined,
    createdAt: ts,
    updatedAt: ts,
  }));

  return createWorkGraph(projectPaths, { projectId, objective: goal, tasks });
}
