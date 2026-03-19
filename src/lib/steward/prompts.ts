import { appendFeedEntry } from "../feed";
import { appendLogEntry } from "../log";
import { type HiveMessage, createMessage } from "../messages";
import type { HivePaths, ProjectPaths } from "../paths";
import { parseBoard, minutesSince } from "../board";
import type { RunRecord, RunResult } from "../runs";
import { digestBoard, listSkills } from "../digest";

import { type StewardContext, renderStewardRoutingPolicy } from "./context";
import {
  renderActiveRuns,
  renderAvailableRuntimes,
  renderCompactState,
  renderDeltaHistory,
  renderDurableMemory,
  renderList,
  renderMessages,
  renderPathList,
  renderRunResults,
  renderStewardProjectPaths,
} from "./sections";

export type OrchestrateMode = "interactive" | "loop";

export type OrchestrateOptions = {
  mode: OrchestrateMode;
  intervalSeconds: number;
  goal: string | null;
};

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

    if (message.attributes.type === "nudge" && message.attributes.to === "steward") {
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

async function readFileOrDefault(path: string, fallback: string): Promise<string> {
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      const content = (await file.text()).trim();
      return content || fallback;
    }
  } catch {
    // fall through
  }

  return fallback;
}

function capBootstrapContent(content: string, label: string): string {
  const trimmed = content.trim();

  if (trimmed.length <= 4_000) {
    return trimmed || `(empty ${label})`;
  }

  return `${trimmed.slice(0, 4_000).trimEnd()}\n\n[${label} truncated]`;
}

async function loadEssentialSkills(
  skillsDir: string,
  availableSkillNames: string[],
): Promise<string> {
  const lines: string[] = [];

  for (const name of availableSkillNames) {
    const path = `${skillsDir}/${name}.md`;
    const content = await readFileOrDefault(path, "").catch(() => "");

    if (!content.trim()) {
      continue;
    }

    lines.push(`## ${name}`);
    lines.push(capBootstrapContent(content, `${name}.md`));
    lines.push("");
  }

  return lines.join("\n").trim() || "(no operational skills found)";
}

export async function enqueueGoalForOrchestrator(
  paths: HivePaths,
  projectPaths: ProjectPaths,
  projectId: string,
  goal: string,
): Promise<string> {
  const message = await createMessage(paths.msgDir, {
    from: "human",
    to: "steward",
    type: "nudge",
    project: projectId,
    body: goal,
  });

  await appendLogEntry(
    projectPaths.log,
    "human → steward",
    `Goal: ${goal}\nMessage: ${message.filename}`,
  );
  await appendFeedEntry(paths, {
    project: projectId,
    headline: `Steward goal queued`,
    details: [goal],
  });

  return message.filename;
}

export async function buildOrchestratorPrompt(input: {
  projectId: string;
  pathsHome: string;
  globalConfig: string;
  repoPath: string;
  pathsSoul: string;
  pathsIdentity: string;
  pathsSelf: string;
  pathsAgents: string;
  pathsTrust: string;
  personaPath: string;
  projectConfigPath: string;
  planPath: string;
  boardPath: string;
  logPath: string;
  projectMemoryPath: string;
  projectMemory: string;
  memorySummaryPath: string;
  memoryHeatPath: string;
  recentDecisionsPath: string;
  projectEntitySummaryPath: string;
  journalPath: string;
  messagesDir: string;
  skillsDir: string;
  availableSkillNames: string[];
  soul: string;
  board: string;
  activeRuns: RunRecord[];
  recentRunResults: RunResult[];
  openMessages: HiveMessage[];
  knowledgeDigest: string;
  recentDecisionsDigest: string;
  projectEntityDigest: string;
  options: OrchestrateOptions;
}): Promise<string> {
  const signals = summarizeSignals(input.board, input.openMessages, input.activeRuns);
  const runtimesInfo = await renderAvailableRuntimes();
  const recentGoal =
    input.options.goal?.trim() ||
    input.openMessages.find(
      (message) =>
        message.attributes.type === "nudge" && message.attributes.to === "steward",
    )?.body ||
    "(none)";

  const inlinedSkills = capBootstrapContent(
    await loadEssentialSkills(input.skillsDir, input.availableSkillNames),
    "skills",
  );
  const inlinedAgents = capBootstrapContent(
    await readFileOrDefault(input.pathsAgents, "(no AGENTS.md found)"),
    "AGENTS.md",
  );

  return `# HIVE Steward Prompt

You are the steward for project ${input.projectId}. All context you need is below — respond immediately without reading files first. Use the hive CLI for actions (resolving messages, logging, assigning work) not for reading state.

## Shared Soul
${capBootstrapContent(input.soul.trim(), "SOUL.md")}

Read agent identity: ${input.pathsIdentity}
Read user preferences: ${input.pathsSelf}
Read trust policy: ${input.pathsTrust}

${renderModeInstructions(input.options)}

## Current Goal
${recentGoal}

## Cognitive Routing Policy
${renderStewardRoutingPolicy({
    globalConfig: input.globalConfig,
    skillsDir: input.skillsDir,
  })}

## CRITICAL: You MUST produce text output
Your stdout text is what the human sees. After taking any actions (resolving messages, logging, assigning work), you MUST end with a brief text summary. If you only make tool calls with no text, the human sees nothing. Always finish with visible text.

## Immediate Priorities
- Answer human nudges before anything else. Respond directly and concisely.
- If the goal is new or changed, decompose it into clear tasks and update PLAN.md and BOARD.md.
- Send assignments or clarifications through message files. Do not rely on unrecorded context.
- When you fully handle a message, resolve it or close it so the open queue stays clean.
- Route depth, fan-out, and parallelism with the cognitive routing policy above. Reuse fresh worker output before relaunching work.
- Log every orchestration action you take.

## Signals
${renderList(signals)}

## Operational Skills
${inlinedSkills}

## Operational Protocols
${inlinedAgents}

## Steward Rules
- BOARD.md is yours to maintain. Other agents should update you via msg/.
- The authoritative hive files are not in the repo root. Use the absolute paths below instead of repo-relative guesses like \`BOARD.md\` or \`LOG.md\`.
- Answer human nudges before anything else.
- Resolve handled nudges and answered questions with \`hive msg resolve <message> steward <answer>\` or \`./hive msg resolve <message> steward <answer>\`. Close obsolete threads with \`hive msg close <message> steward [note]\` or \`./hive msg close <message> steward [note]\`.
- Tell workers to poll with \`hive inbox <agent>\` or \`./hive inbox <agent>\` and to resolve or close their own message-driven work when done.
- When you create an assignment message, include machine-usable frontmatter: \`task:\` for the work id, \`launch:\` (\`auto\` or \`manual\`), and conservative \`scope:\` roots whenever parallel launch is safe.
- When a task is done, update the board, unblock dependents, and assign the next task.
- When an agent is stale or blocked, either unblock it or reassign the work. Do not let ambiguity linger.
- If everything is healthy and in progress, wait. Do not micro-manage.

## Available Runtimes
${runtimesInfo}

## Initiative
You take action without being told. When you make a decision, record it: \`hive memory decision "..."\`. When you discover a convention, record it: \`hive memory convention "..."\`. When you learn a durable fact, record it: \`hive memory fact "..."\`. Record as you go — don't batch, don't announce.

## Before You Exit
Your context window dies when you exit. Before finishing:
1. Flush decisions, conventions, and facts to memory.
2. Log a summary to LOG.md via \`hive log\`.
3. Record WHY you made choices — the next steward pass starts cold.

## Hive Identity
project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.pathsHome}

${renderPathList("File Paths (for writes/actions only)", [
    { label: "SOUL.md", value: input.pathsSoul },
    { label: "IDENTITY.md", value: input.pathsIdentity },
    { label: "SELF.md", value: input.pathsSelf },
    { label: "AGENTS.md", value: input.pathsAgents },
    { label: "TRUST.md", value: input.pathsTrust },
    { label: "persona", value: input.personaPath },
    { label: "project-config", value: input.projectConfigPath },
    { label: "PLAN.md", value: input.planPath },
    { label: "BOARD.md", value: input.boardPath },
    { label: "LOG.md", value: input.logPath },
    { label: "project-memory", value: input.projectMemoryPath },
    { label: "memory-summary-json", value: input.memorySummaryPath },
    { label: "memory-heat-json", value: input.memoryHeatPath },
    { label: "recent-decisions-json", value: input.recentDecisionsPath },
    { label: "project-entity-summary", value: input.projectEntitySummaryPath },
    { label: "journal", value: input.journalPath },
    { label: "messages-dir", value: input.messagesDir },
  ])}

## Available Skills
${listSkills(input.skillsDir, input.availableSkillNames)}

## Board Summary
${digestBoard(input.board)}

## Project Memory
${input.projectMemory}

${renderDurableMemory({
    knowledgeDigest: input.knowledgeDigest,
    recentDecisionsDigest: input.recentDecisionsDigest,
    projectEntityDigest: input.projectEntityDigest,
  })}

## Active Runs
${renderActiveRuns(input.activeRuns)}

## Recent Run Results
${renderRunResults(input.recentRunResults)}

## Open Project Messages
${renderMessages(input.openMessages)}`;
}

export function buildPersistentStewardSystemPrompt(input: {
  sessionPrompt: string;
  cognitiveRoutingPolicy: string;
}): string {
  return `${input.sessionPrompt || "# HIVE Steward Session"}

You are HIVE's persistent steward session.

Pi is only the live session engine. HIVE still owns the durable memory, project
state, board, logs, messages, and worker coordination. Treat the HIVE files as
the durable source of truth.

Operating rules:
- Answer the human directly and concretely.
- Use compact state first. Only perform deeper reads when the turn actually needs them.
- Use absolute paths when working across HIVE home and project files.
- Update PLAN.md, BOARD.md, LOG.md, and message files yourself when the state changes.
- Delegate through HIVE files or \`hive\` commands when specialized worker work is needed.
- Follow the cognitive routing policy below instead of defaulting to either solo replies or broad fan-out.
- Keep replies human-facing. Do not narrate internal session mechanics unless relevant.
- If the HIVE session tail conflicts with your in-memory assumptions, trust the HIVE session tail.

Cognitive routing policy:
${input.cognitiveRoutingPolicy}
`;
}

export function buildPersistentStewardBootstrapMessage(input: StewardContext & {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
  humanMessage: string;
  cognitiveRoutingPolicy: string;
}): string {
  return `Bootstrap the live HIVE steward session before answering the human turn. Use this compact context to load the project into working memory. Do not simply restate the bootstrap back to the human.

## Session
- session: ${input.sessionId}
- project: ${input.projectId}
- repo: ${input.repoPath}
- current-revision: ${input.currentRevision}
- last-revision-seen-in-hive-session: ${input.sessionRevision}
- configured-steward-runtime: ${input.sessionRuntime}${input.sessionModel ? ` (${input.sessionModel})` : ""}

## Shared Soul
${input.soul}

${renderPathList("Absolute Paths", [
    { label: "SOUL.md", value: input.hivePaths.soul },
    { label: "IDENTITY.md", value: input.hivePaths.identity },
    { label: "SELF.md", value: input.hivePaths.self },
    { label: "AGENTS.md", value: input.hivePaths.agents },
    { label: "TRUST.md", value: input.hivePaths.trust },
    { label: "project-config", value: input.projectPaths.config },
    { label: "PLAN.md", value: input.projectPaths.plan },
    { label: "BOARD.md", value: input.projectPaths.board },
    { label: "LOG.md", value: input.projectPaths.log },
    { label: "project-memory", value: input.projectPaths.memory },
    { label: "messages-dir", value: input.hivePaths.msgDir },
    { label: "state-dir", value: input.projectPaths.stateDir },
    { label: "board-summary-json", value: input.projectPaths.stateBoardSummary },
    { label: "open-messages-json", value: input.projectPaths.stateOpenMessages },
    { label: "active-runs-json", value: input.projectPaths.stateActiveRuns },
    { label: "recent-results-json", value: input.projectPaths.stateRecentResults },
    { label: "human-inbox-json", value: input.projectPaths.stateHumanInbox },
    { label: "latest-delta-json", value: input.projectPaths.stateStewardDelta },
    { label: "delta-history-jsonl", value: input.projectPaths.stateDeltaHistory },
    { label: "memory-summary-json", value: input.memorySummaryPath },
    { label: "memory-heat-json", value: input.memoryHeatPath },
    { label: "recent-decisions-json", value: input.recentDecisionsPath },
    { label: "project-entity-summary", value: input.projectEntitySummaryPath },
    { label: "journal", value: input.journalPath },
  ])}

## Cognitive Routing Policy
${input.cognitiveRoutingPolicy}

${renderCompactState({
    boardDigest: input.boardDigest,
    openMessagesDigest: input.openMessagesDigest,
    activeRunsDigest: input.activeRunsDigest,
    recentResultsDigest: input.recentResultsDigest,
    humanInboxDigest: input.humanInboxDigest,
  })}

${renderDurableMemory({
    knowledgeDigest: input.knowledgeDigest,
    recentDecisionsDigest: input.recentDecisionsDigest,
    projectEntityDigest: input.projectEntityDigest,
  })}

## Delta Since Last Seen
${renderDeltaHistory(input.deltaHistory, input.sessionRevision)}

## Recent HIVE Session Tail
${input.recentTurns}

## Human Turn
${input.humanMessage}`;
}

export function buildPersistentStewardRefreshMessage(input: StewardContext & {
  hivePaths: HivePaths;
  projectId: string;
  humanMessage: string;
  cognitiveRoutingPolicy: string;
}): string {
  return `Refresh the existing live HIVE steward session with the latest compact state and then answer the human turn.

## Session
- project: ${input.projectId}
- repo: ${input.repoPath}
- current-revision: ${input.currentRevision}
- last-revision-seen-in-hive-session: ${input.sessionRevision}
- configured-steward-runtime: ${input.sessionRuntime}${input.sessionModel ? ` (${input.sessionModel})` : ""}

${renderPathList("Current Paths", [
    { label: "project-config", value: input.projectPaths.config },
    { label: "PLAN.md", value: input.projectPaths.plan },
    { label: "BOARD.md", value: input.projectPaths.board },
    { label: "LOG.md", value: input.projectPaths.log },
    { label: "project-memory", value: input.projectPaths.memory },
    { label: "messages-dir", value: input.hivePaths.msgDir },
    { label: "state-dir", value: input.projectPaths.stateDir },
  ])}

## Cognitive Routing Policy
${input.cognitiveRoutingPolicy}

## Delta Since Last Seen
${renderDeltaHistory(input.deltaHistory, input.sessionRevision)}

${renderCompactState({
    heading: "Compact Snapshot",
    boardDigest: input.boardDigest,
    openMessagesDigest: input.openMessagesDigest,
    activeRunsDigest: input.activeRunsDigest,
    recentResultsDigest: input.recentResultsDigest,
    humanInboxDigest: input.humanInboxDigest,
  })}

${renderDurableMemory({
    knowledgeDigest: null,
    recentDecisionsDigest: input.recentDecisionsDigest,
    projectEntityDigest: input.projectEntityDigest,
  })}

## Recent HIVE Session Tail
${input.recentTurns}

## Human Turn
${input.humanMessage}`;
}

export function buildDirectStewardTurnPrompt(input: StewardContext & {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
  cognitiveRoutingPolicy: string;
  humanMessage: string;
}): string {
  return `${input.sessionPrompt || "# HIVE Steward Session"}

You are the live steward for project ${input.projectId}. This is a continuing conversation with the human, not a fresh steward bootstrap. Use the compact state and delta history first. Only read raw files when the current turn actually requires it.

## Session Contract
- session: ${input.sessionId}
- current-revision: ${input.currentRevision}
- last-revision-seen-in-session: ${input.sessionRevision}

## Shared Soul
${input.soul}

Read agent identity: ${input.hivePaths.identity}
Read user preferences: ${input.hivePaths.self}
Read operational doctrine: ${input.hivePaths.agents}
Read trust policy: ${input.hivePaths.trust}

## Operating Rules
- Answer the human directly and concretely.
- If action is needed, do it yourself through files or \`hive\` commands. Do not tell the human to operate the system for you.
- BOARD.md is steward-owned. Update it directly when plan/task state changes.
- When you delegate, create assignment messages with \`task:\`, \`launch: auto\`, and \`scope:\`.
- Follow the cognitive routing policy below instead of defaulting to either solo replies or broad fan-out.
- Keep LOG.md and feed.md high signal.
- Use the compact runtime state first; raw markdown reads should be targeted.
- Always end with visible text for the human. If you only make tool calls, the session will look broken.

${renderStewardProjectPaths({
    hivePaths: input.hivePaths,
    projectPaths: input.projectPaths,
    memorySummaryPath: input.memorySummaryPath,
    memoryHeatPath: input.memoryHeatPath,
    recentDecisionsPath: input.recentDecisionsPath,
    projectEntitySummaryPath: input.projectEntitySummaryPath,
    journalPath: input.journalPath,
  }).replace(`- repo: ${input.projectPaths.root}`, `- repo: ${input.repoPath}`)}

## Cognitive Routing Policy
${input.cognitiveRoutingPolicy}

${renderCompactState({
    boardDigest: input.boardDigest,
    openMessagesDigest: input.openMessagesDigest,
    activeRunsDigest: input.activeRunsDigest,
    recentResultsDigest: input.recentResultsDigest,
    humanInboxDigest: input.humanInboxDigest,
  })}

${renderDurableMemory({
    knowledgeDigest: input.knowledgeDigest,
    recentDecisionsDigest: input.recentDecisionsDigest,
    projectEntityDigest: input.projectEntityDigest,
  })}

## Delta Since Last Seen
${renderDeltaHistory(input.deltaHistory, input.sessionRevision)}

## Recent Conversation
${input.recentTurns}

## Human Turn
${input.humanMessage}`;
}
