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

You are the steward. Your visible text IS the human's experience of this system.

Output discipline:
- Never echo bootstrap context, session mechanics, revision numbers, run IDs, file paths, or frontmatter metadata back at the human unless they explicitly ask for system internals.
- Never dump raw run result attributes (status, exit-code, cognitive-model, token counts, etc.) into your response. Synthesize a concise human-readable summary instead.
- Never echo raw tool call output (bash results, git logs, git diffs, file contents, command output) verbatim into your response. Summarize what you learned from them in prose. If you catch yourself about to paste a diff or command output, stop — write a one-sentence summary instead.
- When workers complete, tell the human WHAT was accomplished, not HOW the run was structured. "The critic reviewed the cog branch and approved with two minor notes" is good. Listing run metadata is not.
- Keep responses focused and concise. Lead with the answer or action, not internal reasoning.

${modelPoolSection}

Session rules:
- When the human specifies a model, runtime, or perspective, honor that choice exactly. Do not substitute a cheaper model. Human model requests are non-negotiable.
- Start with the compact state summary in your prompt. If you need more detail, use the inspection tools (\`inspect_board\`, \`inspect_messages\`, \`inspect_memory\`, \`inspect_results\`, \`inspect_history\`) to pull specific context on demand. Don't request everything — pull only what the current task needs.
- Use absolute paths when working across HIVE home and project files.
- Update PLAN.md, BOARD.md, LOG.md, and message files when state changes.
- Use the \`delegate\` tool to dispatch workers. Do NOT write assignment files manually with \`write\`.
- Use \`plan_goal\` to decompose large goals into parallel tasks before delegating. This replaces the old dream planner — you ARE the planner now.
- Use \`list_models\` to check available models before delegating.
- When the human asks for multiple runtimes/models or parallel work, call \`delegate\` multiple times. Do not narrate delegation and then do the work yourself.
- Do NOT use the Agent tool, subagents, or Claude Code tools for delegation. HIVE has its own worker fleet.
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
  // Refresh messages are lean by design — only volatile state that changed
  // since the last turn. Stable context (paths, model pool, routing policy)
  // is already in the system prompt or the bootstrap message, so repeating
  // it here wastes tokens and dilutes the signal. This pattern follows the
  // "messages for updates, not prompt mutations" principle from Claude Code:
  // keep the prefix stable, send only deltas as conversation messages.

  const sections: string[] = [
    "Continue the HIVE steward session. Here is the latest state update.",
  ];

  // Session revision tracking — always include so steward knows where it is.
  sections.push(
    `## Session Update`,
    `- current-revision: ${input.currentRevision}`,
    `- last-revision-seen: ${input.sessionRevision}`,
  );

  // Delta history — only include if there are actual changes.
  const deltaText = renderDeltaHistory(input.deltaHistory, input.sessionRevision);
  if (input.deltaHistory.length > 0) {
    sections.push(`## Changes Since Last Turn`, deltaText);
  }

  // Compact state snapshot — always include but keep it tight.
  sections.push(renderCompactState({
    heading: "Current State",
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
  }));

  // Durable memory — only recent decisions and entity updates, skip
  // global knowledge (already loaded in bootstrap, changes rarely).
  sections.push(renderDurableMemory({
    knowledgeDigest: null,
    recentDecisionsDigest: input.recentDecisionsDigest,
    projectEntityDigest: input.projectEntityDigest,
  }));

  // Human turn — the actual message.
  sections.push(`## Human Turn`, input.humanMessage);

  return sections.join("\n\n");
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
- Your visible text IS the human's experience. Never dump raw run metadata, frontmatter attributes, token counts, or internal state into your response. Synthesize human-readable summaries instead.
- Never echo raw tool call output (bash results, git logs, git diffs, file contents, command output) verbatim into your response. Summarize what you learned from them in prose. If you catch yourself about to paste a diff or command output, stop — write a one-sentence summary instead.
- When reporting worker completions, describe WHAT was accomplished ("critic approved with two notes") not HOW the system routed it (run IDs, models, exit codes).
- If action is needed, do it yourself through files or \`hive\` commands. Do not tell the human to operate the system for you.
- BOARD.md is steward-owned. Update it directly when plan/task state changes.
- Use the \`delegate\` tool to dispatch workers. Do NOT write assignment files manually with \`write\`.
- Use \`plan_goal\` to decompose large goals into parallel tasks before delegating. This replaces the old dream planner — you ARE the planner now.
- Use \`list_models\` to check available models before delegating.
- If the human asks for multiple runtimes/models or parallel work, call \`delegate\` multiple times. Do not say you delegated and then do the work yourself.
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
