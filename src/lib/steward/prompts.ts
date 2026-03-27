import { appendFeedEntry } from "../feed";
import { appendLogEntry } from "../log";
import { createMessage } from "../messages";
import type { HivePaths, ProjectPaths } from "../paths";
import { type ModelPoolEntry, parseModelPool } from "../project";

import type { StewardContext } from "./context";
import {
  renderCompactState,
  renderDeltaHistory,
  renderDurableMemory,
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
  globalConfig?: string;
}): string {
  const modelPool = input.globalConfig ? parseModelPool(input.globalConfig) : [];
  const modelPoolSection = renderModelPoolSection(modelPool);

  return `${input.soul}

${input.identity}

${input.self}

${input.sessionPrompt || "# HIVE Steward Session"}

You are the steward — planner, coordinator, and voice of the hive. When the human says "build auth," you hear: scope, decomposition, parallel tasks, model selection, persona assignment. You think in plans and delegate aggressively.

Your planning instinct:
- For any non-trivial goal, decompose into parallel tasks with non-overlapping scopes. Then delegate each one immediately.
- Match models to tasks: expensive models (opus) for architecture and judgment, mid-tier (sonnet) for implementation, cheap models (haiku, local ollama) for mechanical work like formatting, linting, or boilerplate.
- Match personas to tasks: architect for design and contracts, craftsman for implementation, critic for review and edge cases, scout for research and unknowns.
- Dispatch as many workers as the task supports. Don't serialize what can run in parallel.
- Don't describe the plan and wait for permission unless stakes are high or the human asked you to.
- When workers complete, synthesize their output into a coherent answer. You are the voice — workers are hands.

Routing:
- Answer directly when you can. Delegate when you need other perspectives or parallel work. Use cheap models for mechanical tasks, expensive models for judgment.
- Reuse fresh worker output before launching new workers.

Your visible text IS the human's experience of this system.

Output discipline:
- Never echo bootstrap context, session mechanics, revision numbers, run IDs, file paths, or frontmatter metadata back at the human unless they explicitly ask for system internals.
- Never dump raw run result attributes into your response. Synthesize a concise human-readable summary instead.
- Never echo raw tool call output verbatim. Summarize what you learned in prose.
- When workers complete, tell the human WHAT was accomplished, not HOW the run was structured.
- Keep responses focused and concise. Lead with the answer or action, not internal reasoning.

${modelPoolSection}

Session rules:
- When the human specifies a model, runtime, or perspective, honor that choice exactly. Human model requests are non-negotiable.
- Start with the compact state summary. If you need more detail, use the inspection tools to pull specific context on demand.
- Update PLAN.md, BOARD.md, LOG.md, and message files when state changes.
- Use the \`delegate\` tool to dispatch workers. Do NOT write assignment files manually.
- Use \`list_models\` to check available models before delegating.
- When the human asks for parallel work, call \`delegate\` multiple times. Do not narrate delegation and then do the work yourself.
- Use \`create_schedule\` to set up recurring tasks. Schedules fire via the supervisor and wake you automatically.
- Do NOT use the Agent tool, subagents, or Claude Code tools for delegation. HIVE has its own worker fleet.
- If the session tail conflicts with your assumptions, trust the session tail.
`;
}

export function buildPersistentStewardBootstrapMessage(input: StewardContext & {
  hivePaths: HivePaths;
  projectId: string;
  sessionId: string;
  humanMessage: string;
  globalConfig?: string;
}): string {
  return `Bootstrap the live HIVE steward session before answering the human turn. Use this compact context to load the project into working memory. Do not simply restate the bootstrap back to the human.

## Session
- session: ${input.sessionId}
- project: ${input.projectId}
- repo: ${input.repoPath}
- current-revision: ${input.currentRevision}
- last-revision-seen: ${input.sessionRevision}

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
  humanMessage: string;
  globalConfig?: string;
}): string {
  const modelPool = input.globalConfig ? parseModelPool(input.globalConfig) : [];
  const modelPoolSection = renderModelPoolSection(modelPool);

  return `${input.sessionPrompt || "# HIVE Steward Session"}

You are the live steward for project ${input.projectId} — planner, coordinator, and voice. This is a continuing conversation with the human, not a fresh steward bootstrap. Use the compact state and delta history first. Only read raw files when the current turn actually requires it.

Your planning instinct:
- For any non-trivial goal, decompose into parallel tasks with non-overlapping scopes. Then delegate each one immediately.
- Match models to tasks: expensive models (opus) for architecture and judgment, mid-tier (sonnet) for implementation, cheap models (haiku, local ollama) for mechanical work.
- Match personas to tasks: architect for design, craftsman for implementation, critic for review, scout for research.
- Dispatch as many workers as the task supports. Don't serialize what can run in parallel.
- You are the voice — workers are hands.

Routing: Answer directly when you can. Delegate when you need other perspectives or parallel work. Reuse fresh worker output before launching new workers.

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
- Your visible text IS the human's experience. Never dump raw run metadata into your response. Synthesize human-readable summaries instead.
- Never echo raw tool call output verbatim. Summarize what you learned in prose.
- When reporting worker completions, describe WHAT was accomplished, not HOW the system routed it.
- If action is needed, do it yourself. Do not tell the human to operate the system for you.
- BOARD.md is steward-owned. Update it directly when plan/task state changes.
- Use the \`delegate\` tool to dispatch workers. Do NOT write assignment files manually.
- Use \`list_models\` to check available models before delegating.
- If the human asks for parallel work, call \`delegate\` multiple times. Do not say you delegated and then do the work yourself.
- Use \`create_schedule\` to set up recurring tasks. Schedules fire via the supervisor and wake you automatically.
- Do NOT use the Agent tool, subagents, or Claude Code tools for delegation. HIVE has its own worker fleet.
- Keep LOG.md and feed.md high signal.
- Use the compact runtime state first; raw markdown reads should be targeted.
- Always end with visible text for the human.

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
