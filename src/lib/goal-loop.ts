import { type ProjectPaths, type HivePaths } from "./paths";
import { type GoalRecord, writeGoalRecord } from "./goals";
import { listRecentRunResults } from "./runs";
import { toIsoTimestamp } from "./time";
import { appendLogEntry } from "./log";
import { createMessage } from "./messages";
import { callAnthropic } from "./anthropic-client";

export async function checkGoalWaveCompletion(input: {
  goal: GoalRecord;
  projectPaths: ProjectPaths;
  hivePaths: HivePaths;
  projectId: string;
}): Promise<void> {
  const { goal, projectPaths } = input;

  if (goal.waveAgents.length === 0) return;

  const results = await listRecentRunResults(projectPaths, 50);

  // Check all wave agents have a completed result
  const completedResults = goal.waveAgents.map((agentId) =>
    results.find(
      (r) =>
        r.agentId === agentId &&
        (r.status === "exited" || r.status === "failed" || r.status === "cancelled"),
    ),
  );

  if (completedResults.some((r) => r == null)) return;

  // All wave agents have completed — synthesize
  const agentSummaries = goal.waveAgents
    .map((agentId, i) => {
      const result = completedResults[i]!;
      const outcome = result.exitCode === 0 ? "succeeded" : `failed (exit ${result.exitCode})`;
      const output = result.finalVisibleOutput?.slice(0, 300) ?? "(no output)";
      return `Agent ${agentId}: ${outcome}\n${output}`;
    })
    .join("\n\n");

  const synthesisPrompt =
    `Goal: ${goal.description}\n\n` +
    `Wave ${goal.waveNumber} completed. Agent results:\n${agentSummaries}\n\n` +
    `Synthesize: did the wave succeed? What evidence should be recorded? ` +
    `Is the goal resolved or does it need another wave? ` +
    `Reply with "resolved" if the goal is complete, "another wave" if more work is needed, ` +
    `or "stuck" if progress is blocked.`;

  let synthesis: string;
  let synthesisFailed = false;
  try {
    synthesis = await callAnthropic({
      model: "claude-haiku-4-5-20251001",
      maxTokens: 512,
      timeoutMs: 15000,
      messages: [{ role: "user", content: synthesisPrompt }],
    });
  } catch (err) {
    synthesis = `Wave ${goal.waveNumber} synthesis failed: ${String(err)}`;
    synthesisFailed = true;
  }

  // Only advance the wave counter and clear agents if synthesis succeeded.
  // A failed synthesis leaves the goal in place for the next pass to retry.
  if (synthesisFailed) {
    goal.evidence = [...goal.evidence, synthesis];
    goal.updatedAt = toIsoTimestamp();
    await writeGoalRecord(input.projectPaths.goalsDir, goal);
    return;
  }

  const lower = synthesis.toLowerCase();
  if (lower.includes("resolved") || lower.includes("complete")) {
    goal.status = "resolved";
  } else if (lower.includes("stuck") || lower.includes("blocked")) {
    goal.status = "stuck";
  }
  // "another wave" or anything else: leave active

  goal.evidence = [...goal.evidence, synthesis];
  goal.waveAgents = [];
  goal.waveNumber = goal.waveNumber + 1;
  goal.updatedAt = toIsoTimestamp();

  await writeGoalRecord(input.projectPaths.goalsDir, goal);
  await appendLogEntry(
    input.projectPaths.log,
    "goal-loop",
    `Goal ${goal.id} wave ${goal.waveNumber - 1} synthesized. Status: ${goal.status}`,
  );
}

export async function writeMorningBrief(input: {
  goals: GoalRecord[];
  projectPaths: ProjectPaths;
}): Promise<void> {
  const { goals } = input;
  const resolved = goals.filter((g) => g.status === "resolved").length;
  const stuck = goals.filter((g) => g.status === "stuck").length;
  const active = goals.filter((g) => g.status === "active").length;

  await appendLogEntry(
    input.projectPaths.log,
    "goal-loop",
    `Morning brief: ${resolved} resolved, ${stuck} stuck, ${active} active (${goals.length} total)`,
  );
}

export async function dispatchNextWave(input: {
  goal: GoalRecord;
  msgDir: string;
  projectId: string;
  projectPaths: ProjectPaths;
}): Promise<void> {
  const { goal } = input;

  await createMessage(input.msgDir, {
    from: "supervisor",
    to: "steward",
    type: "nudge",
    project: input.projectId,
    body:
      `Goal ${goal.id} (${goal.description}) completed wave ${goal.waveNumber - 1}. ` +
      `Please review progress and dispatch the next wave of workers if needed.`,
  });
}
