import { readFile, rename, writeFile } from "node:fs/promises";

import { type HivePaths } from "./paths";
import { listTickets, readTicket, type TicketWithBody } from "./ticket";

export type NextDisposition = "recommended" | "started";

export type NextSelection = {
  disposition: NextDisposition;
  selectedAt: string;
  sourceWatch: string;
  projectId: string;
  ticketId: string;
  rationale: string;
  runId?: string;
};

export type NextBoard = {
  version: 2;
  selections: NextSelection[];
};

export type NextAvailability =
  | { available: true; ticket: TicketWithBody }
  | { available: false; reason: string; ticket: TicketWithBody | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortSelections(selections: NextSelection[]): NextSelection[] {
  return [...selections].sort((a, b) => a.projectId.localeCompare(b.projectId) || a.ticketId.localeCompare(b.ticketId));
}

export function parseNextSelection(value: unknown): NextSelection | null {
  if (!isRecord(value)) return null;
  if (value.disposition !== "recommended" && value.disposition !== "started") return null;
  if (typeof value.selectedAt !== "string" || !value.selectedAt) return null;
  if (typeof value.sourceWatch !== "string" || !value.sourceWatch) return null;
  if (typeof value.projectId !== "string" || !value.projectId) return null;
  if (typeof value.ticketId !== "string" || !/^TK-\d+$/.test(value.ticketId)) return null;
  if (typeof value.rationale !== "string" || !value.rationale) return null;
  if (value.runId !== undefined && typeof value.runId !== "string") return null;
  if (value.disposition === "started" && !value.runId) return null;

  return {
    disposition: value.disposition,
    selectedAt: value.selectedAt,
    sourceWatch: value.sourceWatch,
    projectId: value.projectId,
    ticketId: value.ticketId,
    rationale: value.rationale,
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

export function parseNextBoard(value: unknown): NextBoard {
  if (!isRecord(value)) return { version: 2, selections: [] };

  if (value.version === 2 && Array.isArray(value.selections)) {
    const byProject = new Map<string, NextSelection>();
    for (const item of value.selections) {
      const parsed = parseNextSelection(item);
      if (parsed) byProject.set(parsed.projectId, parsed);
    }
    return { version: 2, selections: sortSelections([...byProject.values()]) };
  }

  const singleton = parseNextSelection(value);
  return { version: 2, selections: singleton ? [singleton] : [] };
}

export async function readNextBoard(paths: HivePaths): Promise<NextBoard> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.next, "utf-8"));
    return parseNextBoard(parsed);
  } catch {
    return { version: 2, selections: [] };
  }
}

async function writeNextBoard(paths: HivePaths, board: NextBoard): Promise<void> {
  const temporary = `${paths.next}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(board, null, 2)}\n`, "utf-8");
  await rename(temporary, paths.next);
}

/** Upsert one project's slot. Other projects stay. NO_SIGNAL does not call this. */
export async function writeNextSelection(paths: HivePaths, selection: NextSelection): Promise<void> {
  const board = await readNextBoard(paths);
  const selections = board.selections.filter((item) => item.projectId !== selection.projectId);
  selections.push(selection);
  await writeNextBoard(paths, { version: 2, selections: sortSelections(selections) });
}

export async function checkNextAvailability(
  paths: HivePaths,
  selection: NextSelection,
): Promise<NextAvailability> {
  const ticket = await readTicket(paths, selection.projectId, selection.ticketId);
  if (!ticket) return { available: false, reason: "ticket no longer exists", ticket: null };
  if (selection.disposition === "started") {
    return { available: false, reason: `Act already started ${selection.runId}`, ticket };
  }
  if (ticket.status !== "open") return { available: false, reason: `status is ${ticket.status}`, ticket };
  if (ticket.type === "epic") return { available: false, reason: "ticket is an epic", ticket };
  if (ticket.priority === 0) return { available: false, reason: "P0 work requires direct control", ticket };
  if (ticket.tags.includes("needs-greg")) return { available: false, reason: "ticket needs Greg", ticket };
  if (ticket.actRun) return { available: false, reason: `ticket is claimed by ${ticket.actRun}`, ticket };
  if (!ticket.body.trim()) return { available: false, reason: "ticket has no specification", ticket };

  const tickets = await listTickets(paths, selection.projectId);
  const byId = new Map(tickets.map((item) => [item.id, item]));
  const unresolved = ticket.depends.filter((id) => byId.get(id)?.status !== "closed");
  if (unresolved.length > 0) {
    return { available: false, reason: `blocked by ${unresolved.join(", ")}`, ticket };
  }

  return { available: true, ticket };
}
