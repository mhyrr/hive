/**
 * Runs page renderer — turns collectRuns() output into a broadsheet HTML page.
 *
 * Two sections:
 *   1. Active runs panel (top) — one row per running dispatch/campaign
 *   2. Terminal timeline (below) — completed runs newest-first
 *
 * Pure function: no I/O, no async, no DOM.
 */

import { marked } from "marked";

import type { CollectedRuns, RunRow, RunRowStatus, GoalArc, ArcStatus } from "./collect";
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
// Goal arc card
// ---------------------------------------------------------------------------

function arcChipClass(status: ArcStatus): string {
  switch (status) {
    case "shipped":   return "chip-shipped";
    case "in-flight": return "chip-in-flight";
    case "blocked":   return "chip-blocked";
    case "mixed":     return "chip-mixed";
    default:          return "chip-unknown";
  }
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function lastActivity(arc: GoalArc): string {
  let latest = arc.epic.updated ?? arc.epic.created;
  for (const child of arc.children) {
    if (child.ticket.updated > latest) latest = child.ticket.updated;
  }
  return latest;
}

/**
 * Extract the first paragraph from the epic body for the "Original ask" block.
 * Returns [firstParagraph, restOfBody].
 */
function splitEpicBody(body: string): [string, string] {
  if (!body.trim()) return ["", ""];

  // Skip leading headings (## Goal, etc.) to find the first prose paragraph.
  const lines = body.split("\n");
  let firstParaStart = -1;
  let firstParaEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip empty lines and headings
    if (!line || line.startsWith("#")) continue;
    // Found the start of a paragraph
    if (firstParaStart === -1) {
      firstParaStart = i;
    }
    // Track contiguous non-empty, non-heading lines
    firstParaEnd = i;
    // If next line is empty or heading, that's the end of this paragraph
    const nextLine = lines[i + 1]?.trim();
    if (nextLine === undefined || nextLine === "" || nextLine.startsWith("#")) {
      break;
    }
  }

  if (firstParaStart === -1) return ["", body];

  const firstPara = lines.slice(firstParaStart, firstParaEnd + 1).join("\n");
  const rest = [
    ...lines.slice(0, firstParaStart),
    ...lines.slice(firstParaEnd + 1),
  ].join("\n").trim();

  return [firstPara, rest];
}

/**
 * Extract the latest note from the epic body (notes are appended as
 * `### timestamp [actor]\nnote text`). Returns the text of the last note,
 * or null if no notes found.
 */
function extractLatestNote(body: string): string | null {
  const notePattern = /^###\s+\d{4}-\d{2}-\d{2}T/m;
  const lines = body.split("\n");
  let lastNoteStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (notePattern.test(lines[i])) {
      lastNoteStart = i;
    }
  }

  if (lastNoteStart === -1) return null;

  // Collect note text after the heading
  const noteLines: string[] = [];
  for (let i = lastNoteStart + 1; i < lines.length; i++) {
    // Stop at the next note heading or end
    if (notePattern.test(lines[i])) break;
    noteLines.push(lines[i]);
  }
  const text = noteLines.join("\n").trim();
  return text || null;
}

/**
 * Render a goal arc card — expandable card with header and body.
 *
 * Header: epic title, status chip, total cost, run count, start + last activity.
 * Body: original ask, markdown epic body, decomposition tree, result line.
 */
export function renderGoalArc(arc: GoalArc): string {
  const epic = arc.epic;
  const chipClass = arcChipClass(arc.status);
  const costStr = arc.totalCost !== null ? `$${arc.totalCost.toFixed(2)}` : "—";
  const runLabel = arc.runCount === 1 ? "1 run" : `${arc.runCount} runs`;
  const startStr = shortDate(epic.created);
  const lastStr = shortDate(lastActivity(arc));
  const cardId = `arc-goal-${escapeHtml(epic.id)}`;

  // --- Header ---
  const header = `<div class="arc-header" data-arc-toggle="${cardId}">
  <span class="arc-expand">+</span>
  <span class="arc-title">${escapeHtml(epic.title)}</span>
  <span class="arc-chip ${chipClass}">${escapeHtml(arc.status)}</span>
  <span class="arc-meta">${escapeHtml(costStr)}</span>
  <span class="arc-meta">${escapeHtml(runLabel)}</span>
  <span class="arc-meta">${escapeHtml(startStr)} — ${escapeHtml(lastStr)}</span>
</div>`;

  // --- Body ---
  const epicBody = epic.body ?? "";
  const [firstPara, restBody] = splitEpicBody(epicBody);

  // Original ask block
  const originalAsk = firstPara
    ? `<div class="arc-section-label">Original Ask</div>
<div class="arc-prose"><p>${escapeHtml(firstPara)}</p></div>`
    : "";

  // Rendered markdown for the rest of the body (minus notes)
  const bodyWithoutNotes = restBody
    .split("\n")
    .filter((l) => !/^###\s+\d{4}-\d{2}-\d{2}T/.test(l))
    .join("\n")
    .trim();
  const renderedBody = bodyWithoutNotes
    ? `<div class="arc-prose">${marked.parse(bodyWithoutNotes)}</div>`
    : "";

  // Decomposition tree
  const childRows = arc.children.map((child) => {
    const { ticket, runs } = child;
    const runCell = runs.length > 0
      ? runs.map((r) => `<a href="/runs/${escapeHtml(r.id)}" class="run-id mono">${escapeHtml(r.id)}</a>`).join(", ")
      : `<span class="runs-muted">—</span>`;

    const statusClass = ticket.status === "closed" ? "chip-shipped"
      : ticket.status === "in_progress" ? "chip-in-flight"
      : "chip-mixed";

    const statusLabel = ticket.status === "closed" ? "shipped"
      : ticket.status === "in_progress" ? "in-flight"
      : "open";

    // Elapsed: not available from ticket data, show "—"
    const elapsedCell = runs.length > 0 ? "—" : "—";

    // Cost: dispatches don't track cost yet
    const costCell = "—";

    return `<li class="arc-child">
  <span class="arc-child-id"><a href="/tickets#${escapeHtml(ticket.id)}" class="mono">${escapeHtml(ticket.id)}</a></span>
  <span class="arc-child-title">${escapeHtml(ticket.title)}</span>
  <span class="arc-child-run">${runCell}</span>
  <span class="arc-child-status ${statusClass}">${escapeHtml(statusLabel)}</span>
  <span class="arc-child-elapsed">${escapeHtml(elapsedCell)}</span>
  <span class="arc-child-cost">${escapeHtml(costCell)}</span>
</li>`;
  }).join("\n");

  const tree = arc.children.length > 0
    ? `<div class="arc-section-label">Decomposition</div>
<ol class="arc-tree">
${childRows}
</ol>`
    : "";

  // Result line for closed epics
  let resultLine = "";
  if (epic.status === "closed") {
    const note = extractLatestNote(epicBody);
    const resultText = note ? truncate(note, 200) : "Completed";
    resultLine = `<div class="arc-result">${escapeHtml(resultText)}</div>`;
  }

  const body = `<div class="arc-body">
${originalAsk}
${renderedBody}
${tree}
${resultLine}
</div>`;

  return `<div class="arc-card" id="${cardId}" data-arc-kind="goal">
${header}
${body}
</div>`;
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
