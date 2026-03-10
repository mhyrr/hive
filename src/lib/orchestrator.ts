import { appendLogEntry } from "./log";
import { HiveMessage, createMessage } from "./messages";
import { HivePaths, ProjectPaths } from "./paths";
import { parseBoard, minutesSince } from "./board";

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

function summarizeSignals(boardText: string, messages: HiveMessage[]): string[] {
  const signals: string[] = [];
  const board = parseBoard(boardText);

  for (const agent of board.agents) {
    const status = (agent.fields.status ?? "").toLowerCase();
    const lastActive = agent.fields["last-active"];
    const staleMinutes = lastActive ? minutesSince(lastActive) : null;

    if (status.includes("active") && staleMinutes !== null && staleMinutes > 10) {
      signals.push(
        `${agent.id} is marked active but last-active was ${staleMinutes} minutes ago.`,
      );
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
Interactive mode. Perform one meaningful orchestration pass in response to the current state and then stop for human review.

Interactive discipline:
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

  return message.filename;
}

export function buildOrchestratorPrompt(input: {
  projectId: string;
  pathsHome: string;
  repoPath: string;
  soul: string;
  self: string;
  persona: string;
  knowledge: string;
  projectMemory: string;
  projectConfig: string;
  plan: string;
  board: string;
  log: string;
  openMessages: HiveMessage[];
  options: OrchestrateOptions;
}): string {
  const signals = summarizeSignals(input.board, input.openMessages);
  const recentGoal =
    input.options.goal?.trim() ||
    input.openMessages.find(
      (message) =>
        message.attributes.type === "nudge" && message.attributes.to === "orchestrator",
    )?.body ||
    "(none)";

  return `# HIVE Steward Prompt

You are the steward/orchestrator for project ${input.projectId}. Operate from the files below and keep BOARD.md as the single source of truth.

${renderModeInstructions(input.options)}

## Current Goal
${recentGoal}

## Immediate Priorities
${renderList([
  "Read the board, open messages, and recent log before acting.",
  "If the goal is new or changed, decompose it into clear tasks and update PLAN.md and BOARD.md.",
  "Send assignments or clarifications through message files. Do not rely on unrecorded context.",
  "Log every orchestration action you take.",
])}

## Signals
${renderList(signals)}

## Steward Rules
- BOARD.md is yours to maintain. Other agents should update you via msg/.
- Answer human nudges before anything else.
- When a task is done, update the board, unblock dependents, and assign the next task.
- When an agent is stale or blocked, either unblock it or reassign the work. Do not let ambiguity linger.
- If everything is healthy and in progress, wait. Do not micro-manage.

## Hive Identity
project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.pathsHome}

## SOUL.md
${input.soul.trim()}

## SELF.md
${input.self.trim()}

## Persona
${input.persona.trim()}

## Hive Knowledge
${input.knowledge || "(none yet)"}

## Project Memory
${input.projectMemory || "(none yet)"}

## Project Config
${input.projectConfig.trim()}

## Active PLAN.md
${input.plan.trim()}

## BOARD.md
${input.board.trim()}

## LOG.md
${input.log.trim()}

## Open Project Messages
${renderMessages(input.openMessages)}`;
}
