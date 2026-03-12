import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { UsageError } from "./errors";
import { ensureDirectory, type HivePaths } from "./paths";
import { now, toCompactTimestamp, toDateLabel, toIsoTimestamp } from "./time";

export type EventScope = "internal" | "external";
export type EventSeverity = "info" | "warning" | "error";

export type EventRecord = {
  id: string;
  ts: string;
  scope: EventScope;
  kind: string;
  source: string;
  project: string | null;
  severity: EventSeverity;
  summary: string;
  details: string[];
  data: Record<string, unknown>;
};

function normalizeEventKind(kind: string): string {
  const normalized = kind.trim().toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new UsageError("Event kind must contain letters or numbers.");
  }

  return normalized;
}

function eventsDir(paths: HivePaths, scope: EventScope): string {
  return scope === "internal" ? paths.eventsInternalDir : paths.eventsExternalDir;
}

function dayFilePath(paths: HivePaths, scope: EventScope, dateLabel: string): string {
  return join(eventsDir(paths, scope), `${dateLabel}.jsonl`);
}

function parseEventLine(line: string): EventRecord | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<EventRecord>;

    if (
      typeof parsed.id !== "string" ||
      typeof parsed.ts !== "string" ||
      typeof parsed.scope !== "string" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.source !== "string" ||
      typeof parsed.summary !== "string"
    ) {
      return null;
    }

    return {
      id: parsed.id,
      ts: parsed.ts,
      scope: parsed.scope === "external" ? "external" : "internal",
      kind: parsed.kind,
      source: parsed.source,
      project: typeof parsed.project === "string" ? parsed.project : null,
      severity:
        parsed.severity === "warning" || parsed.severity === "error" ? parsed.severity : "info",
      summary: parsed.summary,
      details: Array.isArray(parsed.details)
        ? parsed.details.map((value) => String(value).trim()).filter(Boolean)
        : [],
      data:
        parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
          ? parsed.data as Record<string, unknown>
          : {},
    };
  } catch {
    return null;
  }
}

async function readDayEvents(
  paths: HivePaths,
  scope: EventScope,
  fileName: string,
): Promise<EventRecord[]> {
  const text = await Bun.file(join(eventsDir(paths, scope), fileName)).text().catch(() => "");

  return text
    .split("\n")
    .map((line) => parseEventLine(line))
    .filter((event): event is EventRecord => Boolean(event));
}

async function nextEventId(
  paths: HivePaths,
  scope: EventScope,
  kind: string,
  dateLabel: string,
  timestamp: string,
): Promise<string> {
  const base = `${toCompactTimestamp(new Date(timestamp))}-${normalizeEventKind(kind)}`;
  const existing = await readDayEvents(paths, scope, `${dateLabel}.jsonl`);
  const existingIds = new Set(existing.map((event) => event.id));

  if (!existingIds.has(base)) {
    return base;
  }

  let counter = 2;
  let candidate = `${base}-${counter}`;

  while (existingIds.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }

  return candidate;
}

export async function appendEvent(input: {
  paths: HivePaths;
  scope?: EventScope;
  kind: string;
  source: string;
  project?: string | null;
  severity?: EventSeverity;
  summary: string;
  details?: string[];
  data?: Record<string, unknown>;
}): Promise<EventRecord> {
  const scope = input.scope ?? "internal";
  const timestamp = toIsoTimestamp();
  const dateLabel = toDateLabel(new Date(timestamp));
  const dir = eventsDir(input.paths, scope);
  const normalizedKind = normalizeEventKind(input.kind);
  const id = await nextEventId(input.paths, scope, normalizedKind, dateLabel, timestamp);
  const event: EventRecord = {
    id,
    ts: timestamp,
    scope,
    kind: normalizedKind,
    source: input.source.trim(),
    project: input.project ?? null,
    severity: input.severity ?? "info",
    summary: input.summary.trim(),
    details: (input.details ?? []).map((line) => line.trim()).filter(Boolean),
    data: input.data ?? {},
  };

  await ensureDirectory(dir);

  const file = Bun.file(dayFilePath(input.paths, scope, dateLabel));
  const existing = await file.text().catch(() => "");
  const prefix = existing.trim() ? `${existing.trim()}\n` : "";
  await Bun.write(file, `${prefix}${JSON.stringify(event)}\n`);

  return event;
}

export async function listRecentEvents(input: {
  paths: HivePaths;
  scope?: EventScope | "all";
  limit?: number;
}): Promise<EventRecord[]> {
  const scope = input.scope ?? "all";
  const limit = input.limit ?? 20;
  const scopes: EventScope[] =
    scope === "all" ? ["internal", "external"] : [scope];
  const events: EventRecord[] = [];

  for (const currentScope of scopes) {
    const entries = await readdir(eventsDir(input.paths, currentScope), {
      withFileTypes: true,
    }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));

    for (const fileName of files) {
      events.push(...await readDayEvents(input.paths, currentScope, fileName));
    }
  }

  return events.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}

export function formatEventList(events: EventRecord[], scope: EventScope | "all" = "all"): string {
  const title =
    scope === "all" ? "Recent events" : `${scope[0].toUpperCase()}${scope.slice(1)} events`;

  if (events.length === 0) {
    return `# HIVE Events\n\n${title}: 0\n\n(none yet)`;
  }

  return [
    "# HIVE Events",
    "",
    `${title}: ${events.length}`,
    "",
    ...events.flatMap((event) => {
      const details = [
        `- ${event.ts} [${event.scope}] ${event.kind}${event.project ? ` [${event.project}]` : ""} ${event.summary}`,
        `  source: ${event.source} | severity: ${event.severity} | id: ${event.id}`,
        ...event.details.map((line) => `  detail: ${line}`),
      ];

      return details;
    }),
  ].join("\n");
}
