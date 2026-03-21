import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { UsageError } from "./errors";
import { appendEvent, listRecentEvents } from "./events";
import { appendFeedEntry, parseStructuredFeedEntries } from "./feed";
import { readJson, writeJson } from "./json";
import {
  ensureDirectory,
  getProjectPaths,
  listProjects,
  type HivePaths,
} from "./paths";
import { extractRepoPath } from "./project";
import { now, toDateLabel, toDateParts, toIsoTimestamp } from "./time";
import { renderProjectMemoryTemplate } from "./templates";

export type ProjectDecision = {
  ts: string | null;
  text: string;
};

export type ProjectMemorySnapshot = {
  raw: string;
  facts: string[];
  conventions: string[];
  decisions: ProjectDecision[];
  questions: string[];
};

export type EntityType = "project" | "person" | "company";
export type EntityAction = "summary" | "fact" | "note";

export type MemorySummaryProject = {
  id: string;
  repoPath: string | null;
  facts: string[];
  conventions: string[];
  recentDecisions: ProjectDecision[];
  openQuestions: string[];
  signalCount: number;
};

export type MemorySummaryState = {
  extractedAt: string;
  date: string;
  knowledge: string[];
  highlights: string[];
  projects: MemorySummaryProject[];
};

export type MemoryHeatProject = {
  id: string;
  status: "hot" | "warm" | "cold";
  accessCount: number;
  lastAccessed: string | null;
  lastExtracted: string;
  signalCount: number;
  memoryItems: number;
};

export type MemoryHeatState = {
  extractedAt: string;
  projects: MemoryHeatProject[];
};

export type RecentDecisionItem = {
  project: string | null;
  ts: string | null;
  text: string;
  source: "global" | "project";
};

export type PromptMemoryContext = {
  memorySummaryPath: string;
  memoryHeatPath: string;
  recentDecisionsPath: string;
  projectEntitySummaryPath: string;
  journalPath: string;
  globalKnowledgeDigest: string;
  recentDecisionsDigest: string;
  projectEntityDigest: string;
};

export type MemoryRecentDecisionsState = {
  extractedAt: string;
  items: RecentDecisionItem[];
};

type EntityPaths = {
  root: string;
  summary: string;
  items: string;
};

const projectSectionHeaders = {
  facts: "## Durable Facts",
  conventions: "## Conventions",
  decisions: "## Decisions",
  questions: "## Open Questions",
} as const;

const entitySectionHeaders = {
  summary: "## Summary",
  fact: "## Durable Facts",
  note: "## Recent Notes",
} as const;

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

export function appendToSection(
  content: string,
  sectionHeader: string,
  entry: string,
): string {
  const headerIndex = content.indexOf(sectionHeader);

  if (headerIndex === -1) {
    return `${content.trimEnd()}\n\n${sectionHeader}\n${entry}\n`;
  }

  const afterHeader = headerIndex + sectionHeader.length;
  const nextSectionMatch = content.slice(afterHeader).search(/\n## /);
  const sectionEnd =
    nextSectionMatch === -1 ? content.length : afterHeader + nextSectionMatch;
  const sectionBody = content.slice(afterHeader, sectionEnd);

  let updatedBody: string;

  if (sectionBody.includes("(none yet)")) {
    updatedBody = sectionBody.replace("(none yet)", entry);
  } else {
    updatedBody = `${sectionBody.trimEnd()}\n${entry}`;
  }

  const before = content.slice(0, afterHeader);
  const after = content.slice(sectionEnd);

  return `${before}${updatedBody.trimEnd()}\n${after}`;
}

function replaceSection(
  content: string,
  sectionHeader: string,
  body: string,
): string {
  const headerIndex = content.indexOf(sectionHeader);

  if (headerIndex === -1) {
    return `${content.trimEnd()}\n\n${sectionHeader}\n${body.trim()}\n`;
  }

  const afterHeader = headerIndex + sectionHeader.length;
  const nextSectionMatch = content.slice(afterHeader).search(/\n## /);
  const sectionEnd =
    nextSectionMatch === -1 ? content.length : afterHeader + nextSectionMatch;
  const before = content.slice(0, afterHeader);
  const after = content.slice(sectionEnd);

  return `${before}\n${body.trim()}\n${after.startsWith("\n") ? after : `\n${after}`}`.trimEnd() + "\n";
}

function extractSectionBody(content: string, sectionHeader: string): string {
  const headerIndex = content.indexOf(sectionHeader);

  if (headerIndex === -1) {
    return "";
  }

  const afterHeader = headerIndex + sectionHeader.length;
  const nextSectionMatch = content.slice(afterHeader).search(/\n## /);
  const sectionEnd =
    nextSectionMatch === -1 ? content.length : afterHeader + nextSectionMatch;

  return content.slice(afterHeader, sectionEnd).trim();
}

function extractBulletEntries(content: string, sectionHeader: string): string[] {
  const body = extractSectionBody(content, sectionHeader);

  if (!body || body.includes("(none yet)")) {
    return [];
  }

  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
}

function extractDecisionEntries(content: string): ProjectDecision[] {
  return extractBulletEntries(content, projectSectionHeaders.decisions).map((entry) => {
    const match = entry.match(/^\[([^\]]+)\]\s+(.*)$/);

    return {
      ts: match?.[1]?.trim() ?? null,
      text: match?.[2]?.trim() ?? entry,
    };
  });
}

function readLinesFromMarkdown(path: string): Promise<string[]> {
  return Bun.file(path)
    .text()
    .then((text) =>
      normalizeNewlines(text)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => line.replace(/^- /, "").trim())
        .filter((line) => line !== "(none yet)"),
    )
    .catch(() => []);
}

function normalizeEntityId(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new UsageError("Entity id must contain letters or numbers.");
  }

  return normalized;
}

function entityRootDir(paths: HivePaths, type: EntityType): string {
  if (type === "project") {
    return paths.memoryEntitiesProjectsDir;
  }

  if (type === "person") {
    return paths.memoryEntitiesPeopleDir;
  }

  return paths.memoryEntitiesCompaniesDir;
}

export function getEntityPaths(
  paths: HivePaths,
  type: EntityType,
  id: string,
): EntityPaths {
  const normalizedId = normalizeEntityId(id);
  const root = join(entityRootDir(paths, type), normalizedId);

  return {
    root,
    summary: join(root, "summary.md"),
    items: join(root, "items.jsonl"),
  };
}

function renderEntityTemplate(type: EntityType, id: string): string {
  return `# Entity Memory: ${type}/${id}

## Summary
(none yet)

## Durable Facts
(none yet)

## Recent Notes
(none yet)`;
}

async function ensureEntityMemory(
  paths: HivePaths,
  type: EntityType,
  id: string,
): Promise<EntityPaths> {
  const entityPaths = getEntityPaths(paths, type, id);
  await ensureDirectory(entityPaths.root);

  if (!(await Bun.file(entityPaths.summary).exists())) {
    await Bun.write(entityPaths.summary, `${renderEntityTemplate(type, normalizeEntityId(id)).trim()}\n`);
  }

  if (!(await Bun.file(entityPaths.items).exists())) {
    await Bun.write(entityPaths.items, "");
  }

  return entityPaths;
}

export async function readEntityMemory(
  paths: HivePaths,
  type: EntityType,
  id: string,
): Promise<string> {
  const entityPaths = await ensureEntityMemory(paths, type, id);
  return Bun.file(entityPaths.summary).text();
}

export async function updateEntityMemory(input: {
  paths: HivePaths;
  type: Exclude<EntityType, "project">;
  id: string;
  action: EntityAction;
  text: string;
  announce?: boolean;
}): Promise<string> {
  const entityPaths = await ensureEntityMemory(input.paths, input.type, input.id);
  const file = Bun.file(entityPaths.summary);
  const content = await file.text();
  const text = input.text.trim();

  let updated = content;

  if (input.action === "summary") {
    updated = replaceSection(content, entitySectionHeaders.summary, text);
  } else {
    const sectionHeader = entitySectionHeaders[input.action];
    updated = appendToSection(content, sectionHeader, `- ${text}`);
  }

  await Bun.write(entityPaths.summary, `${updated.trimEnd()}\n`);

  const item = {
    ts: toIsoTimestamp(),
    type: input.action,
    text,
  };
  const existing = (await Bun.file(entityPaths.items).text().catch(() => "")).trim();
  const prefix = existing ? `${existing}\n` : "";
  await Bun.write(entityPaths.items, `${prefix}${JSON.stringify(item)}\n`);

  if (input.announce ?? true) {
    await appendFeedEntry(input.paths, {
      headline: `Memory entity updated: ${input.type}/${normalizeEntityId(input.id)}`,
      details: [`${input.action}: ${text}`],
    });
    await appendEvent({
      paths: input.paths,
      kind: "memory.entity.updated",
      source: "memory",
      summary: `${input.type}/${normalizeEntityId(input.id)}`,
      details: [`${input.action}: ${text}`],
      data: {
        entityType: input.type,
        entityId: normalizeEntityId(input.id),
        action: input.action,
      },
    });
  }

  return `Recorded ${input.action} for ${input.type}/${normalizeEntityId(input.id)}: ${text}`;
}

export async function ensureProjectMemoryFile(
  paths: HivePaths,
  projectId: string,
): Promise<string> {
  const projectPaths = getProjectPaths(paths, projectId);
  const file = Bun.file(projectPaths.memory);

  if (!(await file.exists())) {
    await Bun.write(projectPaths.memory, `${renderProjectMemoryTemplate(projectId).trim()}\n`);
  }

  return projectPaths.memory;
}

export async function readProjectMemorySnapshot(
  paths: HivePaths,
  projectId: string,
): Promise<ProjectMemorySnapshot> {
  const memoryPath = await ensureProjectMemoryFile(paths, projectId);
  const raw = await Bun.file(memoryPath).text();

  return {
    raw,
    facts: extractBulletEntries(raw, projectSectionHeaders.facts),
    conventions: extractBulletEntries(raw, projectSectionHeaders.conventions),
    decisions: extractDecisionEntries(raw),
    questions: extractBulletEntries(raw, projectSectionHeaders.questions),
  };
}

function journalPathForDate(paths: HivePaths, date: Date = now()): string {
  const { year, month, day } = toDateParts(date);
  return join(paths.journalDir, year, month, `${day}.md`);
}

function renderDecisionDigest(decisions: RecentDecisionItem[]): string {
  if (decisions.length === 0) {
    return "(none)";
  }

  return decisions
    .slice(0, 6)
    .map((decision) =>
      `- ${decision.project ? `[${decision.project}] ` : ""}${decision.ts ? `[${decision.ts}] ` : ""}${decision.text}`,
    )
    .join("\n");
}

function renderProjectEntityDigest(project: MemorySummaryProject | null): string {
  if (!project) {
    return "(none yet)";
  }

  const lines: string[] = [];

  if (project.facts.length > 0) {
    lines.push(`facts: ${project.facts.slice(0, 3).join(" | ")}`);
  }

  if (project.conventions.length > 0) {
    lines.push(`conventions: ${project.conventions.slice(0, 3).join(" | ")}`);
  }

  if (project.recentDecisions.length > 0) {
    lines.push(
      `decisions: ${project.recentDecisions
        .slice(0, 3)
        .map((decision) => decision.text)
        .join(" | ")}`,
    );
  }

  if (project.openQuestions.length > 0) {
    lines.push(`open-questions: ${project.openQuestions.slice(0, 2).join(" | ")}`);
  }

  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "(none yet)";
}

function renderKnowledgeDigest(knowledge: string[]): string {
  if (knowledge.length === 0) {
    return "(none)";
  }

  return knowledge.slice(0, 6).map((line) => `- ${line}`).join("\n");
}

function buildJournalContent(input: {
  dateLabel: string;
  highlights: string[];
  internalEvents: string[];
  externalEvents: string[];
  projects: MemorySummaryProject[];
  recentDecisions: RecentDecisionItem[];
}): string {
  const projectSections =
    input.projects.length === 0
      ? "(none)"
      : input.projects
          .map((project) =>
            [
              `### ${project.id}`,
              `- facts: ${project.facts.length}`,
              `- conventions: ${project.conventions.length}`,
              `- decisions: ${project.recentDecisions.length}`,
              `- open-questions: ${project.openQuestions.length}`,
            ].join("\n"),
          )
          .join("\n\n");

  return `# Journal: ${input.dateLabel}

## Highlights
${input.highlights.length > 0 ? input.highlights.map((line) => `- ${line}`).join("\n") : "(none)"}

## Internal Events
${input.internalEvents.length > 0 ? input.internalEvents.map((line) => `- ${line}`).join("\n") : "(none)"}

## External Events
${input.externalEvents.length > 0 ? input.externalEvents.map((line) => `- ${line}`).join("\n") : "(none)"}

## Projects
${projectSections}

## Recent Decisions
${input.recentDecisions.length > 0 ? input.recentDecisions.slice(0, 10).map((decision) => `- ${decision.project ? `[${decision.project}] ` : ""}${decision.ts ? `[${decision.ts}] ` : ""}${decision.text}`).join("\n") : "(none)"}`;
}

function renderProjectEntitySummary(input: MemorySummaryProject): string {
  return `# Entity Memory: project/${input.id}

## Summary
Derived snapshot for ${input.id}${input.repoPath ? ` (${input.repoPath})` : ""}.

## Durable Facts
${input.facts.length > 0 ? input.facts.map((line) => `- ${line}`).join("\n") : "(none yet)"}

## Conventions
${input.conventions.length > 0 ? input.conventions.map((line) => `- ${line}`).join("\n") : "(none yet)"}

## Recent Decisions
${input.recentDecisions.length > 0 ? input.recentDecisions.map((decision) => `- ${decision.ts ? `[${decision.ts}] ` : ""}${decision.text}`).join("\n") : "(none yet)"}

## Open Questions
${input.openQuestions.length > 0 ? input.openQuestions.map((line) => `- ${line}`).join("\n") : "(none yet)"}`;
}

async function writeProjectEntityArtifacts(
  paths: HivePaths,
  project: MemorySummaryProject,
): Promise<void> {
  const entityPaths = getEntityPaths(paths, "project", project.id);
  await ensureDirectory(entityPaths.root);
  await Bun.write(entityPaths.summary, `${renderProjectEntitySummary(project).trim()}\n`);

  const items = [
    ...project.facts.map((text) => ({ kind: "fact", text })),
    ...project.conventions.map((text) => ({ kind: "convention", text })),
    ...project.recentDecisions.map((decision) => ({
      kind: "decision",
      text: decision.text,
      ts: decision.ts,
    })),
    ...project.openQuestions.map((text) => ({ kind: "question", text })),
  ];

  await Bun.write(
    entityPaths.items,
    items.map((item) => JSON.stringify(item)).join("\n") + (items.length > 0 ? "\n" : ""),
  );
}

export async function extractMemory(input: {
  paths: HivePaths;
  announce?: boolean;
}): Promise<{
  journalPath: string;
  memorySummaryPath: string;
  memoryHeatPath: string;
  recentDecisionsPath: string;
}> {
  const timestamp = toIsoTimestamp();
  const dateLabel = toDateLabel();
  const projectIds = await listProjects(input.paths);
  const feedText = await Bun.file(input.paths.feed).text().catch(() => "");
  const feedEntries = parseStructuredFeedEntries(feedText).filter((entry) => entry.ts?.startsWith(dateLabel));
  const recentEvents = (await listRecentEvents({
    paths: input.paths,
    scope: "all",
    limit: 500,
  })).filter((event) => event.ts.startsWith(dateLabel));
  const knowledge = await readLinesFromMarkdown(join(input.paths.memoryDir, "knowledge.md"));
  const globalDecisions = (await readLinesFromMarkdown(join(input.paths.memoryDir, "decisions.md"))).map(
    (text) => ({ project: null, ts: null, text, source: "global" as const }),
  );

  const projects: MemorySummaryProject[] = [];
  const recentDecisionItems: RecentDecisionItem[] = [...globalDecisions];

  for (const projectId of projectIds) {
    const projectPaths = getProjectPaths(input.paths, projectId);
    const memory = await readProjectMemorySnapshot(input.paths, projectId);
    const projectConfig = await Bun.file(projectPaths.config).text().catch(() => "");
    const repoPath = extractRepoPath(projectConfig);
    const projectFeedCount = feedEntries.filter((entry) => entry.project === projectId).length;
    const projectEventCount = recentEvents.filter((event) => event.project === projectId).length;
    const signalCount = projectFeedCount + projectEventCount;

    const summary: MemorySummaryProject = {
      id: projectId,
      repoPath,
      facts: memory.facts,
      conventions: memory.conventions,
      recentDecisions: memory.decisions.slice(-5).reverse(),
      openQuestions: memory.questions,
      signalCount,
    };

    projects.push(summary);
    recentDecisionItems.push(
      ...memory.decisions.map((decision) => ({
        project: projectId,
        ts: decision.ts,
        text: decision.text,
        source: "project" as const,
      })),
    );
    await writeProjectEntityArtifacts(input.paths, summary);
  }

  const peopleEntities = await readdir(input.paths.memoryEntitiesPeopleDir, { withFileTypes: true }).catch(() => []);
  const companyEntities = await readdir(input.paths.memoryEntitiesCompaniesDir, { withFileTypes: true }).catch(() => []);
  const highlights = feedEntries.map((entry) =>
    `${entry.project ? `[${entry.project}] ` : ""}${entry.headline}`,
  );
  const internalEvents = recentEvents
    .filter((event) => event.scope === "internal")
    .map((event) => `${event.kind}${event.project ? ` [${event.project}]` : ""} ${event.summary}`);
  const externalEvents = recentEvents
    .filter((event) => event.scope === "external")
    .map((event) => `${event.kind}${event.project ? ` [${event.project}]` : ""} ${event.summary}`);

  recentDecisionItems.sort((left, right) => {
    const leftTs = left.ts ?? "";
    const rightTs = right.ts ?? "";

    return rightTs.localeCompare(leftTs);
  });

  const memorySummary: MemorySummaryState = {
    extractedAt: timestamp,
    date: dateLabel,
    knowledge,
    highlights: highlights.slice(0, 20),
    projects,
  };

  const existingHeat = await readJson<MemoryHeatState>(input.paths.memoryHeatFile);
  const previousProjects = new Map(
    (existingHeat?.projects ?? []).map((project) => [project.id, project]),
  );

  const memoryHeat: MemoryHeatState = {
    extractedAt: timestamp,
    projects: projects.map((project) => {
      const prior = previousProjects.get(project.id);
      const memoryItems =
        project.facts.length +
        project.conventions.length +
        project.recentDecisions.length +
        project.openQuestions.length;
      const status: MemoryHeatProject["status"] =
        project.signalCount >= 4 || project.recentDecisions.length > 0
          ? "hot"
          : project.signalCount > 0 || memoryItems > 0
            ? "warm"
            : "cold";

      return {
        id: project.id,
        status,
        accessCount: prior?.accessCount ?? 0,
        lastAccessed: prior?.lastAccessed ?? null,
        lastExtracted: timestamp,
        signalCount: project.signalCount,
        memoryItems,
      };
    }),
  };

  const journalPath = journalPathForDate(input.paths);
  const journalContent = buildJournalContent({
    dateLabel,
    highlights: memorySummary.highlights,
    internalEvents,
    externalEvents,
    projects,
    recentDecisions: recentDecisionItems,
  });

  await ensureDirectory(dirname(journalPath));
  await Bun.write(journalPath, `${journalContent.trim()}\n`);
  await writeJson(input.paths.memorySummaryFile, memorySummary);
  await writeJson(input.paths.memoryHeatFile, memoryHeat);
  await writeJson(input.paths.memoryRecentDecisionsFile, {
    extractedAt: timestamp,
    items: recentDecisionItems.slice(0, 25),
  });

  if (input.announce ?? true) {
    await appendFeedEntry(input.paths, {
      headline: "Memory extracted",
      details: [
        `projects: ${projects.length}`,
        `highlights: ${memorySummary.highlights.length}`,
        `entities: projects ${projects.length}, people ${peopleEntities.length}, companies ${companyEntities.length}`,
      ],
    });
    await appendEvent({
      paths: input.paths,
      kind: "memory.extracted",
      source: "memory",
      summary: `Daily memory extraction for ${dateLabel}`,
      details: [
        `projects: ${projects.length}`,
        `journal: ${journalPath}`,
      ],
      data: {
        journalPath,
        projectCount: projects.length,
      },
    });
  }

  return {
    journalPath,
    memorySummaryPath: input.paths.memorySummaryFile,
    memoryHeatPath: input.paths.memoryHeatFile,
    recentDecisionsPath: input.paths.memoryRecentDecisionsFile,
  };
}

export async function recordMemoryAccess(
  paths: HivePaths,
  projectId: string,
): Promise<void> {
  const heat = await readJson<MemoryHeatState>(paths.memoryHeatFile);

  if (!heat) {
    return;
  }

  const timestamp = toIsoTimestamp();
  let changed = false;

  const projects = heat.projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }

    changed = true;

    return {
      ...project,
      accessCount: project.accessCount + 1,
      lastAccessed: timestamp,
    };
  });

  if (!changed) {
    return;
  }

  await writeJson(paths.memoryHeatFile, {
    ...heat,
    projects,
  });
}

export async function loadPromptMemoryContext(
  paths: HivePaths,
  projectId: string,
): Promise<PromptMemoryContext> {
  const artifacts = await extractMemory({
    paths,
    announce: false,
  });
  await recordMemoryAccess(paths, projectId);

  const summary = await readJson<MemorySummaryState>(paths.memorySummaryFile);
  const recentDecisions = await readJson<{ extractedAt: string; items: RecentDecisionItem[] }>(
    paths.memoryRecentDecisionsFile,
  );
  const project = summary?.projects.find((item) => item.id === projectId) ?? null;
  const projectEntityPaths = getEntityPaths(paths, "project", projectId);
  const projectEntityDigest = renderProjectEntityDigest(project);
  const knowledgeDigest = renderKnowledgeDigest(summary?.knowledge ?? []);
  const decisionsDigest = renderDecisionDigest(
    (recentDecisions?.items ?? []).filter(
      (item) => item.project === null || item.project === projectId,
    ),
  );

  return {
    memorySummaryPath: artifacts.memorySummaryPath,
    memoryHeatPath: artifacts.memoryHeatPath,
    recentDecisionsPath: artifacts.recentDecisionsPath,
    projectEntitySummaryPath: projectEntityPaths.summary,
    journalPath: artifacts.journalPath,
    globalKnowledgeDigest: knowledgeDigest,
    recentDecisionsDigest: decisionsDigest,
    projectEntityDigest,
  };
}
