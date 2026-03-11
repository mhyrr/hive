import { appendLogEntry } from "./log";
import { appendFeedEntry } from "./feed";
import { digestBoard, listSkills } from "./digest";
import { HiveMessage, createMessage } from "./messages";
import { HivePaths, ProjectPaths } from "./paths";
import { parseBoard, minutesSince } from "./board";
import { RunRecord, RunResult } from "./runs";

export type OrchestrateMode = "interactive" | "loop";

export type OrchestrateOptions = {
  mode: OrchestrateMode;
  intervalSeconds: number;
  goal: string | null;
};

function renderMessages(messages: HiveMessage[]): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages.map((message) => `### ${message.filename}\n${message.raw}`).join("\n\n");
}

function renderList(items: string[]): string {
  if (items.length === 0) {
    return "- (none)";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function renderActiveRuns(runs: RunRecord[]): string {
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

function renderRunResults(results: RunResult[]): string {
  if (results.length === 0) {
    return "(none)";
  }

  return results
    .map((result) =>
      [
        `### ${result.runId} (${result.agentId})`,
        `status: ${result.status}`,
        `exit-code: ${result.exitCode ?? "unknown"}`,
        `assignment: ${result.assignmentMessage ?? "(none)"}`,
        `assignment-status-after-exit: ${result.assignmentStatusAfterExit ?? "(none)"}`,
        `assignment-resolved-by-worker: ${result.assignmentResolvedByWorker ? "yes" : "no"}`,
        `files-changed: ${result.changedFiles.join(", ") || "(none detected)"}`,
        `git-summary: ${result.gitSummaryLines.join("; ") || "(none detected)"}`,
        "final-visible-output:",
        result.finalVisibleOutput || "(none)",
      ].join("\n"),
    )
    .join("\n\n");
}

function summarizeSignals(
  boardText: string,
  messages: HiveMessage[],
  activeRuns: RunRecord[],
): string[] {
  const signals: string[] = [];
  const board = parseBoard(boardText);

  for (const agent of board.agents) {
    const status = (agent.fields.status ?? "").toLowerCase();
    const lastActive = agent.fields["last-active"];
    const staleMinutes = lastActive ? minutesSince(lastActive) : null;
    const hasActiveRun = activeRuns.some((run) => run.agentId === agent.id);

    if (status.includes("active") && staleMinutes !== null && staleMinutes > 10) {
      signals.push(
        `${agent.id} is marked active but last-active was ${staleMinutes} minutes ago.`,
      );
    }

    if (status.includes("active") && !hasActiveRun) {
      signals.push(`${agent.id} is marked active on the board but has no active run record.`);
    }
  }

  for (const message of messages) {
    const status = message.attributes.status ?? "open";

    if (status !== "open") {
      continue;
    }

    const staleMinutes = minutesSince(message.attributes.ts ?? "");

    if (
      message.attributes.type === "question" &&
      staleMinutes !== null &&
      staleMinutes > 10
    ) {
      signals.push(
        `Open question from ${message.attributes.from ?? "unknown"} to ${message.attributes.to ?? "unknown"} has been waiting ${staleMinutes} minutes.`,
      );
    }

    if (message.attributes.type === "nudge" && message.attributes.to === "orchestrator") {
      signals.push(`Human nudge pending: ${message.body.split("\n")[0]}`);
    }
  }

  if (signals.length === 0) {
    signals.push("No urgent orchestration signals detected from the board or open messages.");
  }

  return signals;
}

function renderModeInstructions(options: OrchestrateOptions): string {
  if (options.mode === "loop") {
    return `## Mode
Loop mode. Run one assessment/action cycle, then pause ${options.intervalSeconds} seconds before re-reading state and continuing.

Loop discipline:
- Handle the single highest-priority item per cycle.
- If everything is healthy and in progress, wait instead of inventing work.
- Re-read BOARD.md, open messages, and LOG.md every cycle. Do not trust stale context.`;
  }

  return `## Mode
Human-driven single-pass mode. Perform one meaningful orchestration pass in response to the current state and then stop for human review.

Single-pass discipline:
- Prefer the single highest-leverage action over broad rewrites.
- If the next step depends on human direction, surface the decision cleanly instead of guessing.
- Treat a fresh goal or nudge as the top priority.`;
}

export async function enqueueGoalForOrchestrator(
  paths: HivePaths,
  projectPaths: ProjectPaths,
  projectId: string,
  goal: string,
): Promise<string> {
  const message = await createMessage(paths.msgDir, {
    from: "human",
    to: "orchestrator",
    type: "nudge",
    project: projectId,
    body: goal,
  });

  await appendLogEntry(
    projectPaths.log,
    "human → orchestrator",
    `Goal: ${goal}\nMessage: ${message.filename}`,
  );
  await appendFeedEntry(paths, {
    project: projectId,
    headline: `Orchestrator goal queued`,
    details: [goal],
  });

  return message.filename;
}

export function buildOrchestratorPrompt(input: {
  projectId: string;
  pathsHome: string;
  repoPath: string;
  pathsSoul: string;
  pathsSelf: string;
  pathsAgents: string;
  personaPath: string;
  projectConfigPath: string;
  planPath: string;
  boardPath: string;
  logPath: string;
  projectMemoryPath: string;
  projectMemory: string;
  messagesDir: string;
  skillsDir: string;
  availableSkillNames: string[];
  soul: string;
  board: string;
  activeRuns: RunRecord[];
  recentRunResults: RunResult[];
  openMessages: HiveMessage[];
  options: OrchestrateOptions;
}): string {
  const signals = summarizeSignals(input.board, input.openMessages, input.activeRuns);
  const essentialSkills = ["state-efficient-ops"];
  const essentialSkillPaths = essentialSkills
    .filter((name) => input.availableSkillNames.includes(name))
    .map((name) => `${input.skillsDir}/${name}.md`);
  const recentGoal =
    input.options.goal?.trim() ||
    input.openMessages.find(
      (message) =>
        message.attributes.type === "nudge" && message.attributes.to === "orchestrator",
    )?.body ||
    "(none)";

  return `# HIVE Steward Prompt

You are the steward/orchestrator for project ${input.projectId}. Operate from the files below and keep BOARD.md as the single source of truth.

## Identity
${input.soul.trim()}

${renderModeInstructions(input.options)}

## Current Goal
${recentGoal}

## Immediate Priorities
${renderList([
  "Read the board, open messages, and recent log before acting.",
  "If the goal is new or changed, decompose it into clear tasks and update PLAN.md and BOARD.md.",
  "Send assignments or clarifications through message files. Do not rely on unrecorded context.",
  "When you fully handle a message, resolve it or close it so the open queue stays clean.",
  "Log every orchestration action you take.",
])}

## Signals
${renderList(signals)}

## Steward Rules
- BOARD.md is yours to maintain. Other agents should update you via msg/.
- Read ${input.pathsAgents} for full operational protocols.
- Read essential skills before starting work: ${essentialSkillPaths.join(", ") || "(none)"}
- The authoritative hive files are not in the repo root. Use the absolute paths below instead of repo-relative guesses like \`BOARD.md\` or \`LOG.md\`.
- Answer human nudges before anything else.
- Resolve handled nudges and answered questions with \`hive msg resolve <message> orchestrator <answer>\` or \`./hive msg resolve <message> orchestrator <answer>\`. Close obsolete threads with \`hive msg close <message> orchestrator [note]\` or \`./hive msg close <message> orchestrator [note]\`.
- Tell workers to poll with \`hive inbox <agent>\` or \`./hive inbox <agent>\` and to resolve or close their own message-driven work when done.
- When you create an assignment message, include machine-usable frontmatter: \`task:\` for the work id, \`launch:\` (\`auto\` or \`manual\`), and conservative \`scope:\` roots whenever parallel launch is safe.
- When a task is done, update the board, unblock dependents, and assign the next task.
- When an agent is stale or blocked, either unblock it or reassign the work. Do not let ambiguity linger.
- If everything is healthy and in progress, wait. Do not micro-manage.

## Hive Identity
project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.pathsHome}

## Files
SOUL.md: ${input.pathsSoul}
SELF.md: ${input.pathsSelf}
AGENTS.md: ${input.pathsAgents}
persona: ${input.personaPath}
project-config: ${input.projectConfigPath}
PLAN.md: ${input.planPath}
BOARD.md: ${input.boardPath}
LOG.md: ${input.logPath}
project-memory: ${input.projectMemoryPath}
messages-dir: ${input.messagesDir}

## Available Skills
${listSkills(input.skillsDir, input.availableSkillNames)}

## Board Summary
${digestBoard(input.board)}

## Project Memory
${input.projectMemory}

## Active Runs
${renderActiveRuns(input.activeRuns)}

## Recent Run Results
${renderRunResults(input.recentRunResults)}

## Open Project Messages
${renderMessages(input.openMessages)}`;
}
