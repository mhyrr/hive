import { now } from "./time";

export type BoardAgent = {
  id: string;
  descriptor: string;
  fields: Record<string, string>;
};

export type ParsedBoard = {
  tasks: string[];
  agents: BoardAgent[];
  blockers: string[];
  decisions: string[];
  raw: string;
};

function splitSections(board: string): Map<string, string[]> {
  const normalized = board.replace(/\r\n/g, "\n");
  const sections = new Map<string, string[]>();
  let currentHeading: string | null = null;

  for (const line of normalized.split("\n")) {
    if (line.startsWith("## ")) {
      currentHeading = line.slice(3).trim();
      sections.set(currentHeading, []);
      continue;
    }

    if (!currentHeading) {
      continue;
    }

    sections.get(currentHeading)?.push(line);
  }

  return sections;
}

function parseSectionLines(board: string, heading: string): string[] {
  const section = splitSections(board).get(heading);

  if (!section) {
    return [];
  }

  return section
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function parseAgentSections(board: string): BoardAgent[] {
  const agentLines = splitSections(board).get("Agents");

  if (!agentLines) {
    return [];
  }

  const lines = agentLines;
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (current) {
        sections.push(current);
      }

      current = { heading: line.trim(), body: [] };
      continue;
    }

    if (current) {
      current.body.push(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections.flatMap((section) => {
    const headingMatch = section.heading.match(/^###\s+([^\s(]+)\s+\(([^)]+)\)$/);

    if (!headingMatch) {
      return [];
    }

    const id = headingMatch[1].trim();
    const descriptor = headingMatch[2].trim();
    const body = section.body.join("\n").trim();
    const fields: Record<string, string> = {};

    for (const line of body.split("\n")) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      const separatorIndex = trimmed.indexOf(":");

      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (key) {
        fields[key] = value;
      }
    }

    return [{ id, descriptor, fields }];
  });
}

function parseTimeOfDay(value: string): Date | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const current = now();
  const date = new Date(current);

  date.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);

  if (date.getTime() > current.getTime()) {
    date.setUTCDate(date.getUTCDate() - 1);
  }

  return date;
}

export function parseBoard(board: string): ParsedBoard {
  return {
    tasks: parseSectionLines(board, "Tasks"),
    agents: parseAgentSections(board),
    blockers: parseSectionLines(board, "Blockers"),
    decisions: parseSectionLines(board, "Decisions"),
    raw: board.trim(),
  };
}

export function parseLooseTimestamp(value: string): Date | null {
  const isoDate = new Date(value);

  if (!Number.isNaN(isoDate.getTime())) {
    return isoDate;
  }

  return parseTimeOfDay(value);
}

export function minutesSince(value: string): number | null {
  const timestamp = parseLooseTimestamp(value);

  if (!timestamp) {
    return null;
  }

  const diffMs = now().getTime() - timestamp.getTime();

  return Math.floor(diffMs / 60000);
}
