/**
 * Pure render: DashboardData -> single HTML string.
 *
 * No I/O. Tests assert on structural properties of the output.
 */

import { marked } from "marked";

import type {
  DashboardData,
  HealthEntry,
  ProjectCard,
  InboxEntry,
  BriefingEntry,
  RunEntry,
  TicketBuckets,
  TicketCitation,
} from "./collect";
import { DASHBOARD_CSS } from "./styles";
import { DASHBOARD_JS } from "./script";
import type { TicketPriority } from "../ticket";

// ---------------------------------------------------------------------------
// Helpers (escape + format)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render markdown → HTML. `marked` is fine for our local-only use case. */
function md(source: string): string {
  if (!source || !source.trim()) return "";
  // Synchronous usage by default in marked v18.
  return marked.parse(source, { async: false, breaks: false, gfm: true }) as string;
}

function longDate(iso: string): string {
  // "2026-04-17" or ISO → "Wednesday, April 17, 2026"
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]!;
  const months = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  return `${weekday}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function shortDate(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function weekdayDate(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${weekdays[d.getDay()]} · ${months[d.getMonth()]} ${d.getDate()}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem === 0 ? `${minutes}m` : `${minutes}m${rem}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

const PRIORITY_LABELS: Record<TicketPriority, string> = {
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
};

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderMasthead(data: DashboardData): string {
  const tickerItems = data.health
    .map((h: HealthEntry) => {
      const when = h.mtime ? relativeTime(h.mtime) : "—";
      return `<span class="item"><span class="label">${escapeHtml(h.label)}</span>${escapeHtml(when)}</span>`;
    })
    .join("");

  return `
<header class="masthead">
  <h1>HIVE</h1>
  <div class="dateline">
    <span>${escapeHtml(longDate(data.today))}</span>
    <span class="sep">·</span>
    <span>Vol. ${data.volumeNumber}</span>
    <span class="sep">·</span>
    <span>The Morning Edition</span>
  </div>
</header>
<div class="ticker">${tickerItems}</div>`;
}

function renderBriefings(data: DashboardData): string {
  if (data.briefings.length === 0) {
    return `
<section class="section">
  <div class="section-head"><h2>Today&rsquo;s Briefing</h2><span class="kicker">No briefings on file</span></div>
  <hr class="amber"/>
  <p>Run the morning job to generate a briefing.</p>
</section>`;
  }

  const articles = data.briefings
    .map((b: BriefingEntry) => {
      const isActive = b.date === data.today;
      return `<article class="briefing-article ${isActive ? "active" : ""}" data-briefing-date="${escapeHtml(b.date)}">
  <div class="briefing">${md(b.body)}</div>
</article>`;
    })
    .join("\n");

  return `
<section class="section" id="briefing-section">
  <div class="section-head">
    <h2>Today&rsquo;s Briefing</h2>
    <span class="kicker">Dated ${escapeHtml(longDate(data.today))}</span>
  </div>
  <hr class="amber"/>
  <div class="briefing-wrap">
    ${articles}
  </div>
</section>`;
}

function renderProjects(projects: ProjectCard[]): string {
  if (projects.length === 0) {
    return "";
  }

  const rows = projects
    .map((p: ProjectCard) => {
      const p0 = p.ticketCounts.byPriority[0] || 0;
      const p1 = p.ticketCounts.byPriority[1] || 0;
      const p2 = p.ticketCounts.byPriority[2] || 0;
      const p3 = p.ticketCounts.byPriority[3] || 0;
      return `<tr>
  <td class="project-name">${escapeHtml(p.id)}</td>
  <td class="path">${escapeHtml(p.path ?? "—")}</td>
  <td class="num">${p.ticketCounts.open}</td>
  <td class="num">${p.ticketCounts.inProgress}</td>
  <td class="num">${p0 + p1}</td>
  <td class="num">${p2 + p3}</td>
  <td class="num">${escapeHtml(relativeTime(p.lastHeartbeat))}</td>
  <td class="num">${p.tickCount}</td>
  <td class="num">${escapeHtml(relativeTime(p.inboxMtime))}</td>
</tr>`;
    })
    .join("\n");

  return `
<section class="section">
  <div class="section-head">
    <h2>Projects at a Glance</h2>
    <span class="kicker">${projects.length} Registered</span>
  </div>
  <hr class="amber"/>
  <table class="ledger">
    <thead>
      <tr>
        <th>Project</th>
        <th>Path</th>
        <th class="num">Open</th>
        <th class="num">In&nbsp;Prog.</th>
        <th class="num">P0&ndash;1</th>
        <th class="num">P2&ndash;3</th>
        <th class="num">Heartbeat</th>
        <th class="num">Ticks</th>
        <th class="num">Inbox</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;
}

function renderInboxes(inboxes: InboxEntry[]): string {
  if (inboxes.length === 0) return "";

  const entries = inboxes
    .map((entry: InboxEntry, idx: number) => {
      const bodyId = `inbox-body-${idx}`;
      const toggleId = `inbox-toggle-${idx}`;
      if (entry.isEmpty) {
        return `<div class="inbox-entry empty">
  <div class="head"><span class="project">${escapeHtml(entry.projectId)}</span><span class="mtime">quiet</span></div>
  <div class="body">No dispatches on file.</div>
</div>`;
      }
      const when = entry.mtime ? relativeTime(entry.mtime) : "—";
      return `<div class="inbox-entry">
  <div class="head">
    <span class="project">${escapeHtml(entry.projectId)}
      <span id="${toggleId}" class="toggle" data-toggle="${bodyId}" data-show="Show" data-hide="Hide">Hide</span>
    </span>
    <span class="mtime">${escapeHtml(when)}</span>
  </div>
  <div class="body" id="${bodyId}">${md(entry.body)}</div>
</div>`;
    })
    .join("\n");

  return `
<section class="section">
  <div class="section-head">
    <h2>The Inbox</h2>
    <span class="kicker">Per-project dispatches</span>
  </div>
  <hr class="amber"/>
  <div class="inbox-grid">
${entries}
  </div>
</section>`;
}

function renderTicketRow(t: TicketCitation): string {
  const priority = PRIORITY_LABELS[t.priority] ?? "P?";
  const tags = t.tags.length > 0 ? ` · ${t.tags.join(" · ")}` : "";
  const deps = t.depends.length > 0
    ? `<div class="deps">depends on ${t.depends.map((d) => escapeHtml(d)).join(", ")}</div>`
    : "";
  return `<div class="ticket-row">
  <div>
    <span class="id">${escapeHtml(t.projectId)}/${escapeHtml(t.id)}</span>
    <span class="title">${escapeHtml(t.title)}</span>
  </div>
  <div class="meta">
    <span class="prio-${priority}">${priority}</span>
    · ${t.ageDays}d old${escapeHtml(tags)}
  </div>
  ${deps}
</div>`;
}

function renderTickets(buckets: TicketBuckets): string {
  const total = buckets.ready.length + buckets.inProgress.length + buckets.blocked.length;
  if (total === 0) {
    return `
<section class="section">
  <div class="section-head"><h2>Tickets</h2><span class="kicker">None open</span></div>
  <hr class="amber"/>
  <p>Clean desk.</p>
</section>`;
  }

  const renderGroup = (label: string, kind: "ready" | "progress" | "blocked", items: TicketCitation[]): string => {
    if (items.length === 0) {
      return `<div class="ticket-group">
  <h3>${escapeHtml(label)}</h3>
  <div class="ticket-row" style="color: var(--muted); font-style: italic;">None.</div>
</div>`;
    }
    const rows = items.map(renderTicketRow).join("\n");
    return `<div class="ticket-group">
  <h3>${escapeHtml(label)} <span class="status-tag ${kind}">${items.length}</span></h3>
${rows}
</div>`;
  };

  return `
<section class="section">
  <div class="section-head">
    <h2>Tickets</h2>
    <span class="kicker">${total} Active across all projects</span>
  </div>
  <hr class="amber"/>
  <div class="ticket-groups">
    ${renderGroup("In Progress", "progress", buckets.inProgress)}
    ${renderGroup("Ready", "ready", buckets.ready)}
    ${renderGroup("Blocked", "blocked", buckets.blocked)}
  </div>
</section>`;
}

function renderRuns(runs: RunEntry[]): string {
  if (runs.length === 0) return "";

  const rows = runs
    .map((r: RunEntry) => {
      const statusClass = `status-${(r.status || "unknown").toLowerCase()}`;
      const ticketCell = r.ticketId ? escapeHtml(r.ticketId) : "—";
      return `<li class="dispatch-row">
  <span class="id">${escapeHtml(r.id)}</span>
  <span class="status ${statusClass}">${escapeHtml(r.status)}</span>
  <span class="duration">${escapeHtml(formatDuration(r.durationMs))}</span>
  <span class="goal">${escapeHtml(r.goalSnippet || "—")}</span>
  <span class="ticket">${ticketCell}</span>
</li>`;
    })
    .join("\n");

  return `
<section class="section">
  <div class="section-head">
    <h2>Dispatch Log</h2>
    <span class="kicker">${runs.length} Most recent</span>
  </div>
  <hr class="amber"/>
  <ul class="dispatch-list">
${rows}
  </ul>
</section>`;
}

function renderArchive(data: DashboardData): string {
  if (data.briefings.length === 0) return "";

  const limit = 30;
  const cards = data.briefings
    .slice(0, limit)
    .map((b: BriefingEntry) => {
      const isActive = b.date === data.today;
      return `<div class="archive-card ${isActive ? "active" : ""}" data-archive-card="${escapeHtml(b.date)}">
  <div class="date">${escapeHtml(weekdayDate(b.date))}</div>
  <div class="head">${escapeHtml(b.headline)}</div>
</div>`;
    })
    .join("\n");

  return `
<section class="section">
  <div class="section-head">
    <h2>The Archive</h2>
    <span class="kicker">Past ${Math.min(limit, data.briefings.length)} days · click a date to load</span>
  </div>
  <hr class="amber"/>
  <div class="archive">
${cards}
  </div>
</section>`;
}

function renderFooter(data: DashboardData): string {
  return `
<footer class="footer">
  Generated ${escapeHtml(new Date(data.generatedAt).toLocaleString())}
  · Single-file static · No network
</footer>`;
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export function renderDashboard(data: DashboardData): string {
  const body = [
    renderMasthead(data),
    `<main class="page">`,
    renderBriefings(data),
    renderProjects(data.projects),
    renderInboxes(data.inboxes),
    renderTickets(data.tickets),
    renderRuns(data.runs),
    renderArchive(data),
    renderFooter(data),
    `</main>`,
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="generator" content="hive dashboard"/>
<title>HIVE · The Morning Edition · ${escapeHtml(shortDate(data.today))}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
${body}
<script>${DASHBOARD_JS}</script>
</body>
</html>`;
}
