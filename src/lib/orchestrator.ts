import { appendLogEntry } from "./log";
import { appendFeedEntry } from "./feed";
import {
  renderCognitiveRoutingPromptPolicy,
  STEWARD_ESSENTIAL_SKILL_NAMES,
} from "./cognitive-routing";
import { digestBoard, listSkills } from "./digest";
import { HiveMessage, createMessage } from "./messages";
import { HivePaths, ProjectPaths } from "./paths";
import { parseBoard, minutesSince } from "./board";
import { RunRecord, RunResult } from "./runs";
import { formatRuntimeTokenSummary, listRuntimeAdapters } from "./runtime";

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

async function renderAvailableRuntimes(): Promise<string> {
  const adapters = listRuntimeAdapters();
  const lines: string[] = [];

  for (const adapter of adapters) {
    const installed = await adapter.detectInstalled();
    const status = installed ? "installed" : "not installed";
    const aliases = adapter.aliases.length ? ` (aliases: ${adapter.aliases.join(", ")})` : "";
    lines.push(`- ${adapter.name}: ${status}${aliases}`);
  }

  lines.push("");
  lines.push("To assign a specific runtime to an agent, include `runtime: <name>` in the assignment message frontmatter.");
  lines.push("The team config may also specify runtimes via `agent: persona via <runtime>` syntax.");

  return lines.join("\n");
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
    .map((result) => {
      const lines = [
        `### ${result.runId} (${result.agentId})`,
        `status: ${result.status}`,
        `exit-code: ${result.exitCode ?? "unknown"}`,
        `assignment: ${result.assignmentMessage ?? "(none)"}`,
        `assignment-status-after-exit: ${result.assignmentStatusAfterExit ?? "(none)"}`,
        `assignment-resolved-by-worker: ${result.assignmentResolvedByWorker ? "yes" : "no"}`,
        `files-changed: ${result.changedFiles.join(", ") || "(none detected)"}`,
        `git-summary: ${result.gitSummaryLines.join("; ") || "(none detected)"}`,
      ];

      if (
        result.authMode ||
        result.durationMs ||
        result.numTurns ||
        result.costUsd ||
        result.inputTokens ||
        result.outputTokens ||
        result.cacheCreationInputTokens ||
        result.cacheReadInputTokens ||
        result.totalTokens
      ) {
        const usage: string[] = [];

        if (result.authMode) {
          usage.push(`auth ${result.authMode}`);
        }

        if (result.durationMs) {
          usage.push(`${(result.durationMs / 1000).toFixed(1)}s`);
        }

        if (result.numTurns) {
          usage.push(`${result.numTurns} turns`);
        }

        const tokenSummary = formatRuntimeTokenSummary({
          authMode: result.authMode ?? "unknown",
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          durationApiMs: null,
          numTurns: result.numTurns,
          sessionId: null,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          totalTokens: result.totalTokens,
        });

        if (tokenSummary) {
          usage.push(tokenSummary);
        }

        if (result.costUsd) {
          usage.push(`$${result.costUsd.toFixed(4)}`);
        }

        lines.push(`usage: ${usage.join(" | ")}`);
      }

      lines.push("final-visible-output:", result.finalVisibleOutput || "(none)");

      return lines.join("\n");
    })
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

const BOOTSTRAP_MAX_CHARS_PER_FILE = 20_000;
const BOOTSTRAP_MAX_CHARS_TOTAL = 150_000;

function capBootstrapContent(content: string, label: string): string {
  if (content.length <= BOOTSTRAP_MAX_CHARS_PER_FILE) {
    return content;
  }

  return `${content.slice(0, BOOTSTRAP_MAX_CHARS_PER_FILE)}\n\n[... ${label} truncated at ${BOOTSTRAP_MAX_CHARS_PER_FILE} chars ...]`;
}

async function loadEssentialSkills(
  skillsDir: string,
  availableSkillNames: string[],
): Promise<string> {
  const loaded: string[] = [];

  for (const name of STEWARD_ESSENTIAL_SKILL_NAMES) {
    if (!availableSkillNames.includes(name)) continue;
    const content = await readFileOrDefault(`${skillsDir}/${name}.md`, "");
    if (content) {
      loaded.push(`### ${name}\n${content}`);
    }
  }

  return loaded.length > 0 ? loaded.join("\n\n") : "(none)";
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

  // Inline essential content so the agent can act immediately without file reads
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
${renderCognitiveRoutingPromptPolicy({
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

## File Paths (for writes/actions only)
SOUL.md: ${input.pathsSoul}
IDENTITY.md: ${input.pathsIdentity}
SELF.md: ${input.pathsSelf}
AGENTS.md: ${input.pathsAgents}
TRUST.md: ${input.pathsTrust}
persona: ${input.personaPath}
project-config: ${input.projectConfigPath}
PLAN.md: ${input.planPath}
BOARD.md: ${input.boardPath}
LOG.md: ${input.logPath}
project-memory: ${input.projectMemoryPath}
memory-summary-json: ${input.memorySummaryPath}
memory-heat-json: ${input.memoryHeatPath}
recent-decisions-json: ${input.recentDecisionsPath}
project-entity-summary: ${input.projectEntitySummaryPath}
journal: ${input.journalPath}
messages-dir: ${input.messagesDir}

## Available Skills
${listSkills(input.skillsDir, input.availableSkillNames)}

## Board Summary
${digestBoard(input.board)}

## Project Memory
${input.projectMemory}

## Durable Memory
### Global Knowledge
${input.knowledgeDigest}

### Recent Decisions
${input.recentDecisionsDigest}

### Project Entity Memory
${input.projectEntityDigest}

## Active Runs
${renderActiveRuns(input.activeRuns)}

## Recent Run Results
${renderRunResults(input.recentRunResults)}

## Open Project Messages
${renderMessages(input.openMessages)}`;
}
