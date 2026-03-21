import { appendFeedEntry } from "../feed";
import { appendLogEntry } from "../log";
import { createMessage } from "../messages";
import type { HivePaths, ProjectPaths } from "../paths";
import { type ModelPoolEntry, parseModelPool } from "../project";

import { type StewardContext, renderStewardRoutingPolicy } from "./context";
import {
  renderCompactState,
  renderDeltaHistory,
  renderDurableMemory,
  renderPathList,
  renderStewardProjectPaths,
} from "./sections";

function renderModelPoolSection(pool: ModelPoolEntry[]): string {
  if (pool.length === 0) {
    return "";
  }

  const lines = [
    "## Available Models",
    "Pick model+persona per task. Workers are ephemeral — no fixed roster.",
    "",
  ];

  for (const entry of pool) {
    lines.push(`- ${entry.name} (${entry.runtime}, ${entry.model}): ${entry.description}`);
  }

  lines.push("");
  lines.push("Assignment frontmatter fields for model selection:");
  lines.push("- `to:` — ephemeral agent ID, e.g. `craftsman-opus-001`, `critic-sonnet-review`");
  lines.push("- `persona:` — cognitive lens: architect, craftsman, critic, scout");
  lines.push("- `runtime:` — which runtime to use (from model pool above)");
  lines.push("- `model:` — which model ID to use (from model pool above)");
  lines.push("- Available personas: architect (system design), craftsman (implementation), critic (review/analysis), scout (research/exploration)");

  return lines.join("\n");
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
    "human \u2192 steward",
    `Goal: ${goal}\nMessage: ${message.filename}`,
  );
  await appendFeedEntry(paths, {
    project: projectId,
    headline: `Steward goal queued`,
    details: [goal],
  });

  return message.filename;
}

export function buildPersistentStewardSystemPrompt(input: {
  sessionPrompt: string;
  soul: string;
  identity: string;
  self: string;
  cognitiveRoutingPolicy: string;
  globalConfig?: string;
}): string {
  const modelPool = input.globalConfig ? parseModelPool(input.globalConfig) : [];
  const modelPoolSection = renderModelPoolSection(modelPool);

  return `${input.soul}

${input.identity}

${input.self}

${input.sessionPrompt || "# HIVE Steward Session"}

You are the steward. Never echo bootstrap context, session mechanics, revision
numbers, or file paths back at the human unless they ask for system internals.

${modelPoolSection}

Session rules:
- Use compact state first. Only read raw files when the turn actually needs them.
- Use absolute paths when working across HIVE home and project files.
- Update PLAN.md, BOARD.md, LOG.md, and message files when state changes.
- Delegate through HIVE message files when worker work is needed. Real delegation means WRITING A FILE to the messages directory. Do NOT use \`hive msg\` as a shell command — it is not in PATH. Instead, write the message file directly.
- To delegate work, write a markdown file to the messages directory with this exact format:

\`\`\`
---
from: steward
to: <agent-id>
type: assign
project: <project-id>
task: <task-id>
scope: <comma-separated scope roots>
persona: <architect|craftsman|critic|scout>
runtime: <runtime from model pool>
model: <model-id from model pool>
launch: auto
---

<worker brief — what the worker should do>
\`\`\`

The \`to:\` field is an ephemeral agent ID. Name it descriptively: \`craftsman-opus-001\`, \`critic-sonnet-review\`, \`scout-haiku-scan\`, etc. There is no fixed team roster — pick the right model and persona for each task.

Write the file to: \`<messages-dir>/assign-<agent-id>-<timestamp>.md\`
The supervisor watcher will detect the file and launch the worker automatically within ~200ms.
- When the human asks for multiple runtimes/models or parallel work, write multiple assignment files. Do not narrate delegation and then do the work yourself.
- Do NOT use the Agent tool, subagents, or Claude Code tools for delegation. HIVE has its own worker fleet. Write assignment files.
- Follow the cognitive routing policy below.
- If the session tail conflicts with your assumptions, trust the session tail.

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
  globalConfig?: string;
}): string {
  const modelPool = input.globalConfig ? parseModelPool(input.globalConfig) : [];
  const modelPoolSection = renderModelPoolSection(modelPool);

  return `Bootstrap the live HIVE steward session before answering the human turn. Use this compact context to load the project into working memory. Do not simply restate the bootstrap back to the human.

## Session
- session: ${input.sessionId}
- project: ${input.projectId}
- repo: ${input.repoPath}
- current-revision: ${input.currentRevision}
- last-revision-seen-in-hive-session: ${input.sessionRevision}
- configured-steward-runtime: ${input.sessionRuntime}${input.sessionModel ? ` (${input.sessionModel})` : ""}

${modelPoolSection}

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
    openDecisionsDigest: input.openDecisionsDigest,
    openMessagesDigest: input.openMessagesDigest,
    activeRunsDigest: input.activeRunsDigest,
    recentResultsDigest: input.recentResultsDigest,
    humanInboxDigest: input.humanInboxDigest,
    logRollupDigest: input.logRollupDigest,
    phaseSummaryDigest: input.phaseSummaryDigest,
    memoryHotsetDigest: input.memoryHotsetDigest,
    staleMemoryDigest: input.staleMemoryDigest,
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
  globalConfig?: string;
}): string {
  const modelPool = input.globalConfig ? parseModelPool(input.globalConfig) : [];
  const modelPoolSection = renderModelPoolSection(modelPool);

  return `Refresh the existing live HIVE steward session with the latest compact state and then answer the human turn.

## Session
- project: ${input.projectId}
- repo: ${input.repoPath}
- current-revision: ${input.currentRevision}
- last-revision-seen-in-hive-session: ${input.sessionRevision}
- configured-steward-runtime: ${input.sessionRuntime}${input.sessionModel ? ` (${input.sessionModel})` : ""}

${modelPoolSection}

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
    openDecisionsDigest: input.openDecisionsDigest,
    openMessagesDigest: input.openMessagesDigest,
    activeRunsDigest: input.activeRunsDigest,
    recentResultsDigest: input.recentResultsDigest,
    humanInboxDigest: input.humanInboxDigest,
    logRollupDigest: input.logRollupDigest,
    phaseSummaryDigest: input.phaseSummaryDigest,
    memoryHotsetDigest: input.memoryHotsetDigest,
    staleMemoryDigest: input.staleMemoryDigest,
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
  globalConfig?: string;
}): string {
  const modelPool = input.globalConfig ? parseModelPool(input.globalConfig) : [];
  const modelPoolSection = renderModelPoolSection(modelPool);

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

${modelPoolSection}

## Operating Rules
- Answer the human directly and concretely.
- If action is needed, do it yourself through files or \`hive\` commands. Do not tell the human to operate the system for you.
- BOARD.md is steward-owned. Update it directly when plan/task state changes.
- When you delegate, WRITE assignment message files directly to the messages directory. Do NOT shell out to \`hive msg\` — it is not in PATH. Write a markdown file with frontmatter: \`from: steward\`, \`to: <agent-id>\`, \`type: assign\`, \`project: <project-id>\`, \`task: <task-id>\`, \`scope: <roots>\`, \`persona: <persona>\`, \`runtime: <runtime>\`, \`model: <model-id>\`, \`launch: auto\`. The body is the worker brief.
- The \`to:\` field is an ephemeral agent ID — name it descriptively: \`craftsman-opus-001\`, \`critic-sonnet-review\`, etc. There is no fixed team roster.
- Write to: \`<messages-dir>/assign-<agent-id>-<timestamp>.md\`. The watcher auto-launches within ~200ms.
- If the human asks for multiple runtimes/models or parallel work, write multiple assignment files. Do not say you delegated and then do the work yourself.
- Do NOT use the Agent tool, subagents, or Claude Code tools for delegation. HIVE has its own worker fleet.
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
    openDecisionsDigest: input.openDecisionsDigest,
    openMessagesDigest: input.openMessagesDigest,
    activeRunsDigest: input.activeRunsDigest,
    recentResultsDigest: input.recentResultsDigest,
    humanInboxDigest: input.humanInboxDigest,
    logRollupDigest: input.logRollupDigest,
    phaseSummaryDigest: input.phaseSummaryDigest,
    memoryHotsetDigest: input.memoryHotsetDigest,
    staleMemoryDigest: input.staleMemoryDigest,
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
