import { join } from "node:path";
import { readdir, mkdir } from "node:fs/promises";

import { type HivePaths } from "./paths";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { toIsoTimestamp } from "./time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TicketStatus = "open" | "in_progress" | "closed";
export type TicketType = "bug" | "feature" | "task" | "epic" | "chore";
export type TicketPriority = 0 | 1 | 2 | 3; // 0 = critical, 3 = low

export type Ticket = {
  id: string;
  title: string;
  status: TicketStatus;
  type: TicketType;
  priority: TicketPriority;
  tags: string[];
  created: string;
  updated: string;
  closed: string | null; // timestamp when closed
  ref: string | null; // external reference (github issue, etc.)
  depends: string[]; // ticket IDs this depends on
  parentEpic: string | null; // ticket ID of the epic this is a child of
};

export type TicketWithBody = Ticket & { body: string };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function ticketsDir(paths: HivePaths, projectId: string): string {
  return join(paths.projectsDir, projectId, "tickets");
}

function ticketFilePath(dir: string, id: string): string {
  return join(dir, `${id}.md`);
}

// ---------------------------------------------------------------------------
// ID generation — sequential TK-001 style
// ---------------------------------------------------------------------------

async function nextTicketId(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });

  const entries = await readdir(dir).catch(() => []);
  const nums = entries
    .filter((f) => f.startsWith("TK-") && f.endsWith(".md"))
    .map((f) => parseInt(f.slice(3, -3), 10))
    .filter((n) => !Number.isNaN(n));

  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `TK-${String(next).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Priority parsing — handles numeric (0-3), string names, and legacy NaN
// ---------------------------------------------------------------------------

const priorityNames: Record<string, TicketPriority> = {
  critical: 0, high: 1, medium: 2, low: 3,
  "p0": 0, "p1": 1, "p2": 2, "p3": 3,
};

function parsePriority(raw: unknown): TicketPriority {
  if (raw == null || raw === "NaN") return 2;
  const n = Number(raw);
  if (!Number.isNaN(n) && n >= 0 && n <= 3) return n as TicketPriority;
  const key = String(raw).toLowerCase().trim();
  return priorityNames[key] ?? 2;
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

function parseTicketFile(raw: string, id: string): TicketWithBody {
  const { attributes, body } = parseFrontmatter(raw);

  return {
    id,
    title: attributes.title ?? "Untitled",
    status: (attributes.status as TicketStatus) ?? "open",
    type: (attributes.type as TicketType) ?? "task",
    priority: parsePriority(attributes.priority),
    tags: attributes.tags ? attributes.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    created: attributes.created ?? toIsoTimestamp(),
    updated: attributes.updated ?? toIsoTimestamp(),
    closed: attributes.closed || null,
    ref: attributes.ref || null,
    depends: attributes.depends ? attributes.depends.split(",").map((d) => d.trim()).filter(Boolean) : [],
    parentEpic: attributes.parent_epic || null,
    body,
  };
}

function serializeTicket(ticket: TicketWithBody): string {
  const attrs: Record<string, string> = {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    type: ticket.type,
    priority: String(ticket.priority),
    tags: ticket.tags.join(", "),
    created: ticket.created,
    updated: ticket.updated,
  };
  if (ticket.closed) attrs.closed = ticket.closed;
  if (ticket.ref) attrs.ref = ticket.ref;
  if (ticket.depends.length > 0) attrs.depends = ticket.depends.join(", ");
  if (ticket.parentEpic) attrs.parent_epic = ticket.parentEpic;

  return stringifyFrontmatter(attrs, ticket.body);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export type CreateTicketInput = {
  title: string;
  body?: string;
  type?: TicketType;
  priority?: TicketPriority;
  tags?: string[];
  ref?: string;
  depends?: string[];
  parentEpic?: string;
};

export async function createTicket(
  paths: HivePaths,
  projectId: string,
  input: CreateTicketInput,
): Promise<TicketWithBody> {
  const dir = ticketsDir(paths, projectId);
  const id = await nextTicketId(dir);
  const now = toIsoTimestamp();

  // Validate dependencies exist
  if (input.depends && input.depends.length > 0) {
    const entries = await readdir(dir).catch(() => []);
    const existingIds = new Set(
      entries.filter((f) => f.startsWith("TK-") && f.endsWith(".md")).map((f) => f.replace(".md", "")),
    );
    const missing = input.depends.filter((d) => !existingIds.has(d.toUpperCase().trim()));
    if (missing.length > 0) {
      throw new Error(`Unknown dependencies: ${missing.join(", ")}`);
    }
  }

  const ticket: TicketWithBody = {
    id,
    title: input.title.trim(),
    status: "open",
    type: input.type ?? "task",
    priority: input.priority ?? 2,
    tags: input.tags ?? [],
    created: now,
    updated: now,
    closed: null,
    ref: input.ref ?? null,
    depends: input.depends ?? [],
    parentEpic: input.parentEpic ?? null,
    body: input.body?.trim() || "",
  };

  await Bun.write(ticketFilePath(dir, id), serializeTicket(ticket));
  return ticket;
}

export async function readTicket(
  paths: HivePaths,
  projectId: string,
  id: string,
): Promise<TicketWithBody | null> {
  const resolvedId = await resolveTicketId(paths, projectId, id);
  if (!resolvedId) return null;

  const file = Bun.file(ticketFilePath(ticketsDir(paths, projectId), resolvedId));
  if (!(await file.exists())) return null;

  return parseTicketFile(await file.text(), resolvedId);
}

export async function updateTicket(
  paths: HivePaths,
  projectId: string,
  id: string,
  updates: Partial<Pick<Ticket, "status" | "title" | "type" | "priority" | "tags" | "ref" | "depends" | "parentEpic">>,
): Promise<TicketWithBody | null> {
  const ticket = await readTicket(paths, projectId, id);
  if (!ticket) return null;

  if (updates.status !== undefined) {
    ticket.status = updates.status;
    if (updates.status === "closed") ticket.closed = toIsoTimestamp();
    if (updates.status === "open") ticket.closed = null;
  }
  if (updates.title !== undefined) ticket.title = updates.title;
  if (updates.type !== undefined) ticket.type = updates.type;
  if (updates.priority !== undefined) ticket.priority = updates.priority;
  if (updates.tags !== undefined) ticket.tags = updates.tags;
  if (updates.ref !== undefined) ticket.ref = updates.ref;
  if (updates.depends !== undefined) ticket.depends = updates.depends;
  if (updates.parentEpic !== undefined) ticket.parentEpic = updates.parentEpic;
  ticket.updated = toIsoTimestamp();

  await Bun.write(ticketFilePath(ticketsDir(paths, projectId), ticket.id), serializeTicket(ticket));

  // Cascade: if this ticket just closed and has a parent epic, the epic
  // may now be done. maybeAutoCloseEpic recurses for epic-of-epic chains.
  if (updates.status === "closed" && ticket.parentEpic) {
    await maybeAutoCloseEpic(paths, projectId, ticket.parentEpic);
  }

  return ticket;
}

/**
 * Auto-close an epic when ALL of its children are closed.
 *
 * Skips empty placeholders (zero children — those represent "decomposition
 * pending"). Skips non-epic tickets and already-closed epics. Recursion is
 * bounded by the parent chain and idempotent on already-closed epics.
 */
async function maybeAutoCloseEpic(
  paths: HivePaths,
  projectId: string,
  epicId: string,
): Promise<void> {
  const epic = await readTicket(paths, projectId, epicId);
  if (!epic) return;
  if (epic.status === "closed") return;
  if (epic.type !== "epic") return;

  const children = (await listTickets(paths, projectId)).filter(
    (t) => t.parentEpic === epicId,
  );
  if (children.length === 0) return;
  if (children.some((c) => c.status !== "closed")) return;

  await updateTicket(paths, projectId, epicId, { status: "closed" });
}

export async function addTicketNote(
  paths: HivePaths,
  projectId: string,
  id: string,
  note: string,
  actor?: string,
): Promise<TicketWithBody | null> {
  const ticket = await readTicket(paths, projectId, id);
  if (!ticket) return null;

  const timestamp = toIsoTimestamp();
  const heading = actor ? `### ${timestamp} [${actor}]` : `### ${timestamp}`;
  const entry = `\n${heading}\n${note.trim()}`;
  ticket.body = ticket.body ? `${ticket.body}\n${entry}` : entry.trim();
  ticket.updated = timestamp;

  await Bun.write(ticketFilePath(ticketsDir(paths, projectId), ticket.id), serializeTicket(ticket));
  return ticket;
}

// ---------------------------------------------------------------------------
// List / filter
// ---------------------------------------------------------------------------

export type ListTicketsFilter = {
  status?: TicketStatus;
  type?: TicketType;
  tags?: string[];
  priority?: TicketPriority;
};

export async function listTickets(
  paths: HivePaths,
  projectId: string,
  filter?: ListTicketsFilter,
): Promise<Ticket[]> {
  const dir = ticketsDir(paths, projectId);
  const entries = await readdir(dir).catch(() => []);
  const ticketFiles = entries.filter((f) => f.startsWith("TK-") && f.endsWith(".md")).sort();

  const tickets: Ticket[] = [];
  for (const file of ticketFiles) {
    const id = file.replace(".md", "");
    const raw = await Bun.file(join(dir, file)).text();
    const ticket = parseTicketFile(raw, id);
    tickets.push(ticket);
  }

  return applyFilter(tickets, filter);
}

function applyFilter(tickets: Ticket[], filter?: ListTicketsFilter): Ticket[] {
  if (!filter) return tickets;

  return tickets.filter((t) => {
    if (filter.status && t.status !== filter.status) return false;
    if (filter.type && t.type !== filter.type) return false;
    if (filter.priority !== undefined && t.priority !== filter.priority) return false;
    if (filter.tags && filter.tags.length > 0) {
      if (!filter.tags.some((tag) => t.tags.includes(tag))) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Dependency helpers
// ---------------------------------------------------------------------------

export async function getBlockedTickets(
  paths: HivePaths,
  projectId: string,
): Promise<Ticket[]> {
  const all = await listTickets(paths, projectId, { status: "open" });
  const openIds = new Set(all.filter((t) => t.status !== "closed").map((t) => t.id));

  return all.filter(
    (t) => t.depends.length > 0 && t.depends.some((d) => openIds.has(d)),
  );
}

export async function getReadyTickets(
  paths: HivePaths,
  projectId: string,
): Promise<Ticket[]> {
  const all = await listTickets(paths, projectId, { status: "open" });
  const openIds = new Set(all.filter((t) => t.status !== "closed").map((t) => t.id));

  return all.filter(
    (t) => t.depends.length === 0 || !t.depends.some((d) => openIds.has(d)),
  );
}

// ---------------------------------------------------------------------------
// ID resolution — supports partial matching (TK-1 → TK-001)
// ---------------------------------------------------------------------------

async function resolveTicketId(
  paths: HivePaths,
  projectId: string,
  input: string,
): Promise<string | null> {
  const normalized = input.toUpperCase().trim();
  const dir = ticketsDir(paths, projectId);
  const entries = await readdir(dir).catch(() => []);
  const ids = entries.filter((f) => f.startsWith("TK-") && f.endsWith(".md")).map((f) => f.replace(".md", ""));

  // Exact match
  if (ids.includes(normalized)) return normalized;

  // Partial: "1" or "TK-1" → "TK-001"
  const numStr = normalized.replace(/^TK-?/, "");
  const num = parseInt(numStr, 10);
  if (!Number.isNaN(num)) {
    const padded = `TK-${String(num).padStart(3, "0")}`;
    if (ids.includes(padded)) return padded;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const priorityLabels: Record<TicketPriority, string> = {
  0: "P0-critical",
  1: "P1-high",
  2: "P2-medium",
  3: "P3-low",
};

const statusRank: Record<TicketStatus, number> = {
  in_progress: 0,
  open: 1,
  closed: 2,
};

function ticketNumber(id: string): number {
  const n = parseInt(id.replace(/^\D+/, ""), 10);
  return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}

/**
 * Reading order for a ticket list: what's being worked on, then what's most
 * urgent, then oldest first. Does not mutate the input.
 */
export function sortTicketsForDisplay(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => {
    const s = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
    if (s !== 0) return s;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return ticketNumber(a.id) - ticketNumber(b.id);
  });
}

function ticketColumns(t: Ticket): { prefix: string; description: string } {
  const tags = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
  const deps = t.depends.length > 0 ? ` (blocked by: ${t.depends.join(", ")})` : "";
  const pLabel = priorityLabels[t.priority] ?? `P?-unknown`;
  return {
    prefix: `${t.id}  ${t.status.padEnd(11)}  ${pLabel.padEnd(12)}  ${t.type.padEnd(7)}  `,
    description: `${t.title}${tags}${deps}`,
  };
}

/** Greedy word wrap. Words longer than the column are broken rather than allowed to bleed. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }

  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

export function formatTicketSummary(t: Ticket): string {
  const { prefix, description } = ticketColumns(t);
  return prefix + description;
}

/** Minimum description column worth wrapping into — below this, leave the line alone. */
const MIN_DESCRIPTION_WIDTH = 24;

/**
 * One ticket, wrapped so the description stays inside its own column with a
 * hanging indent. `width` of 0 (non-TTY, unknown terminal) returns the plain
 * single-line form, which keeps piped output one ticket per line.
 */
export function formatTicketRow(t: Ticket, width: number): string {
  const { prefix, description } = ticketColumns(t);
  const available = width - prefix.length;
  if (available < MIN_DESCRIPTION_WIDTH) return prefix + description;

  const indent = " ".repeat(prefix.length);
  return wrapWords(description, available)
    .map((line, i) => (i === 0 ? prefix : indent) + line)
    .join("\n");
}

export function formatTicketDetail(t: TicketWithBody): string {
  const lines = [
    `# ${t.id}: ${t.title}`,
    "",
    `**Status:** ${t.status}`,
    `**Type:** ${t.type}`,
    `**Priority:** ${priorityLabels[t.priority] ?? "unknown"}`,
    `**Tags:** ${t.tags.length > 0 ? t.tags.join(", ") : "none"}`,
    `**Created:** ${t.created}`,
    `**Updated:** ${t.updated}`,
  ];

  if (t.closed) lines.push(`**Closed:** ${t.closed}`);
  if (t.ref) lines.push(`**Ref:** ${t.ref}`);
  if (t.depends.length > 0) lines.push(`**Depends on:** ${t.depends.join(", ")}`);
  if (t.parentEpic) lines.push(`**Epic:** ${t.parentEpic}`);

  if (t.body) {
    lines.push("", "---", "", t.body);
  }

  return lines.join("\n");
}
