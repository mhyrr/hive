import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { callAnthropic } from "./anthropic-client";
import { parseFrontmatter } from "./frontmatter";
import { type GoalRecord, readGoal, writeGoalRecord } from "./goals";
import { createMessage } from "./messages";
import type { HivePaths, ProjectPaths } from "./paths";
import { listActiveRuns, listAllRuns } from "./runs";
import { toIsoTimestamp } from "./time";

export type WaveStatus =
  | { status: "running" }
  | { status: "no-wave" }
  | { status: "complete"; runIds: string[] };

export type RemainingTask = { title: string; scope: string; brief: string };

export type WaveSynthesis = {
  achieved: boolean;
  summary: string;
  remainingTasks?: RemainingTask[];
};

const AGENTS = ["alpha", "beta", "gamma"] as const;

/**
 * Check whether the current wave of a goal has finished.
 * Returns 'no-wave' if no agents were dispatched, 'running' if any are
 * still active or haven't started yet, and 'complete' with run IDs once
 * every wave agent has a completed archived run.
 */
export async function checkGoalWaveCompletion(
  goalId: string,
  projectPaths: ProjectPaths,
  _hivePaths: HivePaths,
): Promise<WaveStatus> {
  const goal = await readGoal(projectPaths.goalsDir, goalId);

  if (!goal || !goal.waveAgents.length) {
    return { status: "no-wave" };
  }

  const activeRuns = await listActiveRuns(projectPaths);
  const activeAgentIds = new Set(activeRuns.map((r) => r.agentId));

  for (const agentId of goal.waveAgents) {
    if (activeAgentIds.has(agentId)) {
      return { status: "running" };
    }
  }

  // No active runs — find the most recent completed run per wave agent
  const allRuns = await listAllRuns(projectPaths);
  const doneStatuses = new Set(["exited", "failed", "cancelled"]);
  const runIds: string[] = [];

  for (const agentId of goal.waveAgents) {
    const completed = allRuns.filter(
      (r) => r.agentId === agentId && doneStatuses.has(r.status),
    );

    if (!completed.length) {
      // Dispatched but hasn't started or finished yet
      return { status: "running" };
    }

    // listAllRuns returns newest-first (sorted by started descending)
    runIds.push(completed[0].runId);
  }

  return { status: "complete", runIds };
}

/**
 * Read the result of each run and ask Claude whether the goal was achieved.
 * Gracefully skips missing run files with a note in the synthesis prompt.
 */
export async function synthesizeWaveResults(
  goal: GoalRecord | null,
  runIds: string[],
  projectPaths: ProjectPaths,
  _hivePaths: HivePaths,
): Promise<WaveSynthesis> {
  if (!goal) {
    return { achieved: false, summary: "Goal not found — cannot synthesize." };
  }

  const allRuns = await listAllRuns(projectPaths);
  const summaries: string[] = [];

  for (const runId of runIds) {
    const run = allRuns.find((r) => r.runId === runId);

    if (!run) {
      summaries.push(`[runId ${runId}: record not found — skipped]`);
      continue;
    }

    const resultPath = run.path.replace(/run\.md$/, "result.md");
    const resultFile = Bun.file(resultPath);

    if (await resultFile.exists()) {
      const text = await resultFile.text();
      const { body } = parseFrontmatter(text);
      summaries.push(
        `### Run ${runId} (agent: ${run.agentId})\n${body.trim().slice(0, 2000)}`,
      );
    } else {
      const runFile = Bun.file(run.path);

      if (await runFile.exists()) {
        const text = await runFile.text();
        summaries.push(
          `### Run ${runId} (agent: ${run.agentId})\n${text.trim().slice(0, 1000)}`,
        );
      } else {
        summaries.push(`[runId ${runId}: file not readable — skipped]`);
      }
    }
  }

  const summaryBlock = summaries.join("\n\n");

  const prompt = `## Goal
${goal.description}

## Wave Results
${summaryBlock}

## Task
Did the agents collectively achieve the goal? Output ONLY valid JSON (no markdown fences):
{"achieved": <true|false>, "summary": "<2-3 sentence synthesis>", "remainingTasks": [{"title": "...", "scope": "...", "brief": "..."}]}

If the goal is achieved, set remainingTasks to []. If not, list remaining work as tasks.`;

  let responseText: string;

  try {
    responseText = await callAnthropic({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1000,
      timeoutMs: 60_000,
    });
  } catch (err) {
    return {
      achieved: false,
      summary: `Synthesis API call failed: ${err instanceof Error ? err.message : String(err)}`,
      remainingTasks: [],
    };
  }

  // Strip markdown fences the model might add despite instructions
  const cleaned = responseText
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  let parsed: { achieved?: boolean; summary?: string; remainingTasks?: RemainingTask[] };

  try {
    parsed = JSON.parse(cleaned) as typeof parsed;
  } catch {
    const match = cleaned.match(/\{[\s\S]+\}/);

    if (match) {
      try {
        parsed = JSON.parse(match[0]) as typeof parsed;
      } catch {
        return {
          achieved: false,
          summary: `Synthesis parse failed. Raw: ${cleaned.slice(0, 200)}`,
        };
      }
    } else {
      return {
        achieved: false,
        summary: `Synthesis returned no JSON. Raw: ${cleaned.slice(0, 200)}`,
      };
    }
  }

  return {
    achieved: Boolean(parsed.achieved),
    summary: typeof parsed.summary === "string" ? parsed.summary : "(no summary)",
    remainingTasks: Array.isArray(parsed.remainingTasks) ? parsed.remainingTasks : [],
  };
}

/**
 * Write assignment messages for the next wave of tasks, then update the
 * goal record with the new wave agents and wave number.
 */
export async function dispatchNextWave(
  goalId: string,
  tasks: RemainingTask[],
  waveNumber: number,
  projectPaths: ProjectPaths,
  hivePaths: HivePaths,
): Promise<string[]> {
  const projectId = basename(projectPaths.root);
  const dispatchedAgents: string[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const agentId = AGENTS[i % AGENTS.length];
    const body = `## Goal\ngoalId: ${goalId}\nwave: ${waveNumber}\n\n${task.brief}`;

    await createMessage(hivePaths.msgDir, {
      from: "steward",
      to: agentId,
      type: "assign",
      project: projectId,
      body,
      attributes: { scope: task.scope, launch: "auto" },
    });

    dispatchedAgents.push(agentId);
  }

  const goal = await readGoal(projectPaths.goalsDir, goalId);

  if (goal) {
    goal.waveAgents = dispatchedAgents;
    goal.waveNumber = waveNumber;
    goal.updatedAt = toIsoTimestamp();
    await writeGoalRecord(projectPaths.goalsDir, goal);
  }

  return dispatchedAgents;
}

/**
 * Write a morning brief summarising what the overnight run achieved, then
 * flip the goal status to 'review' so a human can inspect the results.
 */
export async function writeMorningBrief(
  goal: GoalRecord | null,
  synthesis: WaveSynthesis,
  waveCount: number,
  projectPaths: ProjectPaths,
): Promise<string> {
  if (!goal) {
    throw new Error("Cannot write morning brief: goal is null");
  }

  const briefDir = join(projectPaths.goalsDir, goal.id);
  await mkdir(briefDir, { recursive: true });
  const briefPath = join(briefDir, "morning-brief.md");

  const date = new Date().toISOString().slice(0, 10);
  const achievedLabel = synthesis.achieved ? "Yes" : "No";

  const remainingSection =
    synthesis.remainingTasks && synthesis.remainingTasks.length > 0
      ? `## Remaining Tasks\n${synthesis.remainingTasks
          .map((t) => `- **${t.title}** (${t.scope}): ${t.brief}`)
          .join("\n")}`
      : "## Status\nGoal complete.";

  const content = `# Morning Brief: ${goal.description}

Date: ${date}
Achieved: ${achievedLabel}
Waves completed: ${waveCount}

## Summary
${synthesis.summary}

${remainingSection}
`;

  await Bun.write(briefPath, content);

  goal.status = "review";
  goal.updatedAt = toIsoTimestamp();
  await writeGoalRecord(projectPaths.goalsDir, goal);

  return briefPath;
}
