import { type ProjectPaths } from "./paths";
import { createMessage } from "./messages";
import { listRecentRuns } from "./runs";
import { toIsoTimestamp } from "./time";
import { callAnthropic } from "./anthropic-client";
import {
  type WorkGraph,
  type TaskNode,
  readWorkGraph,
  writeWorkGraph,
  createWorkGraph,
  addTaskToGraph,
  getReadyTasks,
  updateTaskNode,
} from "./work-graph";

export type OrchestratorAdvanceResult = {
  dispatched: string[];
  blocked: string[];
  skipped: string[];
  graphComplete: boolean;
};

function inferRuntime(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("opus") || m.includes("sonnet") || m.includes("haiku")) return "claude";
  if (m.includes("gpt")) return "codex";
  if (m.includes("qwen") || m.includes("llama")) return "ollama";
  return "claude";
}

function generateAgentId(persona: string, model: string): string {
  const suffix = crypto.randomUUID().slice(0, 4);
  // Use the short pool name (e.g. "sonnet" not "claude-sonnet-4-6")
  const modelShort = model.split("-")[0] ?? model;
  return `${persona}-${modelShort}-${suffix}`;
}

function isGraphComplete(graph: WorkGraph): boolean {
  return graph.tasks.every((t) => t.status === "done");
}

function isBlocked(graph: WorkGraph, task: TaskNode): boolean {
  if (task.dependsOn.length === 0) return false;
  return task.dependsOn.some((depId) => {
    const dep = graph.tasks.find((t) => t.id === depId);
    return !dep || dep.status !== "done";
  });
}

export async function advanceWorkGraph(input: {
  stateWorkGraph: string;
  msgDir: string;
  projectId: string;
}): Promise<OrchestratorAdvanceResult | null> {
  const graph = await readWorkGraph(input.stateWorkGraph);
  if (!graph) return null;

  const dispatched: string[] = [];
  const blocked: string[] = [];
  const skipped: string[] = [];

  const readyTasks = getReadyTasks(graph);

  for (const task of readyTasks) {
    // Generate a proper persona-model-xxxx agentId so worker brief assembly
    // and the supervisor's scope-conflict detection work correctly.
    const agentId = generateAgentId(task.persona, task.model);

    await createMessage(input.msgDir, {
      from: "orchestrator",
      to: agentId,
      type: "assign",
      project: input.projectId,
      body: task.brief,
      attributes: {
        task: task.title,
        scope: task.scope,
        persona: task.persona,
        runtime: inferRuntime(task.model),
        model: task.model,
        launch: "auto",
        ...(task.verify ? { verify: task.verify } : {}),
      },
    });

    const now = toIsoTimestamp();
    updateTaskNode(graph, task.id, {
      status: "active",
      agentId,   // store the real agentId so reconciliation can match runs
      startedAt: now,
    });

    dispatched.push(task.id);
  }

  // Find blocked tasks: pending with unmet deps (not already active/done/failed)
  for (const task of graph.tasks) {
    if (task.status !== "pending") {
      if (task.status === "active" || task.status === "done" || task.status === "failed") {
        if (!dispatched.includes(task.id)) {
          skipped.push(task.id);
        }
      }
      continue;
    }

    if (isBlocked(graph, task)) {
      blocked.push(task.id);
    }
  }

  graph.updatedAt = toIsoTimestamp();
  await writeWorkGraph(input.stateWorkGraph, graph);

  return {
    dispatched,
    blocked,
    skipped,
    graphComplete: isGraphComplete(graph),
  };
}

export async function reconcileWorkGraphFromRuns(input: {
  stateWorkGraph: string;
  projectPaths: ProjectPaths;
}): Promise<void> {
  const graph = await readWorkGraph(input.stateWorkGraph);
  if (!graph) return;

  const runs = await listRecentRuns(input.projectPaths, 50);
  let changed = false;

  for (const task of graph.tasks) {
    if (task.status !== "active" || !task.agentId) continue;

    // Guard: only match runs that started AFTER this attempt began,
    // so archived failed runs from a previous retry can't replay onto a fresh attempt.
    const run = runs.find(
      (r) =>
        r.agentId === task.agentId &&
        r.ended != null &&
        (task.startedAt == null || new Date(r.started).getTime() >= new Date(task.startedAt).getTime()),
    );
    if (!run) continue;

    if (run.exitCode === 0) {
      updateTaskNode(graph, task.id, {
        status: "done",
        completedAt: run.ended ?? toIsoTimestamp(),
      });
      changed = true;
    } else {
      const attempts = (task.attempts ?? 0) + 1;
      const maxAttempts = task.maxAttempts ?? 3;

      if (attempts >= maxAttempts) {
        updateTaskNode(graph, task.id, {
          attempts,
          status: "failed",
          failureReason: `exit ${run.exitCode}`,
        });
      } else {
        updateTaskNode(graph, task.id, {
          attempts,
          status: "pending",
          agentId: null,
          startedAt: null,
        });
      }
      changed = true;
    }
  }

  if (changed) {
    graph.updatedAt = toIsoTimestamp();
    await writeWorkGraph(input.stateWorkGraph, graph);
  }
}

type PlannedTask = {
  title: string;
  brief: string;
  persona: string;
  model: string;
  scope: string;
  dependsOn: number[];
  verify: string | null;
};

function normalizePlannedTask(task: unknown, fallbackBrief: string, index: number): PlannedTask {
  const raw = task && typeof task === "object" ? (task as Record<string, unknown>) : {};

  const titleRaw = typeof raw.title === "string" ? raw.title.trim() : "";
  const briefRaw = typeof raw.brief === "string" ? raw.brief.trim() : "";
  const personaRaw = typeof raw.persona === "string" ? raw.persona.trim() : "";
  const modelRaw = typeof raw.model === "string" ? raw.model.trim() : "";
  const scopeRaw = typeof raw.scope === "string" ? raw.scope.trim() : "";

  const allowedPersonas = new Set(["architect", "craftsman", "critic", "scout"]);
  const allowedModels = new Set(["sonnet", "haiku", "opus"]);

  const dependsOn =
    Array.isArray(raw.dependsOn)
      ? raw.dependsOn.filter((dep): dep is number => Number.isInteger(dep) && dep >= 0)
      : [];

  const verify =
    typeof raw.verify === "string"
      ? raw.verify.trim() || null
      : raw.verify === null
        ? null
        : null;

  return {
    title: titleRaw || `Task ${index + 1}`,
    brief: briefRaw || fallbackBrief,
    persona: allowedPersonas.has(personaRaw) ? personaRaw : "craftsman",
    model: allowedModels.has(modelRaw) ? modelRaw : "sonnet",
    scope: scopeRaw || "*",
    dependsOn,
    verify,
  };
}

/**
 * Use an LLM to decompose a goal description into a WorkGraph.
 * Returns the created graph (also persisted to stateWorkGraph).
 */
export async function planGoalToGraph(input: {
  goalId: string;
  goal: string;
  stateWorkGraph: string;
  projectConfig: string;
}): Promise<WorkGraph> {
  const responseText = await callAnthropic({
    model: "claude-sonnet-4-6",
    maxTokens: 1024,
    timeoutMs: 15000,
    system:
      "You are a task decomposition engine. Given a goal, return a JSON array of tasks to accomplish it.\n" +
      "Each task object must have these fields:\n" +
      '- title: short task name (string)\n' +
      '- brief: detailed instructions for the worker (string, 2-4 sentences)\n' +
      '- persona: one of "architect" | "craftsman" | "critic" | "scout"\n' +
      '- model: one of "sonnet" | "haiku" | "opus"\n' +
      '- scope: comma-separated file/dir paths the worker should touch, or "*" for whole-repo\n' +
      "- dependsOn: array of 0-based indices of tasks this depends on (empty array if none)\n" +
      "- verify: optional shell command to verify success, or null\n\n" +
      "Return ONLY the JSON array, no other text.",
    messages: [
      {
        role: "user",
        content: `Goal: ${input.goal}\n\nProject config context:\n${input.projectConfig.slice(0, 500)}`,
      },
    ],
  });

  const fallbackTasks: PlannedTask[] = [
    {
      title: "Execute goal",
      brief: input.goal,
      persona: "craftsman",
      model: "sonnet",
      scope: "*",
      dependsOn: [],
      verify: null,
    },
  ];

  let parsedTasks = fallbackTasks;

  try {
    const parsed = JSON.parse(responseText) as unknown;
    const taskArray = Array.isArray(parsed) ? parsed : null;

    if (taskArray) {
      const normalized = taskArray.map((task, index) => normalizePlannedTask(task, input.goal, index));
      if (normalized.length > 0) {
        parsedTasks = normalized;
      }
    }
  } catch {
    parsedTasks = fallbackTasks;
  }

  const graph = createWorkGraph(input.goalId, "fan-out");
  const addedNodes: TaskNode[] = [];

  for (const task of parsedTasks) {
    const node = addTaskToGraph(graph, {
      goalId: input.goalId,
      title: task.title,
      brief: task.brief,
      persona: task.persona,
      model: task.model,
      scope: task.scope,
      verify: task.verify,
      dependsOn: [],
    });
    addedNodes.push(node);
  }

  for (let i = 0; i < parsedTasks.length; i++) {
    const task = parsedTasks[i];
    const node = addedNodes[i];
    if (!task || !node) continue;

    const resolvedDependsOn = task.dependsOn
      .map((index) => addedNodes[index]?.id ?? null)
      .filter((id): id is string => Boolean(id));

    updateTaskNode(graph, node.id, { dependsOn: resolvedDependsOn });
  }

  await writeWorkGraph(input.stateWorkGraph, graph);
  return graph;
}
