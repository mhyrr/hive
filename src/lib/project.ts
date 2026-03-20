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

const SUPPORTED_PERSONAS = ["architect", "craftsman", "critic", "scout", "steward"] as const;

type SupportedPersona = (typeof SUPPORTED_PERSONAS)[number];

function splitScopeRoots(value: string): string[] {
  return [...new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => normalizeScopeRoot(entry))
      .filter((entry): entry is string => Boolean(entry)),
  )];
}

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

export function extractProjectConfigValue(projectConfig: string, key: string): string | null {
  const match = projectConfig.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));

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
  const sectionHeading = normalized.match(/^## Default Team\s*$/m);

  if (!sectionHeading || sectionHeading.index === undefined) {
    return [];
  }

  const sectionStart = sectionHeading.index + sectionHeading[0].length + 1;
  const remainder = normalized.slice(sectionStart);
  const nextHeadingIndex = remainder.search(/^##\s+/m);
  const section =
    nextHeadingIndex === -1 ? remainder.trim() : remainder.slice(0, nextHeadingIndex).trim();

  return section
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

function normalizeSupportedPersona(value: string | null | undefined): SupportedPersona | null {
  const normalized = value?.trim().toLowerCase() ?? "";

  return (SUPPORTED_PERSONAS as readonly string[]).includes(normalized)
    ? normalized as SupportedPersona
    : null;
}

function inferAdHocPersonaFromBody(body: string): SupportedPersona | null {
  const roleMatch =
    body.match(/\byou are (?:an?\s+|the\s+)?([a-z0-9_-]+)\b/i) ??
    body.match(/\bact as (?:an?\s+|the\s+)?([a-z0-9_-]+)\b/i);

  return normalizeSupportedPersona(roleMatch?.[1] ?? null);
}

function inferAdHocPersonaFromAgentId(agentId: string): SupportedPersona | null {
  const normalized = agentId.trim().toLowerCase();

  if (/(critic|eval|review|audit|redteam|qa)/.test(normalized)) {
    return "critic";
  }

  if (/(scout|research|explore|discover)/.test(normalized)) {
    return "scout";
  }

  if (/(architect|design|planner|plan)/.test(normalized)) {
    return "architect";
  }

  if (/(steward|orchestrator)/.test(normalized)) {
    return "steward";
  }

  return null;
}

function buildAdHocDescriptor(input: {
  persona: string;
  runtimeHint?: string | null;
  modelHint?: string | null;
}): string {
  const runtime = input.runtimeHint?.trim() ?? "";
  const model = input.modelHint?.trim() ?? "";

  if (runtime && model) {
    return `${input.persona}, ${model} via ${runtime}`;
  }

  if (runtime) {
    return `${input.persona} via ${runtime}`;
  }

  return `ad hoc ${input.persona}`;
}

export function resolveProjectAgent(input: {
  plan: string;
  projectConfig: string;
  agentId: string;
  allowAdHoc?: boolean;
  assignmentBody?: string | null;
  assignmentPersona?: string | null;
  runtimeHint?: string | null;
  modelHint?: string | null;
}): PlanAgent | TeamAgent | null {
  const planAgent = findPlanAgent(input.plan, input.agentId);

  if (planAgent) {
    return planAgent;
  }

  const teamAgent = parseDefaultTeam(input.projectConfig).find((agent) => agent.id === input.agentId);

  if (teamAgent) {
    return teamAgent;
  }

  if (!input.allowAdHoc) {
    return null;
  }

  const persona =
    normalizeSupportedPersona(input.assignmentPersona) ??
    inferAdHocPersonaFromBody(input.assignmentBody ?? "") ??
    inferAdHocPersonaFromAgentId(input.agentId) ??
    "craftsman";

  return {
    id: input.agentId,
    persona,
    descriptor: buildAdHocDescriptor({
      persona,
      runtimeHint: input.runtimeHint,
      modelHint: input.modelHint,
    }),
  };
}

export function stripRuntimeHintsFromDescriptor(descriptor: string): string {
  return descriptor
    .trim()
    .replace(/\s*,\s*[^,()]+?\s+via\s+[a-z0-9._-]+\b/gi, "")
    .replace(/\s+via\s+[a-z0-9._-]+\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*$/, "")
    .trim();
}

export function extractBodyValue(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));

  return match ? match[1].trim() : null;
}

export function normalizeScopeRoot(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed === "*") {
    return "*";
  }

  let normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");

  normalized = normalized.replace(/\/\*\*$/, "");
  normalized = normalized.replace(/\/\*$/, "");
  normalized = normalized.replace(/\/+$/, "");

  return normalized || null;
}

export function parseScopeRoots(value: string | null | undefined): string[] | null {
  if (!value?.trim()) {
    return null;
  }

  const roots = splitScopeRoots(value);

  if (roots.length === 0 || roots.includes("*")) {
    return null;
  }

  return roots;
}

function looksLikeRepoScope(value: string): boolean {
  return /[/*.]/.test(value) || value.includes("/");
}

export function extractScopeRootsFromDescriptor(descriptor: string): string[] | null {
  const explicitMatch = descriptor.match(/\bscope(?:d)?(?:\s+to)?\s*:?\s*([^)]+)$/i);

  if (explicitMatch) {
    return parseScopeRoots(explicitMatch[1]);
  }

  const arrowIndex = descriptor.indexOf("->");

  if (arrowIndex === -1) {
    return null;
  }

  const candidate = descriptor.slice(arrowIndex + 2).trim();

  if (!candidate || !looksLikeRepoScope(candidate)) {
    return null;
  }

  return parseScopeRoots(candidate);
}

export function resolveAgentScopeRoots(input: {
  plan: string;
  projectConfig: string;
  agentId: string;
  assignmentScope?: string | null;
}): string[] | null {
  if (input.assignmentScope?.trim()) {
    return parseScopeRoots(input.assignmentScope);
  }

  const planAgent = findPlanAgent(input.plan, input.agentId);

  if (planAgent) {
    const bodyScope = extractBodyValue(planAgent.body, "scope");

    if (bodyScope?.trim()) {
      return parseScopeRoots(bodyScope);
    }

    const descriptorScope = extractScopeRootsFromDescriptor(planAgent.descriptor);

    if (descriptorScope) {
      return descriptorScope;
    }
  }

  const teamAgent = parseDefaultTeam(input.projectConfig).find((agent) => agent.id === input.agentId);

  if (!teamAgent) {
    return null;
  }

  return extractScopeRootsFromDescriptor(teamAgent.descriptor);
}
