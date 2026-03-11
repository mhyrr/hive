import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { digestBoard, listSkills } from "../lib/digest";
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
  const essentialSkills = ["state-efficient-ops"];
  const essentialSkillPaths = essentialSkills
    .filter((name) => availableSkillNames.includes(name))
    .map((name) => `${paths.skillsDir}/${name}.md`);

  return `# HIVE Agent Prompt

You are ${agentId} for project ${activeProject}. Operate from the files below, not assumptions.

## Identity
${soul.trim()}

## Runtime Rules
- Read ${paths.agents} for full operational protocols before starting work.
- Read essential skills before starting work: ${essentialSkillPaths.join(", ") || "(none)"}
- Read ${projectPaths.board} before acting — it's the shared state snapshot.
- The authoritative hive files are not in the repo root. Use the absolute paths below.
- Check \`hive inbox ${agentId}\` between major steps. Use \`./hive inbox ${agentId}\` when the binary is built locally but not installed on PATH.
- When you answer or finish a message-driven task, resolve it with \`hive msg resolve <message> ${agentId} <answer>\` or \`./hive msg resolve <message> ${agentId} <answer>\`.
- Close obsolete threads with \`hive msg close <message> ${agentId} [note]\` or \`./hive msg close <message> ${agentId} [note]\`.
- Write durable decisions and learnings to LOG.md before ending the session.
- Stay inside your stated scope unless the orchestrator or human reassigns you.

## Agent
id: ${agentId}
persona: ${resolvedAgent.persona} (${personaPath})
descriptor: ${resolvedAgent.descriptor}
project: ${activeProject}
repo: ${repoPath}
hive-home: ${paths.home}

## Files
SOUL.md: ${paths.soul}
SELF.md: ${paths.self}
AGENTS.md: ${paths.agents}
persona: ${personaPath}
project-config: ${projectPaths.config}
PLAN.md: ${projectPaths.plan}
BOARD.md: ${projectPaths.board}
LOG.md: ${projectPaths.log}
project-memory: ${projectPaths.memory}
messages-dir: ${paths.msgDir}

## Available Skills
${listSkills(paths.skillsDir, availableSkillNames)}

## Your Assignment
${assignment}

## Board Summary
${digestBoard(board)}

## Open Messages For You
${renderMessages(messages)}`;
}
