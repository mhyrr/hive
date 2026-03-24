import { readFileSync } from "node:fs";
import { join } from "node:path";

import { callAnthropic } from "./anthropic-client";
import type { HivePaths, ProjectPaths } from "./paths";

// Sonnet for planning — needs more reasoning than Haiku tactical passes
const PLANNER_MODEL = "claude-3-7-sonnet-20250219";

// Rough cost per task: ~50K input + ~10K output tokens at Sonnet pricing,
// with a 2× safety margin applied in the returned estimate.
const COST_PER_TASK_USD = 0.60;

export type PlannedTask = {
  title: string;
  agentId: string;     // which agent: alpha, beta, gamma, or new craftsman
  scope: string[];     // files/dirs the task may touch
  assignment: string;  // the assignment body
  doneCondition: string;
};

export type DreamPlan = {
  goal: string;
  tasks: PlannedTask[];
  costEstimateUsd: number;
  summary: string;
};

type PlannerConfig = {
  hivePaths: HivePaths;
  projectId: string;
  projectPaths: ProjectPaths;
  /** Repo working directory — used to read CLAUDE.md. Optional. */
  repoPath?: string;
};

const SYSTEM_PROMPT = `You are the planning module for the HIVE multi-agent system. Given a goal and codebase context, decompose the goal into 2-6 atomic, parallel tasks with non-overlapping scopes. Each task must be assignable to one agent and have a concrete, testable done condition.

Output ONLY valid JSON. No prose, no markdown fences. Schema:
{
  "tasks": [
    {
      "title": "short imperative title (< 60 chars)",
      "agentId": "alpha | beta | gamma",
      "scope": ["src/commands/foo.ts", "src/lib/bar/"],
      "assignment": "Full multi-sentence assignment body explaining what to build and why.",
      "doneCondition": "Specific binary done condition — not 'implement X' but 'X returns Y given Z'."
    }
  ],
  "summary": "One-paragraph plain-text summary of the overall plan."
}

Rules:
- Assign agents round-robin: alpha, beta, gamma (alpha → beta → gamma → alpha…)
- Scope entries must not overlap across tasks
- Tasks should be parallel — no task should depend on another task's output
- Done conditions must be testable: behavioral, not procedural
- If the goal is too small for 2 tasks, create 2 anyway (split by concern)
- If the goal is too large, cap at 6 tasks and note the cap in the summary`;

function safeRead(path: string, maxChars = 4000): string {
  try {
    return readFileSync(path, "utf-8").slice(0, maxChars);
  } catch {
    return "";
  }
}

function buildPlanningPrompt(opts: {
  goal: string;
  projectId: string;
  boardText: string;
  claudeMdText: string;
}): string {
  const { goal, projectId, boardText, claudeMdText } = opts;

  const boardSection = boardText
    ? `## Current Board\n${boardText.split("\n").slice(0, 50).join("\n")}`
    : "## Current Board\n(unavailable)";

  const codebaseSection = claudeMdText
    ? `## Codebase Context (CLAUDE.md)\n${claudeMdText}`
    : "";

  return `## Project: ${projectId}

## Goal
${goal}

${boardSection}

${codebaseSection}

## Task

Decompose the goal above into 2-6 atomic tasks. Output valid JSON only.`;
}

type RawTaskShape = {
  title?: unknown;
  agentId?: unknown;
  scope?: unknown;
  assignment?: unknown;
  doneCondition?: unknown;
};

function parsePlannerResponse(text: string, goal: string): DreamPlan | null {
  // Strip markdown fences if the model wrapped output anyway
  const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  let parsed: { tasks?: RawTaskShape[]; summary?: string };

  try {
    parsed = JSON.parse(cleaned) as typeof parsed;
  } catch {
    // Try to extract a JSON block from within the text
    const match = cleaned.match(/\{[\s\S]+\}/);

    if (!match) {
      return null;
    }

    try {
      parsed = JSON.parse(match[0]) as typeof parsed;
    } catch {
      return null;
    }
  }

  if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 1) {
    return null;
  }

  const tasks: PlannedTask[] = [];

  for (const raw of parsed.tasks) {
    const title = typeof raw.title === "string" ? raw.title.trim() : null;
    const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : null;
    const assignment = typeof raw.assignment === "string" ? raw.assignment.trim() : null;
    const doneCondition = typeof raw.doneCondition === "string" ? raw.doneCondition.trim() : null;

    if (!title || !agentId || !assignment || !doneCondition) {
      continue; // Skip malformed tasks rather than abort
    }

    const scope = Array.isArray(raw.scope)
      ? (raw.scope as unknown[]).filter((s): s is string => typeof s === "string")
      : [];

    tasks.push({ title, agentId, scope, assignment, doneCondition });
  }

  if (tasks.length < 1) {
    return null;
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : `Plan for: ${goal}`;

  return {
    goal,
    tasks,
    costEstimateUsd: tasks.length * COST_PER_TASK_USD,
    summary,
  };
}

export async function planGoal(
  goalDescription: string,
  config: PlannerConfig,
): Promise<DreamPlan> {
  const boardText = safeRead(config.projectPaths.board);

  // Prefer repo CLAUDE.md if repoPath provided; fall back to docs/CLAUDE.md in hive root
  const claudeMdCandidates = config.repoPath
    ? [join(config.repoPath, "CLAUDE.md"), join(config.repoPath, "docs", "CLAUDE.md")]
    : [];
  const claudeMdText = claudeMdCandidates.reduce<string>(
    (acc, path) => acc || safeRead(path, 3000),
    "",
  );

  const prompt = buildPlanningPrompt({
    goal: goalDescription,
    projectId: config.projectId,
    boardText,
    claudeMdText,
  });

  const text = await callAnthropic({
    model: PLANNER_MODEL,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2000,
    timeoutMs: 60_000,
  });

  const plan = parsePlannerResponse(text, goalDescription);

  if (!plan) {
    throw new Error(`Planner returned unparseable output:\n${text.slice(0, 500)}`);
  }

  return plan;
}
