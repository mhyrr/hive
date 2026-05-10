/**
 * Runs page renderer — turns collectRuns() output into a broadsheet HTML page.
 *
 * Two sections:
 *   1. Active runs panel (top) — one row per running dispatch/campaign
 *   2. Terminal timeline (below) — completed runs newest-first
 *
 * Pure function: no I/O, no async, no DOM.
 */

import type { CollectedRuns, RunRow, RunRowStatus } from "./collect";
import { DASHBOARD_CSS } from "../styles";
import { DASHBOARD_JS } from "../script";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunsPageRenderOptions = {
  interactive?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCost(usd: number | undefined): string {
  if (usd === undefined || usd === null) return "—";
  return `$${usd.toFixed(2)}`;
}

function statusBadgeClass(status: RunRowStatus): string {
  switch (status) {
    case "shipped":
      return "run-status-shipped";
    case "partial":
    case "failed":
    case "crashed":
      return "run-status-failed";
    case "running":
      return "run-status-running";
    default:
      return "";
  }
}

function kindLabel(kind: "dispatch" | "campaign"): string {
  return kind === "dispatch" ? "dispatch" : "campaign";
}

function longDate(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()]!;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${weekday}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut) + "…";
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderActivePanel(active: RunRow[]): string {
  if (active.length === 0) {
    return `
<section class="section" id="section-active-runs">
  <div class="section-head">
    <h2>Active Runs</h2>
    <span class="kicker">None</span>
  </div>
  <hr class="amber"/>
  <div class="runs-empty">No runs in flight.</div>
</section>`;
  }

  const rows = active
    .map((r) => {
      const ticketLink = r.ticketId
        ? `<a href="/tickets#${escapeHtml(r.ticketId)}" class="mono">${escapeHtml(r.ticketId)}</a>`
        : `<span class="runs-muted">—</span>`;
      const logLine = r.lastLogLine
        ? escapeHtml(truncate(r.lastLogLine, 120))
        : `<span class="runs-muted">no output yet</span>`;
      return `<div class="active-run-row">
  <a href="/runs/${escapeHtml(r.id)}" class="run-id mono">${escapeHtml(r.id)}</a>
  <span class="run-kind mono">${escapeHtml(kindLabel(r.kind))}</span>
  ${ticketLink}
  <span class="run-elapsed mono">${escapeHtml(formatElapsed(r.elapsedSec))}</span>
  <div class="run-log mono">${logLine}</div>
</div>`;
    })
    .join("\n");

  return `
<section class="section" id="section-active-runs">
  <div class="section-head">
    <h2>Active Runs</h2>
    <span class="kicker">${active.length} in flight</span>
  </div>
  <hr class="amber"/>
  <div class="active-runs">
${rows}
  </div>
</section>`;
}

function renderTerminalTimeline(terminal: RunRow[]): string {
  if (terminal.length === 0) {
    return `
<section class="section" id="section-terminal-runs">
  <div class="section-head">
    <h2>Run History</h2>
    <span class="kicker">None</span>
  </div>
  <hr class="amber"/>
  <div class="runs-empty">No completed runs yet.</div>
</section>`;
  }

  const rows = terminal
    .map((r) => {
      const badgeClass = statusBadgeClass(r.status);
      const ticketCell = r.ticketId
        ? `<a href="/tickets#${escapeHtml(r.ticketId)}" class="mono">${escapeHtml(r.ticketId)}</a>`
        : `<span class="runs-muted">—</span>`;
      return `<tr class="timeline-row">
  <td><a href="/runs/${escapeHtml(r.id)}" class="run-id mono">${escapeHtml(r.id)}</a></td>
  <td class="mono">${escapeHtml(kindLabel(r.kind))}</td>
  <td>${ticketCell}</td>
  <td><span class="run-status ${badgeClass} mono">${escapeHtml(r.status)}</span></td>
  <td class="mono">${escapeHtml(formatElapsed(r.elapsedSec))}</td>
  <td class="num mono">${escapeHtml(formatCost(r.costUsd))}</td>
  <td class="run-goal">${escapeHtml(truncate(r.goalSummary, 100))}</td>
</tr>`;
    })
    .join("\n");

  return `
<section class="section" id="section-terminal-runs">
  <div class="section-head">
    <h2>Run History</h2>
    <span class="kicker">${terminal.length} completed</span>
  </div>
  <hr class="amber"/>
  <table class="runs-timeline">
    <thead>
      <tr>
        <th>Run</th>
        <th>Kind</th>
        <th>Ticket</th>
        <th>Status</th>
        <th>Elapsed</th>
        <th class="num">Cost</th>
        <th>Goal</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the runs page body (active panel + terminal timeline).
 * Returns an HTML string fragment — no <html>/<head> wrapper.
 */
export function renderRunsPage(data: CollectedRuns): string {
  return [
    renderActivePanel(data.active),
    renderTerminalTimeline(data.terminal),
  ].join("\n");
}

/**
 * Render a complete HTML document for the /runs page.
 */
export function renderRunsPageDocument(
  data: CollectedRuns,
  opts: RunsPageRenderOptions = {},
): string {
  const interactive = opts.interactive !== false;
  const today = new Date().toISOString().slice(0, 10);

  const navItems: Array<[string, string]> = [
    ["BRIEFING", "/"],
    ["PROJECTS", "/#section-projects"],
    ["INBOX", "/#section-inboxes"],
    ["REFLECTIONS", "/#section-reflections"],
    ["DISPATCH", "/#section-dispatch"],
    ["ARCHIVE", "/#section-archive"],
    ["TICKETS", "/tickets"],
    ["RUNS", "/runs"],
  ];
  const nav = navItems
    .map(([label, href]) => {
      const active = href === "/runs" ? ' class="nav-active"' : "";
      return `<a href="${href}"${active}>${label}</a>`;
    })
    .join(' <span class="nav-sep">·</span> ');

  const scriptBlock = interactive ? `<script>${DASHBOARD_JS}</script>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>HIVE · Runs · ${escapeHtml(today)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="page page-wide">
  <nav class="page-nav">${nav}</nav>
  <header class="masthead">
    <h1>HIVE</h1>
    <div class="dateline">
      <span>Runs</span>
      <span class="sep">·</span>
      <span>${escapeHtml(longDate(today))}</span>
    </div>
  </header>
  ${renderRunsPage(data)}
</div>
${scriptBlock}
</body>
</html>`;
}
