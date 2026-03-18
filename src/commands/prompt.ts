import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { digestBoard, listSkills } from "../lib/digest";
import { UsageError } from "../lib/errors";
import { loadPromptMemoryContext } from "../lib/memory";
import { listOpenProjectMessages } from "../lib/messages";

const BOOTSTRAP_MAX_CHARS = 20_000;

function capContent(content: string, label: string): string {
  if (content.length <= BOOTSTRAP_MAX_CHARS) {
    return content;
  }

  return `${content.slice(0, BOOTSTRAP_MAX_CHARS)}\n\n[... ${label} truncated at ${BOOTSTRAP_MAX_CHARS} chars ...]`;
}
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import {
  extractRepoPath,
  findPlanAgent,
  parseDefaultTeam,
} from "../lib/project";

function renderMessages(messages: Awaited<ReturnType<typeof listOpenProjectMessages>>): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages.map((message) => `### ${message.filename}\n${message.raw}`).join("\n\n");
}

async function listAvailableSkills(skillsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir);
    return entries
      .filter((e) => e.endsWith(".md"))
      .map((e) => e.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

async function readProjectMemory(memoryPath: string): Promise<string> {
  try {
    const file = Bun.file(memoryPath);

    if (!(await file.exists())) {
      return "(none yet)";
    }

    const content = (await file.text()).trim();

    return content || "(none yet)";
  } catch {
    return "(none yet)";
  }
}

export async function promptCommand(args: string[]): Promise<string> {
  const agentId = args[0];

  if (!agentId) {
    throw new UsageError("Usage: hive prompt <agent-id>");
  }

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const soul = await Bun.file(paths.soul).text();
  const projectConfig = await Bun.file(projectPaths.config).text();
  const board = await Bun.file(projectPaths.board).text();
  const projectMemory = await readProjectMemory(projectPaths.memory);
  const memoryContext = await loadPromptMemoryContext(paths, activeProject);
  const plan = await Bun.file(projectPaths.plan).text();
  const repoPath = extractRepoPath(projectConfig) ?? "(unknown)";
  const planAgent = findPlanAgent(plan, agentId);
  const teamAgent = parseDefaultTeam(projectConfig).find((agent) => agent.id === agentId);
  const resolvedAgent = planAgent ?? teamAgent;

  if (!resolvedAgent) {
    const knownAgents = [
      ...new Set([
        ...parseDefaultTeam(projectConfig).map((agent) => agent.id),
        ...plan.matchAll(/^###\s+([^\s(]+)/gm).map((match) => match[1]),
      ]),
    ].join(", ");

    throw new UsageError(`Unknown agent: ${agentId}${knownAgents ? ` (${knownAgents})` : ""}`);
  }

  const personaPath = join(paths.personasDir, `${resolvedAgent.persona}.md`);
  const personaFile = Bun.file(personaPath);

  if (!(await personaFile.exists())) {
    throw new UsageError(`Missing persona file: ${resolvedAgent.persona}`);
  }

  const messages = (await listOpenProjectMessages(paths.msgDir, activeProject)).filter(
    (message) => message.attributes.to === agentId,
  );
  const assignment =
    "body" in resolvedAgent && resolvedAgent.body
      ? resolvedAgent.body
      : "No active assignment in PLAN.md. Default to the project configuration and the live board.";

  const availableSkillNames = await listAvailableSkills(paths.skillsDir);
  const essentialSkills = ["state-efficient-ops", "autonomous-ops"];
  const essentialSkillPaths = essentialSkills
    .filter((name) => availableSkillNames.includes(name))
    .map((name) => `${paths.skillsDir}/${name}.md`);

  return `# HIVE Agent Prompt

You are ${agentId} for project ${activeProject}. Operate from the files below, not assumptions.

## Shared Soul
${capContent(soul.trim(), "SOUL.md")}

## Before Your First Action
Read these skills — they define how you think:
${essentialSkillPaths.map((p) => `- ${p}`).join("\n") || "- (none)"}
Read agent identity: ${paths.identity}
Read user preferences: ${paths.self}
Read operational protocols: ${paths.agents}
Read trust policy: ${paths.trust}

## Runtime Rules
- Read ${projectPaths.board} before acting — it's the shared state snapshot.
- The authoritative hive files are not in the repo root. Use the absolute paths below.
- Check \`hive inbox ${agentId}\` between major steps. Use \`./hive inbox ${agentId}\` when the binary is built locally but not installed on PATH.
- When you answer or finish a message-driven task, resolve it with \`hive msg resolve <message> ${agentId} <answer>\` or \`./hive msg resolve <message> ${agentId} <answer>\`.
- Close obsolete threads with \`hive msg close <message> ${agentId} [note]\` or \`./hive msg close <message> ${agentId} [note]\`.
- Stay inside your stated scope unless the steward or human reassigns you.

## Initiative
You take action without being told. When you make a decision, record it: \`hive memory decision "..."\`. When you discover a convention, record it: \`hive memory convention "..."\`. When you learn a durable fact, record it: \`hive memory fact "..."\`. Record as you go — don't batch.

## Before You Exit
Your context window dies when you exit. Anything you learned that isn't in a file is lost forever. Before finishing:
1. Flush decisions, conventions, and facts to memory via the commands above.
2. Log a summary of what you built and any trade-offs to LOG.md via \`hive log\`.
3. If you hit a dead end or chose between approaches, record WHY — the next agent will face the same choice.

## Agent
id: ${agentId}
persona: ${resolvedAgent.persona} (${personaPath})
descriptor: ${resolvedAgent.descriptor}
project: ${activeProject}
repo: ${repoPath}
hive-home: ${paths.home}

## Files
SOUL.md: ${paths.soul}
IDENTITY.md: ${paths.identity}
SELF.md: ${paths.self}
AGENTS.md: ${paths.agents}
TRUST.md: ${paths.trust}
persona: ${personaPath}
project-config: ${projectPaths.config}
PLAN.md: ${projectPaths.plan}
BOARD.md: ${projectPaths.board}
LOG.md: ${projectPaths.log}
project-memory: ${projectPaths.memory}
memory-summary-json: ${memoryContext.memorySummaryPath}
memory-heat-json: ${memoryContext.memoryHeatPath}
recent-decisions-json: ${memoryContext.recentDecisionsPath}
project-entity-summary: ${memoryContext.projectEntitySummaryPath}
journal: ${memoryContext.journalPath}
messages-dir: ${paths.msgDir}

## Available Skills
${listSkills(paths.skillsDir, availableSkillNames)}

## Your Assignment
${assignment}

## Board Summary
${digestBoard(board)}

## Project Memory
${projectMemory}

## Durable Memory
### Global Knowledge
${memoryContext.globalKnowledgeDigest}

### Recent Decisions
${memoryContext.recentDecisionsDigest}

### Project Entity Memory
${memoryContext.projectEntityDigest}

## Open Messages For You
${renderMessages(messages)}`;
}
