import { join } from "node:path";

import { UsageError } from "../lib/errors";
import { listOpenProjectMessages } from "../lib/messages";
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

async function readIfExists(path: string): Promise<string> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return "";
  }

  return (await file.text()).trim();
}

function renderMessages(messages: Awaited<ReturnType<typeof listOpenProjectMessages>>): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages.map((message) => `### ${message.filename}\n${message.raw}`).join("\n\n");
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
  const self = await Bun.file(paths.self).text();
  const knowledge = await readIfExists(join(paths.memoryDir, "knowledge.md"));
  const projectMemory = await readIfExists(projectPaths.memory);
  const projectConfig = await Bun.file(projectPaths.config).text();
  const plan = await Bun.file(projectPaths.plan).text();
  const board = await Bun.file(projectPaths.board).text();
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
  const persona = await readIfExists(personaPath);

  if (!persona) {
    throw new UsageError(`Missing persona file: ${resolvedAgent.persona}`);
  }

  const messages = (await listOpenProjectMessages(paths.msgDir, activeProject)).filter(
    (message) => message.attributes.to === agentId,
  );
  const assignment =
    "body" in resolvedAgent && resolvedAgent.body
      ? resolvedAgent.body
      : "No active assignment in PLAN.md. Default to the project configuration and the live board.";

  return `# HIVE Agent Prompt

You are ${agentId} for project ${activeProject}. Operate from the files below, not assumptions.

## Runtime Rules
- Respect BOARD.md as the shared state snapshot. If you need it changed, send a message.
- Post status, questions, handoffs, and contracts through message files in ~/.hive/msg/.
- Use \`hive inbox ${agentId}\` between major steps instead of manually polling the full prompt. In this repo, use \`./hive inbox ${agentId}\` when the binary is built locally but not installed on PATH.
- When you answer or finish a message-driven task, resolve it with \`hive msg resolve <message> ${agentId} <answer>\` or \`./hive msg resolve <message> ${agentId} <answer>\`. Close obsolete threads with \`hive msg close <message> ${agentId} [note]\` or \`./hive msg close <message> ${agentId} [note]\`.
- Write durable decisions and learnings to LOG.md before ending the session.
- Stay inside your stated scope unless the orchestrator or human reassigns you.

## Agent Identity
id: ${agentId}
persona: ${resolvedAgent.persona}
descriptor: ${resolvedAgent.descriptor}
project: ${activeProject}
repo: ${repoPath}
hive-home: ${paths.home}

## SOUL.md
${soul.trim()}

## SELF.md
${self.trim()}

## Persona
${persona}

## Hive Knowledge
${knowledge || "(none yet)"}

## Project Memory
${projectMemory || "(none yet)"}

## Project Config
${projectConfig.trim()}

## Your Assignment
${assignment}

## Active PLAN.md
${plan.trim()}

## BOARD.md Snapshot
${board.trim()}

## Open Messages For You
${renderMessages(messages)}`;
}
