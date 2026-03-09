import { UsageError } from "./errors";

export type PlanAgent = {
  id: string;
  descriptor: string;
  persona: string;
  body: string;
};

export type TeamAgent = {
  id: string;
  descriptor: string;
  persona: string;
};

export function normalizeProjectName(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new UsageError("Project name must contain letters or numbers.");
  }

  return normalized;
}

export function extractRepoPath(projectConfig: string): string | null {
  const match = projectConfig.match(/^path:\s*(.+)$/m);

  return match ? match[1].trim() : null;
}

export function parsePlanAgents(plan: string): PlanAgent[] {
  const normalized = plan.replace(/\r\n/g, "\n");
  const matches = [
    ...normalized.matchAll(
      /^###\s+([^\s(]+)\s+\(([^)]+)\)\n([\s\S]*?)(?=^##\s+|^###\s+|$)/gm,
    ),
  ];

  return matches.map((match) => {
    const id = match[1].trim();
    const descriptor = match[2].trim();
    const body = match[3].trim();

    return {
      id,
      descriptor,
      persona: extractPersonaName(descriptor),
      body,
    };
  });
}

export function findPlanAgent(plan: string, agentId: string): PlanAgent | null {
  return parsePlanAgents(plan).find((agent) => agent.id === agentId) ?? null;
}

export function parseDefaultTeam(projectConfig: string): TeamAgent[] {
  const normalized = projectConfig.replace(/\r\n/g, "\n");
  const defaultTeamMatch = normalized.match(
    /^## Default Team\s*\n([\s\S]*?)(?=^##\s+|$)/m,
  );

  if (!defaultTeamMatch) {
    return [];
  }

  return defaultTeamMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2))
    .map((line) => {
      const separatorIndex = line.indexOf(":");

      if (separatorIndex === -1) {
        return null;
      }

      const id = line.slice(0, separatorIndex).trim();
      const descriptor = line.slice(separatorIndex + 1).trim();

      return {
        id,
        descriptor,
        persona: extractPersonaName(descriptor),
      };
    })
    .filter((agent): agent is TeamAgent => Boolean(agent));
}

export function extractPersonaName(descriptor: string): string {
  const match = descriptor.match(/[a-z0-9_-]+/i);

  return match ? match[0].toLowerCase() : descriptor.trim().toLowerCase();
}
