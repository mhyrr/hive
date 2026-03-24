import type { ProjectPaths } from "./paths";
import { toIsoTimestamp } from "./time";

export type TaskNode = {
  id: string;
  goalId?: string;
  description: string;
  status: "pending" | "active" | "done" | "failed" | "blocked";
  agentId?: string;
  runId?: string;
  scope?: string[];
  model?: string;
  persona?: string;
  dependsOn?: string[];
  reviewRequired?: boolean;
  result?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkGraph = {
  projectId: string;
  goalId?: string;
  objective?: string;
  tasks: TaskNode[];
  createdAt: string;
  updatedAt: string;
};

export async function readWorkGraph(projectPaths: ProjectPaths): Promise<WorkGraph | null> {
  const file = Bun.file(projectPaths.stateWorkGraph);

  if (!(await file.exists())) {
    return null;
  }

  try {
    return JSON.parse(await file.text()) as WorkGraph;
  } catch {
    return null;
  }
}

export async function writeWorkGraph(projectPaths: ProjectPaths, graph: WorkGraph): Promise<void> {
  await Bun.write(projectPaths.stateWorkGraph, JSON.stringify(graph, null, 2));
}

export async function createWorkGraph(
  projectPaths: ProjectPaths,
  init: { projectId: string; goalId?: string; objective?: string; tasks?: TaskNode[] },
): Promise<WorkGraph> {
  const ts = toIsoTimestamp();
  const graph: WorkGraph = {
    projectId: init.projectId,
    goalId: init.goalId,
    objective: init.objective,
    tasks: init.tasks ?? [],
    createdAt: ts,
    updatedAt: ts,
  };

  await writeWorkGraph(projectPaths, graph);

  return graph;
}

export async function addTaskToGraph(
  projectPaths: ProjectPaths,
  task: Omit<TaskNode, "id" | "createdAt" | "updatedAt">,
): Promise<TaskNode> {
  const graph = (await readWorkGraph(projectPaths)) ?? {
    projectId: "unknown",
    tasks: [],
    createdAt: toIsoTimestamp(),
    updatedAt: toIsoTimestamp(),
  };

  const ts = toIsoTimestamp();
  const newTask: TaskNode = {
    ...task,
    id: crypto.randomUUID(),
    createdAt: ts,
    updatedAt: ts,
  };

  graph.tasks.push(newTask);
  graph.updatedAt = ts;

  await writeWorkGraph(projectPaths, graph);

  return newTask;
}

export async function updateTaskNode(
  projectPaths: ProjectPaths,
  taskId: string,
  updates: Partial<TaskNode>,
): Promise<void> {
  const graph = await readWorkGraph(projectPaths);

  if (!graph) {
    return;
  }

  const idx = graph.tasks.findIndex((t) => t.id === taskId);

  if (idx === -1) {
    return;
  }

  const ts = toIsoTimestamp();

  graph.tasks[idx] = { ...graph.tasks[idx], ...updates, updatedAt: ts };
  graph.updatedAt = ts;

  await writeWorkGraph(projectPaths, graph);
}

export function getReadyTasks(graph: WorkGraph): TaskNode[] {
  const doneIds = new Set(graph.tasks.filter((t) => t.status === "done").map((t) => t.id));

  return graph.tasks.filter((t) => {
    if (t.status !== "pending") {
      return false;
    }

    if (!t.dependsOn?.length) {
      return true;
    }

    return t.dependsOn.every((dep) => doneIds.has(dep));
  });
}

export function isGraphComplete(graph: WorkGraph): boolean {
  return graph.tasks.every((t) => t.status === "done" || t.status === "failed");
}
