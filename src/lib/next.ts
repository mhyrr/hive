import { readFile, rename, writeFile } from "node:fs/promises";

import { type HivePaths } from "./paths";
import { listTickets, readTicket, type TicketWithBody } from "./ticket";

export type NextDisposition = "recommended" | "started";

export type NextSelection = {
  version: 1;
  disposition: NextDisposition;
  selectedAt: string;
  sourceWatch: string;
  projectId: string;
  ticketId: string;
  rationale: string;
  runId?: string;
};

export type NextAvailability =
  | { available: true; ticket: TicketWithBody }
  | { available: false; reason: string; ticket: TicketWithBody | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNextSelection(value: unknown): NextSelection | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (value.disposition !== "recommended" && value.disposition !== "started") return null;
  if (typeof value.selectedAt !== "string" || !value.selectedAt) return null;
  if (typeof value.sourceWatch !== "string" || !value.sourceWatch) return null;
  if (typeof value.projectId !== "string" || !value.projectId) return null;
  if (typeof value.ticketId !== "string" || !/^TK-\d+$/.test(value.ticketId)) return null;
  if (typeof value.rationale !== "string" || !value.rationale) return null;
  if (value.runId !== undefined && typeof value.runId !== "string") return null;
  if (value.disposition === "started" && !value.runId) return null;

  return {
    version: 1,
    disposition: value.disposition,
    selectedAt: value.selectedAt,
    sourceWatch: value.sourceWatch,
    projectId: value.projectId,
    ticketId: value.ticketId,
    rationale: value.rationale,
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

export async function readNextSelection(paths: HivePaths): Promise<NextSelection | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.next, "utf-8"));
    return parseNextSelection(parsed);
  } catch {
    return null;
  }
}

/** Replace the current selection atomically. Watch execution already holds the
 * global watch lock, but the rename also keeps readers from seeing partial JSON. */
export async function writeNextSelection(paths: HivePaths, selection: NextSelection): Promise<void> {
  const temporary = `${paths.next}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, "utf-8");
  await rename(temporary, paths.next);
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
