/**
 * Pure data collectors for the HIVE dashboard.
 *
 * Every collector returns a plain JSON-friendly object. No rendering,
 * no HTML, no I/O with anything outside `~/.hive/`. The renderer consumes
 * these objects and the tests assert on them directly.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type HivePaths, listProjects, getProjectPaths } from "../paths";
import { parseFrontmatter } from "../frontmatter";
import { listTickets, type Ticket, type TicketPriority } from "../ticket";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthEntry = {
  label: string;           // "HEARTBEAT", "NIGHTLY", "MORNING", "SYNC"
  lastLine: string;        // trimmed tail line
  mtime: string | null;    // ISO timestamp
};

export type ProjectCard = {
  id: string;
  path: string | null;                   // from config.md "path:" field
  lastHeartbeat: string | null;          // ISO
  tickCount: number;
  lastResult: string | null;
  ticketCounts: {
    open: number;
    inProgress: number;
    closed: number;
    byPriority: Record<TicketPriority, number>;
  };
  inboxMtime: string | null;
};

export type InboxEntry = {
  projectId: string;
  mtime: string | null;
  body: string;              // raw markdown (may be empty)
  isEmpty: boolean;
};

export type TicketCitation = {
  id: string;
  title: string;
  projectId: string;
  priority: TicketPriority;
  tags: string[];
  depends: string[];
  ageDays: number;
};

export type TicketBuckets = {
  ready: TicketCitation[];
  inProgress: TicketCitation[];
  blocked: TicketCitation[];
};

export type RunEntry = {
  id: string;               // "RUN-009"
  status: string;           // "complete" | "partial" | "failed" | "crashed" | "running" | "timed_out"
  durationMs: number | null;
  startedAt: string | null;
  goalSnippet: string;      // first ~240 chars of goal.md body
  projectId: string | null; // parsed from goal.md if possible
  ticketId: string | null;  // first TK-\d+ in goal.md
};

export type BriefingEntry = {
  date: string;             // YYYY-MM-DD
  body: string;             // raw markdown
  headline: string;         // first H1/H2 or first meaningful line
};

export type DashboardData = {
  generatedAt: string;
  volumeNumber: number;     // count of briefings (proxy for "days since install")
  today: string;            // YYYY-MM-DD (from latest briefing or system)
  health: HealthEntry[];
  projects: ProjectCard[];
  inboxes: InboxEntry[];
  tickets: TicketBuckets;
  runs: RunEntry[];
  briefings: BriefingEntry[];
  todayBriefing: BriefingEntry | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function safeStat(path: string): Promise<{ mtime: Date } | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function tailLine(path: string, mustContain?: string): Promise<string | null> {
  const content = await safeReadFile(path);
  if (!content) return null;
  const lines = content.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (mustContain) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.includes(mustContain)) return lines[i]!;
    }
  }
  return lines[lines.length - 1] ?? null;
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function parseProjectPath(configMd: string): string | null {
  const { attributes } = parseFrontmatter(configMd);
  return attributes.path ?? null;
}

function extractTicketId(text: string): string | null {
  const match = text.match(/TK-\d{1,4}/);
  return match ? match[0] : null;
}

function extractProjectId(goalBody: string, knownProjects: string[]): string | null {
  // "Project: hive" or "Project:hive"
  const explicit = goalBody.match(/^Project:\s*([a-z0-9_-]+)/im);
  if (explicit?.[1]) return explicit[1];

  // Fallback: match any known project id as a whole-word hit in the goal body
  for (const id of knownProjects) {
    const re = new RegExp(`\\b${id}\\b`, "i");
    if (re.test(goalBody)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

export async function collectHealth(paths: HivePaths): Promise<HealthEntry[]> {
  const logsDir = join(paths.home, "logs");
  const jobs = [
    { label: "HEARTBEAT", file: "heartbeat.log", marker: "heartbeat complete" },
    { label: "MORNING", file: "morning.log", marker: "morning complete" },
    { label: "NIGHTLY", file: "nightly.log", marker: "nightly complete" },
    { label: "SYNC", file: "hive-sync.log", marker: null as string | null },
  ];

  const out: HealthEntry[] = [];
  for (const job of jobs) {
    const path = join(logsDir, job.file);
    const st = await safeStat(path);
    const line = await tailLine(path, job.marker ?? undefined);
    out.push({
      label: job.label,
      lastLine: line ?? "(no log entries)",
      mtime: st ? st.mtime.toISOString() : null,
    });
  }
  return out;
}

export async function collectProjects(paths: HivePaths): Promise<ProjectCard[]> {
  const ids = await listProjects(paths.projectsDir);
  const cards: ProjectCard[] = [];

  for (const id of ids) {
    const pp = getProjectPaths(paths, id);

    // Path
    const configMd = await safeReadFile(pp.config);
    const path = configMd ? parseProjectPath(configMd) : null;

    // Heartbeat
    let lastHeartbeat: string | null = null;
    let tickCount = 0;
    let lastResult: string | null = null;
    const hbRaw = await safeReadFile(pp.heartbeatConfig);
    if (hbRaw) {
      try {
        const hb = JSON.parse(hbRaw);
        lastHeartbeat = hb.lastTick ?? null;
        tickCount = typeof hb.tickCount === "number" ? hb.tickCount : 0;
        lastResult = hb.lastResult ?? null;
      } catch {
        // tolerate malformed heartbeat.json
      }
    }

    // Tickets
    const tickets = await listTickets(paths, id).catch(() => [] as Ticket[]);
    const counts = {
      open: tickets.filter((t) => t.status === "open").length,
      inProgress: tickets.filter((t) => t.status === "in_progress").length,
      closed: tickets.filter((t) => t.status === "closed").length,
      byPriority: { 0: 0, 1: 0, 2: 0, 3: 0 } as Record<TicketPriority, number>,
    };
    for (const t of tickets) {
      if (t.status === "closed") continue;
      counts.byPriority[t.priority] = (counts.byPriority[t.priority] ?? 0) + 1;
    }

    // Inbox mtime
    const inboxStat = await safeStat(pp.inbox);

    cards.push({
      id,
      path,
      lastHeartbeat,
      tickCount,
      lastResult,
      ticketCounts: counts,
      inboxMtime: inboxStat ? inboxStat.mtime.toISOString() : null,
    });
  }

  return cards;
}

export async function collectInboxes(paths: HivePaths): Promise<InboxEntry[]> {
  const ids = await listProjects(paths.projectsDir);
  const out: InboxEntry[] = [];

  for (const id of ids) {
    const pp = getProjectPaths(paths, id);
    const body = (await safeReadFile(pp.inbox)) ?? "";
    const st = await safeStat(pp.inbox);
    // Drop a leading "# Inbox: <id>" header so the rendered section shows content only.
    const cleaned = body.replace(new RegExp(`^#\\s+Inbox:\\s+${id}\\s*\\n?`, "i"), "").trim();
    const isEmpty = cleaned.length === 0;
    out.push({
      projectId: id,
      mtime: st ? st.mtime.toISOString() : null,
      body: cleaned,
      isEmpty,
    });
  }

  return out;
}

export async function collectTickets(paths: HivePaths): Promise<TicketBuckets> {
  const ids = await listProjects(paths.projectsDir);
  const now = new Date();

  const all: { projectId: string; ticket: Ticket }[] = [];
  for (const id of ids) {
    const tickets = await listTickets(paths, id).catch(() => [] as Ticket[]);
    for (const ticket of tickets) {
      all.push({ projectId: id, ticket });
    }
  }

  // Build a set of open ids per project to compute blocked/ready
  const openByProject = new Map<string, Set<string>>();
  for (const { projectId, ticket } of all) {
    if (!openByProject.has(projectId)) openByProject.set(projectId, new Set());
    if (ticket.status !== "closed") openByProject.get(projectId)!.add(ticket.id);
  }

  const ready: TicketCitation[] = [];
  const inProgress: TicketCitation[] = [];
  const blocked: TicketCitation[] = [];

  for (const { projectId, ticket } of all) {
    if (ticket.status === "closed") continue;
    const openSet = openByProject.get(projectId)!;
    const isBlocked = ticket.depends.length > 0 && ticket.depends.some((d) => openSet.has(d));

    const citation: TicketCitation = {
      id: ticket.id,
      title: ticket.title,
      projectId,
      priority: ticket.priority,
      tags: ticket.tags,
      depends: ticket.depends,
      ageDays: daysBetween(new Date(ticket.created), now),
    };

    if (ticket.status === "in_progress") {
      inProgress.push(citation);
    } else if (isBlocked) {
      blocked.push(citation);
    } else {
      ready.push(citation);
    }
  }

  const sortByPriorityThenAge = (a: TicketCitation, b: TicketCitation): number =>
    a.priority - b.priority || b.ageDays - a.ageDays;

  ready.sort(sortByPriorityThenAge);
  inProgress.sort(sortByPriorityThenAge);
  blocked.sort(sortByPriorityThenAge);

  return { ready, inProgress, blocked };
}

export async function collectRuns(paths: HivePaths, limit = 20): Promise<RunEntry[]> {
  const entries = await readdir(paths.runsDir).catch(() => [] as string[]);
  const runIds = entries
    .filter((e) => /^RUN-\d+$/.test(e))
    .sort()
    .reverse()
    .slice(0, limit);

  const knownProjects = await listProjects(paths.projectsDir);
  const out: RunEntry[] = [];

  for (const id of runIds) {
    const runDir = join(paths.runsDir, id);
    const goal = (await safeReadFile(join(runDir, "goal.md"))) ?? "";
    const status = ((await safeReadFile(join(runDir, "status"))) ?? "running").trim();

    const goalStat = await safeStat(join(runDir, "goal.md"));
    const statusStat = await safeStat(join(runDir, "status"));

    const startedAt = goalStat ? goalStat.mtime.toISOString() : null;
    const durationMs = goalStat && statusStat
      ? Math.max(0, statusStat.mtime.getTime() - goalStat.mtime.getTime())
      : null;

    // Snippet: strip leading heading, take first substantial paragraph.
    const body = goal.replace(/^#\s*Goal\s*\n+/i, "").trim();
    const firstPara = body.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
    const goalSnippet = firstPara.length > 280
      ? firstPara.slice(0, 280).replace(/\s+\S*$/, "") + "…"
      : firstPara;

    out.push({
      id,
      status,
      durationMs,
      startedAt,
      goalSnippet,
      projectId: extractProjectId(body, knownProjects),
      ticketId: extractTicketId(body),
    });
  }

  return out;
}

export async function collectBriefings(paths: HivePaths): Promise<BriefingEntry[]> {
  const dir = join(paths.home, "briefings");
  if (!existsSync(dir)) return [];

  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();

  const out: BriefingEntry[] = [];
  for (const file of files) {
    const body = (await safeReadFile(join(dir, file))) ?? "";
    const date = file.replace(/\.md$/, "");

    // Headline: first non-empty, non-"---" line that isn't a horizontal rule.
    let headline = "";
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^#{1,6}\s*/.test(trimmed)) {
        headline = trimmed.replace(/^#{1,6}\s*/, "").replace(/\s+[—–-]\s+\d{4}-\d{2}-\d{2}$/, "");
        break;
      }
    }
    if (!headline) headline = `Briefing — ${date}`;

    out.push({ date, body, headline });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export async function collectDashboardData(paths: HivePaths): Promise<DashboardData> {
  const [health, projects, inboxes, tickets, runs, briefings] = await Promise.all([
    collectHealth(paths),
    collectProjects(paths),
    collectInboxes(paths),
    collectTickets(paths),
    collectRuns(paths),
    collectBriefings(paths),
  ]);

  const today = briefings[0]?.date ?? new Date().toISOString().slice(0, 10);
  const todayBriefing = briefings.find((b) => b.date === today) ?? briefings[0] ?? null;

  return {
    generatedAt: new Date().toISOString(),
    volumeNumber: briefings.length,
    today,
    health,
    projects,
    inboxes,
    tickets,
    runs,
    briefings,
    todayBriefing,
  };
}
