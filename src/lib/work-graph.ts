import { mkdir } from "fs/promises";
import { dirname } from "path";
import { toIsoTimestamp } from "./time";

export type TaskNodeStatus = "pending" | "active" | "done" | "failed" | "blocked";

export type TaskTopology = "pipeline" | "fan-out" | "swarm";

export type TaskNode = {
  id: string;
  goalId: string;
  title: string;
  brief: string;
  status: TaskNodeStatus;
  persona: string;
  model: string;
  scope: string;
  verify: string | null;
  dependsOn: string[];
  agentId: string | null;
  runId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  attempts: number;
  maxAttempts: number;
};

export type WorkGraph = {
  goalId: string;
  topology: TaskTopology;
  tasks: TaskNode[];
  createdAt: string;
  updatedAt: string;
};

export async function readWorkGraph(stateWorkGraph: string): Promise<WorkGraph | null> {
  try {
    const file = Bun.file(stateWorkGraph);
    if (!(await file.exists())) return null;
    const text = await file.text();
    return JSON.parse(text) as WorkGraph;
  } catch {
    return null;
  }
}

export async function writeWorkGraph(stateWorkGraph: string, graph: WorkGraph): Promise<void> {
  await mkdir(dirname(stateWorkGraph), { recursive: true });
  await Bun.write(stateWorkGraph, JSON.stringify(graph, null, 2));
}

export function createWorkGraph(goalId: string, topology: TaskTopology): WorkGraph {
  const now = toIsoTimestamp();
  return {
    goalId,
    topology,
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function addTaskToGraph(
  graph: WorkGraph,
  input: {
    goalId: string;
    title: string;
    brief: string;
    persona: string;
    model: string;
    scope: string;
    verify?: string | null;
    dependsOn?: string[];
    maxAttempts?: number;
  }
): TaskNode {
  const node: TaskNode = {
    id: crypto.randomUUID(),
    goalId: input.goalId,
    title: input.title,
    brief: input.brief,
    status: "pending",
    persona: input.persona,
    model: input.model,
    scope: input.scope,
    verify: input.verify ?? null,
    dependsOn: input.dependsOn ?? [],
    agentId: null,
    runId: null,
    startedAt: null,
    completedAt: null,
    failureReason: null,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
  };
  graph.tasks.push(node);
  graph.updatedAt = toIsoTimestamp();
  return node;
}

export function updateTaskNode(graph: WorkGraph, id: string, patch: Partial<TaskNode>): void {
  const node = graph.tasks.find((t) => t.id === id);
  if (!node) return;
  Object.assign(node, patch);
  graph.updatedAt = toIsoTimestamp();
}

export function getReadyTasks(graph: WorkGraph): TaskNode[] {
  const doneIds = new Set(graph.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return graph.tasks.filter(
    (t) => t.status === "pending" && t.dependsOn.every((dep) => doneIds.has(dep))
  );
}

export function isGraphComplete(graph: WorkGraph): boolean {
  return graph.tasks.every((t) => t.status === "done" || t.status === "failed");
}

export function isGraphFailed(graph: WorkGraph): boolean {
  const hasFailed = graph.tasks.some((t) => t.status === "failed");
  const hasActive = graph.tasks.some((t) => t.status === "active" || t.status === "pending");
  return hasFailed && !hasActive;
}
