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
import { listTickets, readTicket, type Ticket, type TicketPriority } from "../ticket";
import {
  readProjectMemorySnapshot,
  readMeta,
  entryHash,
  entryStrength,
  daysBetween as daysBetweenStrings,
  type MemorySection,
} from "../memory";
import { loadUsageSummary, formatUsd } from "../pricing";
import {
  collectRuns as collectRunsPage,
  runsByTicket as buildRunsByTicket,
  type RunRef as RunsRunRef,
} from "./runs/collect";
import {
  readTasteUnits,
  generalTasteDir,
  projectTasteDir,
  type TasteUnit,
  type TasteUnitStatus,
} from "../taste-store";
import { TASTE_CATEGORIES, type TasteCategory } from "../taste-types";

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

export type RunRef = {
  id: string;
  status: string;
};

export type TicketCitation = {
  id: string;
  title: string;
  projectId: string;
  priority: TicketPriority;
  tags: string[];
  depends: string[];
  ageDays: number;
  // Optional. Populated by collectTicketsPage so cards can expand inline.
  // Empty / unset for collectors that only need summary citations.
  body?: string;
  // Optional. Populated by collectTicketsPage from cross-referencing runs.
  runs?: RunRef[];
};

export type TicketBuckets = {
  ready: TicketCitation[];
  inProgress: TicketCitation[];
  blocked: TicketCitation[];
};

export type EpicCitation = TicketCitation & {
  status: "open" | "in_progress" | "closed";
};

export type EpicBoard = {
  epic: EpicCitation;
  buckets: TicketBuckets;
  childCount: number;          // open + in_progress only
  lastActivity: string;        // ISO ts of most recent child update (or epic.updated if no children)
};

export type TicketsPageData = {
  generatedAt: string;
  epics: EpicBoard[];
  standalone: TicketBuckets;
  totalActive: number;
  projectCount: number;
  /** Sorted list of project ids that have at least one ticket. Drives the filter pills. */
  projectIds: string[];
};

// Internal helper for tickets-page collector: read tickets WITH bodies.
async function listTicketsWithBodies(
  paths: HivePaths,
  projectId: string,
): Promise<Array<Ticket & { body: string }>> {
  // listTickets currently returns Ticket[] without bodies; we need readTicket
  // for each. The N reads are bounded by ticket count — fine on localhost.
  const summaries = await listTickets(paths, projectId);
  const out: Array<Ticket & { body: string }> = [];
  for (const t of summaries) {
    const full = await readTicket(paths, projectId, t.id);
    if (full) out.push({ ...t, body: full.body });
  }
  return out;
}

export type RunEntry = {
  id: string;               // "RUN-009"
  status: string;           // includes "review_ready" for unmerged Act work
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

export type PromotionCandidate = {
  projectId: string;
  text: string;              // entry text
  section: "convention" | "fact";
  strength: number;          // current entryStrength score
  recallCount: number;
  ageDays: number;           // days since createdAt
  createdAt: string;         // YYYY-MM-DD
};

export type OpenQuestion = {
  projectId: string;
  text: string;
  tags: string[];
};

export type RecentMemoryEntry = {
  projectId: string;
  section: MemorySection;
  text: string;
  tags: string[];
  createdAt: string;
  lastRecalled: string | null;
  strength: number;
};

export type ReflectionDay = {
  date: string;             // YYYY-MM-DD parsed from filename
  body: string;             // markdown body, frontmatter stripped
  ageDays: number;          // days between `date` and today
};

export type RunUsagePassEntry = {
  pass: "B" | "C" | "V";
  project: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  usdFormatted: string;
  durationMs: number | null;
};

export type RunUsageSnapshot = {
  date: string;
  available: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalUsd: number;
  totalUsdFormatted: string;
  passes: RunUsagePassEntry[];
};

export type ProposeEntry = {
  date: string;
  /** propose.md body with the artifact's own H1 stripped. */
  body: string;
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
  promotionCandidates: PromotionCandidate[];
  // V1 cross-cutting widgets — Group 7.
  openQuestions: OpenQuestion[];
  recentMemory: RecentMemoryEntry[];
  runUsage: RunUsageSnapshot;
  tasteTrack: TasteTrackSnapshot;
  latestReflection: ReflectionDay | null;
  /** Latest nightly Propose output within the last 7 run dirs (TK-138). */
  propose: ProposeEntry | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null; // intentional: file missing or unreadable
  }
}

async function safeStat(path: string): Promise<{ mtime: Date } | null> {
  try {
    return await stat(path);
  } catch {
    return null; // intentional: path doesn't exist
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
        // intentional: tolerate malformed heartbeat.json
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

// ---------------------------------------------------------------------------
// Tickets page (deep view) — per-epic kanbans + standalone block.
// docs/specs/2026-05-09-tickets-page-design.md
// ---------------------------------------------------------------------------

export async function collectTicketsPage(paths: HivePaths): Promise<TicketsPageData> {
  const projectIds = await listProjects(paths.projectsDir);
  const now = new Date();

  type Indexed = { projectId: string; ticket: Ticket & { body: string } };
  const all: Indexed[] = [];
  const projectsWithTickets = new Set<string>();

  // Collect tickets and runs in parallel.
  const [, runsData] = await Promise.all([
    (async () => {
      for (const id of projectIds) {
        const tickets = await listTicketsWithBodies(paths, id).catch(() => []);
        if (tickets.length > 0) projectsWithTickets.add(id);
        for (const ticket of tickets) all.push({ projectId: id, ticket });
      }
    })(),
    collectRunsPage(paths, { checkPid: true }),
  ]);

  // Build runs-by-ticket index for cross-linking.
  const runsMap = buildRunsByTicket(runsData);

  // Open-by-project so the blocked check matches collectTickets' semantics.
  const openByProject = new Map<string, Set<string>>();
  for (const { projectId, ticket } of all) {
    if (!openByProject.has(projectId)) openByProject.set(projectId, new Set());
    if (ticket.status !== "closed") openByProject.get(projectId)!.add(ticket.id);
  }

  const toCitation = (it: Indexed): TicketCitation => {
    const refs = runsMap.get(`${it.projectId}/${it.ticket.id}`) ?? runsMap.get(it.ticket.id);
    return {
      id: it.ticket.id,
      title: it.ticket.title,
      projectId: it.projectId,
      priority: it.ticket.priority,
      tags: it.ticket.tags,
      depends: it.ticket.depends,
      ageDays: daysBetween(new Date(it.ticket.created), now),
      body: it.ticket.body,
      runs: refs && refs.length > 0
        ? refs.map((r) => ({ id: r.id, status: r.status }))
        : undefined,
    };
  };

  const bucketize = (items: Indexed[]): TicketBuckets => {
    const ready: TicketCitation[] = [];
    const inProgress: TicketCitation[] = [];
    const blocked: TicketCitation[] = [];
    for (const it of items) {
      if (it.ticket.status === "closed") continue;
      const openSet = openByProject.get(it.projectId)!;
      const isBlocked =
        it.ticket.depends.length > 0 &&
        it.ticket.depends.some((d) => openSet.has(d));
      const citation = toCitation(it);
      if (it.ticket.status === "in_progress") inProgress.push(citation);
      else if (isBlocked) blocked.push(citation);
      else ready.push(citation);
    }
    const sortFn = (a: TicketCitation, b: TicketCitation) =>
      a.priority - b.priority || a.id.localeCompare(b.id);
    ready.sort(sortFn);
    inProgress.sort(sortFn);
    blocked.sort(sortFn);
    return { ready, inProgress, blocked };
  };

  // Group: epic tickets, children-by-epic, and standalone (everything else).
  const epicTickets = all.filter((it) => it.ticket.type === "epic");
  const childrenByEpic = new Map<string, Indexed[]>();
  const standalonePool: Indexed[] = [];

  for (const it of all) {
    if (it.ticket.type === "epic") continue;
    const parent = it.ticket.parentEpic;
    if (parent) {
      // Match scoped to project — same epic id across projects shouldn't merge.
      const key = `${it.projectId}::${parent}`;
      if (!childrenByEpic.has(key)) childrenByEpic.set(key, []);
      childrenByEpic.get(key)!.push(it);
    } else {
      standalonePool.push(it);
    }
  }

  const epicBoards: EpicBoard[] = [];
  for (const epicIt of epicTickets) {
    const key = `${epicIt.projectId}::${epicIt.ticket.id}`;
    const kids = childrenByEpic.get(key) ?? [];
    const buckets = bucketize(kids);
    const childCount = buckets.ready.length + buckets.inProgress.length + buckets.blocked.length;

    // Skip epics where the epic is closed AND there are no active children.
    if (epicIt.ticket.status === "closed" && childCount === 0) continue;

    // Activity: most recent child updated, fallback to epic.updated.
    const updates = kids
      .map((k) => Date.parse(k.ticket.updated))
      .filter((n) => !Number.isNaN(n));
    const epicUpdate = Date.parse(epicIt.ticket.updated);
    const latest = updates.length > 0 ? Math.max(...updates) : epicUpdate;
    const lastActivity = new Date(Number.isNaN(latest) ? Date.now() : latest).toISOString();

    epicBoards.push({
      epic: {
        ...toCitation(epicIt),
        status: epicIt.ticket.status,
      },
      buckets,
      childCount,
      lastActivity,
    });
  }

  epicBoards.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  const standalone = bucketize(standalonePool);

  const totalActive =
    standalone.ready.length +
    standalone.inProgress.length +
    standalone.blocked.length +
    epicBoards.reduce((sum, e) => sum + e.childCount, 0);

  return {
    generatedAt: now.toISOString(),
    epics: epicBoards,
    standalone,
    totalActive,
    projectCount: projectsWithTickets.size,
    projectIds: [...projectsWithTickets].sort(),
  };
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
    const metadataRaw = await safeReadFile(join(runDir, "run.json"));
    const metadata = metadataRaw
      ? (() => {
          try {
            return JSON.parse(metadataRaw) as { projectId?: string; ticketId?: string; createdAt?: string };
          } catch {
            return null;
          }
        })()
      : null;

    const goalStat = await safeStat(join(runDir, "goal.md"));
    const statusStat = await safeStat(join(runDir, "status"));

    const startedAt = metadata?.createdAt ?? (goalStat ? goalStat.mtime.toISOString() : null);
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
      projectId: metadata?.projectId ?? extractProjectId(body, knownProjects),
      ticketId: metadata?.ticketId ?? extractTicketId(body),
    });
  }

  return out;
}

/** Latest Propose artifact. Historical bets.md is read only as a migration fallback. */
export async function collectPropose(paths: HivePaths): Promise<ProposeEntry | null> {
  const entries = await readdir(paths.memoryRunsDir, { withFileTypes: true }).catch(() => []);
  const dates = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, 7);
  for (const date of dates) {
    const raw =
      (await safeReadFile(join(paths.memoryRunsDir, date, "propose.md"))) ??
      (await safeReadFile(join(paths.memoryRunsDir, date, "bets.md")));
    if (raw && raw.trim()) {
      // Strip the artifact's own H1 — the dashboard section supplies the heading.
      return { date, body: raw.trim().replace(/^# .*\n+/, "") };
    }
  }
  return null;
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
// Promotion candidates — memory entries that have earned a look for CLAUDE.md
// ---------------------------------------------------------------------------

/**
 * Conventions (and high-strength facts) that have persisted long enough and
 * been recalled enough to be worth promoting to a project's CLAUDE.md.
 *
 * Criteria (V1):
 *   - section === "convention" (start narrow; facts can be added later)
 *   - ageDays >= 14 (created at least two weeks ago — past the impulsive-write zone)
 *   - strength >= 2.0 (means recalled at least once and not heavily decayed)
 *
 * Returns sorted by strength descending. No marking/dismiss state in V1 —
 * humans copy what they want into CLAUDE.md; entries that don't get used
 * keep getting recalled (and stay candidates) or fade naturally.
 */
const PROMOTION_MIN_AGE_DAYS = 14;
const PROMOTION_MIN_STRENGTH = 2.0;
const PROMOTION_PER_PROJECT_CAP = 10;

export async function collectPromotionCandidates(paths: HivePaths): Promise<PromotionCandidate[]> {
  const projectIds = await listProjects(paths);
  const today = new Date().toISOString().slice(0, 10);
  const all: PromotionCandidate[] = [];

  for (const projectId of projectIds) {
    let snapshot;
    let meta;
    try {
      snapshot = await readProjectMemorySnapshot(paths, projectId);
      meta = await readMeta(paths, projectId);
    } catch {
      continue; // intentional: project has no memory yet, or unreadable
    }

    const conventions = snapshot.conventions.filter((c) => !c.superseded);
    const candidates: PromotionCandidate[] = [];

    for (const c of conventions) {
      const entryMeta = meta.entries[entryHash(c.text)];
      const strength = entryStrength(entryMeta);
      const ageDays = entryMeta ? daysBetween(entryMeta.createdAt, today) : 0;

      if (ageDays < PROMOTION_MIN_AGE_DAYS) continue;
      if (strength < PROMOTION_MIN_STRENGTH) continue;

      candidates.push({
        projectId,
        text: c.text,
        section: "convention",
        strength,
        recallCount: entryMeta?.recallCount ?? 0,
        ageDays,
        createdAt: entryMeta?.createdAt ?? "unknown",
      });
    }

    candidates.sort((a, b) => b.strength - a.strength);
    all.push(...candidates.slice(0, PROMOTION_PER_PROJECT_CAP));
  }

  // Cross-project sort by strength so the dashboard surfaces the strongest first.
  all.sort((a, b) => b.strength - a.strength);
  return all;
}

// ---------------------------------------------------------------------------
// V1 cross-cutting widgets — open questions, recent memory, run usage.
// ---------------------------------------------------------------------------

const RECENT_MEMORY_WINDOW_DAYS = 7;
const RECENT_MEMORY_LIMIT = 25;

export async function collectOpenQuestions(paths: HivePaths): Promise<OpenQuestion[]> {
  const ids = await listProjects(paths.projectsDir);
  const out: OpenQuestion[] = [];
  for (const projectId of ids) {
    let snap;
    try {
      snap = await readProjectMemorySnapshot(paths, projectId);
    } catch {
      continue; // intentional: project memory unreadable
    }
    for (const q of snap.questions) {
      if (q.superseded) continue;
      out.push({ projectId, text: q.text, tags: q.tags });
    }
  }
  return out;
}

export async function collectRecentMemory(
  paths: HivePaths,
  options: { windowDays?: number; limit?: number } = {},
): Promise<RecentMemoryEntry[]> {
  const windowDays = options.windowDays ?? RECENT_MEMORY_WINDOW_DAYS;
  const limit = options.limit ?? RECENT_MEMORY_LIMIT;
  const today = new Date().toISOString().slice(0, 10);
  const ids = await listProjects(paths.projectsDir);
  const out: RecentMemoryEntry[] = [];

  for (const projectId of ids) {
    let snap;
    let meta;
    try {
      snap = await readProjectMemorySnapshot(paths, projectId);
      meta = await readMeta(paths, projectId);
    } catch {
      continue; // intentional: project memory unreadable
    }

    const sections: Array<{ section: MemorySection; entries: { text: string; tags: string[]; superseded?: boolean }[] }> = [
      { section: "fact", entries: snap.facts },
      { section: "convention", entries: snap.conventions },
      { section: "decision", entries: snap.decisions },
      { section: "question", entries: snap.questions },
    ];

    for (const { section, entries } of sections) {
      for (const e of entries) {
        if (e.superseded) continue;
        const m = meta.entries[entryHash(e.text)];
        if (!m) continue;

        // Active in the last N days: created OR recalled within the window.
        const ageCreated = daysBetweenStrings(m.createdAt, today);
        const ageRecalled = m.lastRecalled ? daysBetweenStrings(m.lastRecalled, today) : Infinity;
        const recencyAge = Math.min(ageCreated, ageRecalled);
        if (recencyAge > windowDays) continue;

        out.push({
          projectId,
          section,
          text: e.text,
          tags: e.tags,
          createdAt: m.createdAt,
          lastRecalled: m.lastRecalled,
          strength: entryStrength(m),
        });
      }
    }
  }

  out.sort((a, b) => b.strength - a.strength);
  return out.slice(0, limit);
}

export async function collectLatestReflection(paths: HivePaths): Promise<ReflectionDay | null> {
  if (!existsSync(paths.reflectionsDir)) return null;
  const files = (await readdir(paths.reflectionsDir).catch(() => [] as string[]))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();
  if (files.length === 0) return null;

  const file = files[0]!;
  const date = file.replace(/\.md$/, "");
  const raw = (await safeReadFile(join(paths.reflectionsDir, file))) ?? "";
  const { body } = parseFrontmatter(raw);
  const today = new Date().toISOString().slice(0, 10);
  const ageDays = daysBetweenStrings(date, today);
  return { date, body: body.trim(), ageDays };
}

export async function collectRunUsage(
  paths: HivePaths,
  date: string = new Date().toISOString().slice(0, 10),
): Promise<RunUsageSnapshot> {
  const summary = await loadUsageSummary(paths, date);
  const available = summary.records.length > 0;
  const passes: RunUsagePassEntry[] = summary.records.map((r) => ({
    pass: r.pass,
    project: r.project ?? null,
    provider: r.provider,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    usd: r.cost.totalUsd,
    usdFormatted: formatUsd(r.cost.totalUsd),
    durationMs: r.durationMs,
  }));
  return {
    date,
    available,
    totalInputTokens: summary.totals.inputTokens,
    totalOutputTokens: summary.totals.outputTokens,
    totalUsd: summary.totals.totalUsd,
    totalUsdFormatted: formatUsd(summary.totals.totalUsd),
    passes,
  };
}

// ---------------------------------------------------------------------------
// Taste track (TA → TB → TC + replay) — the nightly's judgment-memory pass.
// Sourced from runs/{date}/taste-decisions.json (the merged TasteConsolidate
// result TC writes); the data exists per run, it just wasn't surfaced.
// ---------------------------------------------------------------------------

export type TasteTrackUnit = {
  dedupeKey: string;
  category: string;
  tier: string;
  recurrence: number;
  laddersUpTo: string | null;
};

export type TasteTrackSnapshot = {
  date: string;
  available: boolean;
  written: number;
  reviewEligible: number;
  holding: number;
  conflicts: number;
  tensions: number;
  handoffs: number;
  droppedNoise: number;
  droppedNegative: number;
  /** Decisions whose replay verdict confirmed the rule (design §9). */
  replayPassed: number;
  /** Decisions held because replay couldn't decide (thin corpus / failed judge). */
  replayInconclusive: number;
  newPrincipleProposals: string[];
  /** The units `hive taste review` will walk — the actionable queue. */
  reviewEligibleUnits: TasteTrackUnit[];
};

export async function collectTasteTrack(
  paths: HivePaths,
  date: string = new Date().toISOString().slice(0, 10),
): Promise<TasteTrackSnapshot> {
  const empty: TasteTrackSnapshot = {
    date,
    available: false,
    written: 0,
    reviewEligible: 0,
    holding: 0,
    conflicts: 0,
    tensions: 0,
    handoffs: 0,
    droppedNoise: 0,
    droppedNegative: 0,
    replayPassed: 0,
    replayInconclusive: 0,
    newPrincipleProposals: [],
    reviewEligibleUnits: [],
  };

  const raw = await safeReadFile(join(paths.memoryRunsDir, date, "taste-decisions.json"));
  if (!raw) return empty;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw);
  } catch {
    return empty; // intentional: a half-written/corrupt artifact reads as "no taste run"
  }

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const decisions = Array.isArray(r.decisions) ? (r.decisions as Array<Record<string, unknown>>) : [];

  const reviewEligibleUnits: TasteTrackUnit[] = decisions
    .filter((d) => d.reviewEligible === true && d.status)
    .map((d) => ({
      dedupeKey: typeof d.dedupe_key === "string" ? d.dedupe_key : "(unknown)",
      category: typeof d.category === "string" ? d.category : "—",
      tier: typeof d.tier === "string" ? d.tier : "—",
      recurrence: num(d.recurrence),
      laddersUpTo: typeof d.ladders_up_to === "string" ? d.ladders_up_to : null,
    }))
    .slice(0, 12);

  const replayOf = (d: Record<string, unknown>) => (d.replay && typeof d.replay === "object" ? (d.replay as Record<string, unknown>) : null);

  return {
    date,
    available: true,
    written: num(r.written),
    reviewEligible: num(r.reviewEligible),
    holding: num(r.holding),
    conflicts: len(r.conflicts),
    tensions: len(r.tensions),
    handoffs: len(r.handoffsToFacts),
    droppedNoise: num(r.droppedNoise),
    droppedNegative: num(r.droppedNegative),
    replayPassed: decisions.filter((d) => replayOf(d)?.passed === true).length,
    replayInconclusive: decisions.filter((d) => replayOf(d)?.inconclusive === true).length,
    newPrincipleProposals: Array.isArray(r.newPrincipleProposals)
      ? (r.newPrincipleProposals as unknown[]).filter((p): p is string => typeof p === "string")
      : [],
    reviewEligibleUnits,
  };
}

// ---------------------------------------------------------------------------
// Taste page (the durable library) — /taste
//
// The taste-track SECTION on the home page shows one night's gate output.
// The /taste PAGE shows the accumulated library: every taste unit HIVE has
// admitted, grouped by category, with its status, recurrence, and the apex
// principle it ladders up to — plus the latest run's gate strip for context.
// ---------------------------------------------------------------------------

export type TastePageUnit = {
  hash: string;
  category: TasteCategory;
  secondaryCategory: TasteCategory | null;
  tier: string;
  scopeKind: string;
  glob: string | null;
  scopeLabel: string; // "general" or the project id whose store it lives in
  status: TasteUnitStatus; // holding | pending | active
  recurrence: number;
  ruleStatement: string;
  reasoning: string; // the WHY — load-bearing
  laddersUpTo: string | null;
  reasonSource: string; // "stated" | "inferred"
  bad: string;
  good: string;
  firstSeen: string | null;
  lastSeen: string | null;
};

export type TasteCategoryGroup = {
  category: TasteCategory;
  active: number;
  pending: number;
  holding: number;
  units: TastePageUnit[];
};

export type TastePrinciple = {
  name: string; // the ### header
  body: string; // the paragraph beneath it, newlines collapsed
};

export type TastePageData = {
  generatedAt: string;
  latestRun: TasteTrackSnapshot; // the night's gate strip, for context
  groups: TasteCategoryGroup[]; // the library, by category
  totals: { active: number; pending: number; holding: number; total: number };
  principles: TastePrinciple[]; // apex canon the units ladder up to, with gloss
  scopes: string[]; // which stores contributed (general + project ids)
};

const TASTE_STATUS_SORT: Record<TasteUnitStatus, number> = { active: 0, pending: 1, holding: 2 };

function toTastePageUnit(u: TasteUnit, scopeLabel: string): TastePageUnit {
  return {
    hash: u.hash,
    category: u.category,
    secondaryCategory: u.secondary_category ?? null,
    tier: u.tier,
    scopeKind: u.scope.kind,
    glob: u.scope.glob ?? null,
    scopeLabel,
    status: u.status,
    recurrence: u.recurrence,
    ruleStatement: u.rule_statement,
    reasoning: u.reasoning,
    laddersUpTo: u.ladders_up_hint ?? null,
    reasonSource: u.reason_source,
    bad: u.canonical_example?.bad ?? "",
    good: u.canonical_example?.good ?? "",
    firstSeen: u.firstSeen ?? null,
    lastSeen: u.lastSeen ?? null,
  };
}

/** Apex principles (name + gloss) from ~/.hive/taste/principles.md `### blocks`. */
async function collectTastePrinciples(paths: HivePaths): Promise<TastePrinciple[]> {
  const raw = await safeReadFile(join(paths.home, "taste", "principles.md"));
  if (!raw) return [];
  const out: TastePrinciple[] = [];
  // Split on the `### ` headers; the leading chunk (title + intro) is dropped.
  for (const block of raw.split(/^### /m).slice(1)) {
    const nl = block.indexOf("\n");
    const name = (nl === -1 ? block : block.slice(0, nl)).trim();
    const body =
      nl === -1
        ? ""
        : block
            .slice(nl + 1)
            .trim()
            .replace(/\s+/g, " "); // collapse soft-wrapped paragraph to one line
    if (name) out.push({ name, body });
  }
  return out;
}

export async function collectTastePage(paths: HivePaths): Promise<TastePageData> {
  const generatedAt = new Date().toISOString();

  // The durable library: the cross-project general store plus any per-project
  // stores. readTasteUnits tolerates missing category files, so empty stores
  // just contribute nothing.
  const scopes: string[] = ["general"];
  const collected: TastePageUnit[] = (await readTasteUnits(generalTasteDir(paths))).map((u) =>
    toTastePageUnit(u, "general"),
  );

  for (const id of await listProjects(paths.projectsDir)) {
    const units = await readTasteUnits(projectTasteDir(paths, id));
    if (units.length) {
      scopes.push(id);
      collected.push(...units.map((u) => toTastePageUnit(u, id)));
    }
  }

  // Group by category. Within a group: active → pending → holding, then
  // recurrence desc, then rule text for a stable order.
  const groups: TasteCategoryGroup[] = [];
  for (const category of TASTE_CATEGORIES) {
    const units = collected
      .filter((u) => u.category === category)
      .sort(
        (a, b) =>
          TASTE_STATUS_SORT[a.status] - TASTE_STATUS_SORT[b.status] ||
          b.recurrence - a.recurrence ||
          a.ruleStatement.localeCompare(b.ruleStatement),
      );
    if (!units.length) continue;
    groups.push({
      category,
      active: units.filter((u) => u.status === "active").length,
      pending: units.filter((u) => u.status === "pending").length,
      holding: units.filter((u) => u.status === "holding").length,
      units,
    });
  }

  const totals = {
    active: collected.filter((u) => u.status === "active").length,
    pending: collected.filter((u) => u.status === "pending").length,
    holding: collected.filter((u) => u.status === "holding").length,
    total: collected.length,
  };

  const [latestRun, principles] = await Promise.all([
    collectTasteTrack(paths),
    collectTastePrinciples(paths),
  ]);

  return { generatedAt, latestRun, groups, totals, principles, scopes };
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export async function collectDashboardData(paths: HivePaths): Promise<DashboardData> {
  const [health, projects, inboxes, tickets, runs, briefings, promotionCandidates, openQuestions, recentMemory, runUsage, tasteTrack, latestReflection, propose] = await Promise.all([
    collectHealth(paths),
    collectProjects(paths),
    collectInboxes(paths),
    collectTickets(paths),
    collectRuns(paths),
    collectBriefings(paths),
    collectPromotionCandidates(paths),
    collectOpenQuestions(paths),
    collectRecentMemory(paths),
    collectRunUsage(paths),
    collectTasteTrack(paths),
    collectLatestReflection(paths),
    collectPropose(paths),
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
    promotionCandidates,
    openQuestions,
    recentMemory,
    runUsage,
    tasteTrack,
    latestReflection,
    propose,
  };
}
