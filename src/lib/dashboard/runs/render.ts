/**
 * Runs page renderer — turns collectRuns() output into a broadsheet HTML page.
 *
 * Three sections:
 *   1. Active runs panel (top) — one row per running dispatch/campaign
 *   2. Terminal timeline (below) — completed runs newest-first
 *   3. Direct dispatches (bottom) — orphan runs not claimed by any arc
 *
 * Pure function: no I/O, no async, no DOM.
 */

import { marked } from "marked";

import type { CollectedRuns, RunRow, RunRowStatus, DirectArc, GoalArc, CampaignArc, CampaignIteration, ArcStatus, Arc } from "./collect";
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

/**
 * Render markdown → HTML, safe from injection.
 *
 * Escape HTML entities first so raw `<script>` / `<img onerror>` etc. are
 * neutralized, then parse the escaped source as markdown. Markdown syntax
 * characters (`#`, `*`, `` ` ``, `[`, `]`, etc.) are unaffected by the
 * escape pass. The only thing lost is inline HTML in markdown (e.g.
 * `<em>italic</em>`) — which is the desired tradeoff for a dashboard
 * rendering user-supplied goals.
 */
function md(source: string): string {
  if (!source || !source.trim()) return "";
  const safe = escapeHtml(source);
  return marked.parse(safe, { async: false, breaks: false, gfm: true }) as string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut) + "…";
}

function formatStartTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${months[d.getMonth()]} ${d.getDate()}, ${h12}:${m}${ampm}`;
}

// ---------------------------------------------------------------------------
// Why-failed block
// ---------------------------------------------------------------------------

/**
 * Render a "WHY FAILED" block for failed/crashed arcs.
 * One-line truncated by default, click-to-expand reveals full multiline log tail.
 *
 * @param reason - The failure reason text (multiline ok)
 * @returns HTML string, or empty string if reason is falsy
 */
export function renderWhyFailed(reason: string | null | undefined): string {
  if (!reason) return "";
  return `<div class="why-failed" data-why-failed>
  <div class="why-failed-label">Why Failed <span class="why-failed-toggle">click to expand</span></div>
  <div class="why-failed-body">${escapeHtml(reason)}</div>
</div>`;
}

/**
 * Render an inline failure reason for decomposition tree rows and direct dispatches.
 * Single line, click to expand.
 */
export function renderWhyFailedInline(reason: string | null | undefined): string {
  if (!reason) return "";
  // Take just the last meaningful line for the inline view
  const lines = reason.split("\n").filter((l) => l.trim());
  const lastMeaningfulLine = lines[lines.length - 1] ?? reason;
  return `<span class="why-failed-inline" data-why-failed-inline title="${escapeHtml(reason)}">${escapeHtml(lastMeaningfulLine)}</span>`;
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
// Direct dispatches section
// ---------------------------------------------------------------------------

/**
 * Render the "Direct dispatches" section — orphan runs not claimed by any
 * goal arc or campaign. Visually quieter than arc cards: smaller heading,
 * tighter rows, compact table layout.
 *
 * Returns empty string when there are no direct dispatches (section hidden).
 * Sorted by start time descending within the section.
 */
export function renderDirectDispatches(directs: DirectArc[]): string {
  if (directs.length === 0) return "";

  // Sort by start time descending (newest first)
  const sorted = [...directs].sort(
    (a, b) =>
      new Date(b.run.startedAt).getTime() - new Date(a.run.startedAt).getTime(),
  );

  const rows = sorted
    .map((d) => {
      const { run } = d;
      const badgeClass = statusBadgeClass(run.status);
      const ticketCell = run.ticketId
        ? `<a href="/tickets#${escapeHtml(run.ticketId)}" class="mono">${escapeHtml(run.ticketId)}</a>`
        : `<span class="direct-muted">—</span>`;
      const title = escapeHtml(truncate(run.goalSummary, 100));

      const chipKind =
        run.status === "shipped" ? "shipped" :
        run.status === "running" ? "running" :
        "failed";

      const failureCell = run.failureReason
        ? `<td class="direct-failure">${renderWhyFailedInline(run.failureReason)}</td>`
        : `<td></td>`;

      return `<tr class="direct-row">
  <td><a href="/runs/${escapeHtml(run.id)}" class="direct-id mono">${escapeHtml(run.id)}</a></td>
  <td>${ticketCell}</td>
  <td class="direct-title">${title}</td>
  <td><span class="arc-chip chip-${chipKind}">${escapeHtml(run.status)}</span></td>
  <td class="mono direct-elapsed">${escapeHtml(formatElapsed(run.elapsedSec))}</td>
  <td class="mono direct-time">${escapeHtml(formatStartTime(run.startedAt))}</td>
  ${failureCell}
</tr>`;
    })
    .join("\n");

  return `
<section class="direct-section" id="section-direct-dispatches">
  <div class="direct-section-head">Direct dispatches</div>
  <table class="direct-table">
    <thead>
      <tr>
        <th>Run</th>
        <th>Ticket</th>
        <th>Title</th>
        <th>Status</th>
        <th>Elapsed</th>
        <th>Started</th>
        <th>Reason</th>
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
<div class="arc-prose">${md(firstPara)}</div>`
    : "";

  // Rendered markdown for the rest of the body (minus notes)
  const bodyWithoutNotes = restBody
    .split("\n")
    .filter((l) => !/^###\s+\d{4}-\d{2}-\d{2}T/.test(l))
    .join("\n")
    .trim();
  const renderedBody = bodyWithoutNotes
    ? `<div class="arc-prose">${md(bodyWithoutNotes)}</div>`
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

    // Elapsed: not available from ticket data, show em-dash
    const elapsedCell = "—";

    // Cost: dispatches don't track cost yet
    const costCell = "—";

    // Inline failure reason for failed/crashed child runs
    const failedRun = runs.find((r) => r.status === "failed" || r.status === "crashed");
    const failureInline = failedRun?.failureReason
      ? renderWhyFailedInline(failedRun.failureReason)
      : "";

    return `<li class="arc-child">
  <span class="arc-child-id"><a href="/tickets#${escapeHtml(ticket.id)}" class="mono">${escapeHtml(ticket.id)}</a></span>
  <span class="arc-child-title">${escapeHtml(ticket.title)}</span>
  <span class="arc-child-run">${runCell}</span>
  <span class="arc-child-status ${statusClass}">${escapeHtml(statusLabel)}</span>
  <span class="arc-child-elapsed">${escapeHtml(elapsedCell)}</span>
  <span class="arc-child-cost">${escapeHtml(costCell)}</span>
  ${failureInline ? `<span class="arc-child-failure">${failureInline}</span>` : ""}
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
// Campaign arc card renderer
// ---------------------------------------------------------------------------

function arcStatusChipClass(status: ArcStatus): string {
  switch (status) {
    case "shipped":   return "chip-shipped";
    case "in-flight": return "chip-in-flight";
    case "blocked":   return "chip-failed";
    case "mixed":     return "chip-mixed";
    default:          return "chip-unknown";
  }
}

function arcStatusLabel(status: ArcStatus): string {
  switch (status) {
    case "shipped":   return "shipped";
    case "in-flight": return "running";
    case "blocked":   return "failed";
    case "mixed":     return "mixed";
    default:          return status;
  }
}

function judgeDecisionClass(decision: string): string {
  const d = decision.toLowerCase();
  if (d === "done" || d === "accept" || d === "continue" || d === "replan") return "judge-accept";
  if (d === "reject" || d === "abort") return "judge-reject";
  return "";
}

function renderIterationTable(iterations: CampaignIteration[]): string {
  if (iterations.length === 0) return "";

  const rows = iterations.map((it) => {
    const decisionCls = judgeDecisionClass(it.judgeDecision);
    return `<tr>
  <td class="num">${it.iterationN}</td>
  <td>${escapeHtml(it.exitReason)}</td>
  <td class="${decisionCls}">${escapeHtml(it.judgeDecision)}</td>
  <td class="num">$${it.cost.toFixed(2)}</td>
  <td class="num">${escapeHtml(formatElapsed(it.elapsedSec))}</td>
</tr>`;
  }).join("\n");

  return `<div class="arc-section-label">Iterations</div>
<table class="arc-iterations">
  <thead>
    <tr>
      <th class="num">#</th>
      <th>Exit Reason</th>
      <th>Judge</th>
      <th class="num">Cost</th>
      <th class="num">Elapsed</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function renderFrozenPrefixBlock(prefix: string | null): string {
  if (!prefix) return "";
  return `<div class="arc-section-label frozen-prefix-label">Frozen prefix (cache-stable)</div>
<pre class="arc-frozen-prefix">${escapeHtml(prefix)}</pre>`;
}

function renderFinalArtifact(artifact: string | null): string {
  if (!artifact) return "";
  return `<div class="arc-section-label">Final Artifact</div>
<div class="arc-prose"><code>${escapeHtml(artifact)}</code></div>`;
}

/**
 * Render a campaign arc card (header + expandable body).
 * Uses `.arc-card` / `.arc-header` / `.arc-body` pattern from TK-095 styles.
 */
export function renderCampaignArc(arc: CampaignArc): string {
  const { campaign, iterations, totalCost, iterationCount, status, goal, frozenPrefix, finalArtifact } = arc;

  // Header: id + goal summary (first ~80 chars) + status chip + cost + iter count
  const goalSummary = truncate(campaign.goalSummary, 80);
  const chipClass = arcStatusChipClass(status);
  const chipLabel = arcStatusLabel(status);
  const costStr = formatCost(totalCost || undefined);

  const header = `<div class="arc-header" role="button" tabindex="0" aria-expanded="false">
  <span class="arc-expand">+</span>
  <span class="arc-title"><span class="mono">${escapeHtml(campaign.id)}</span> ${escapeHtml(goalSummary)}</span>
  <span class="arc-chip ${chipClass}">${escapeHtml(chipLabel)}</span>
  <span class="arc-meta">${escapeHtml(costStr)}</span>
  <span class="arc-meta">${iterationCount} iter${iterationCount !== 1 ? "s" : ""}</span>
</div>`;

  // Why-failed block for failed/crashed campaigns (at top of body)
  const whyFailedBlock = renderWhyFailed(arc.failureReason);

  // Body: why-failed + full goal + frozen prefix + iteration table + final artifact
  const goalBlock = goal
    ? `<div class="arc-section-label">Goal</div>\n<div class="arc-prose">${md(goal)}</div>`
    : "";

  const body = `<div class="arc-body">
  ${whyFailedBlock}
  ${goalBlock}
  ${renderFrozenPrefixBlock(frozenPrefix)}
  ${renderIterationTable(iterations)}
  ${renderFinalArtifact(finalArtifact)}
</div>`;

  return `<div class="arc-card" data-arc-id="${escapeHtml(campaign.id)}">
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
 * Render a complete HTML document for the /runs page (legacy flat list).
 */
export function renderRunsPageDocument(
  data: CollectedRuns,
  opts: RunsPageRenderOptions = {},
): string {
  return renderFullDocument(renderRunsPage(data), opts);
}

// ---------------------------------------------------------------------------
// Arc-first /runs page — day grouping + active bubbling
// ---------------------------------------------------------------------------

/**
 * Extract the start date (ISO YYYY-MM-DD) from an arc for day grouping.
 */
function arcStartDate(arc: Arc): string {
  switch (arc.kind) {
    case "goal":
      return arc.epic.created.slice(0, 10);
    case "campaign":
      return arc.campaign.startedAt.slice(0, 10);
    case "direct":
      return arc.run.startedAt.slice(0, 10);
  }
}

/**
 * Extract the start ISO timestamp for sorting within a day.
 */
function arcStartTime(arc: Arc): string {
  switch (arc.kind) {
    case "goal":
      return arc.epic.created;
    case "campaign":
      return arc.campaign.startedAt;
    case "direct":
      return arc.run.startedAt;
  }
}

/**
 * Determine if an arc is "active" (any run in flight).
 */
function isArcActive(arc: Arc): boolean {
  switch (arc.kind) {
    case "goal":
      return arc.status === "in-flight";
    case "campaign":
      return arc.status === "in-flight";
    case "direct":
      return arc.run.status === "running";
  }
}

/**
 * Render a single arc card (dispatches to the appropriate renderer).
 */
function renderArcCard(arc: GoalArc | CampaignArc): string {
  return arc.kind === "goal" ? renderGoalArc(arc) : renderCampaignArc(arc);
}

/**
 * Render the arc-first /runs page body.
 *
 * Layout:
 *   - Goal + campaign arcs grouped by day (date of first activity), newest first
 *   - Within each day: active arcs bubble to top, then sorted by start time desc
 *   - Direct dispatches as a single section below all arc-day groups
 */
export function renderArcRunsPage(arcs: Arc[]): string {
  // Separate directs from goal/campaign arcs
  const grouped: (GoalArc | CampaignArc)[] = [];
  const directs: DirectArc[] = [];

  for (const arc of arcs) {
    if (arc.kind === "direct") {
      directs.push(arc);
    } else {
      grouped.push(arc);
    }
  }

  // Group by day
  const dayMap = new Map<string, (GoalArc | CampaignArc)[]>();
  for (const arc of grouped) {
    const day = arcStartDate(arc);
    const list = dayMap.get(day);
    if (list) {
      list.push(arc);
    } else {
      dayMap.set(day, [arc]);
    }
  }

  // Sort days newest-first
  const sortedDays = [...dayMap.keys()].sort((a, b) => b.localeCompare(a));

  // Render each day group
  const dayGroups = sortedDays.map((day) => {
    const dayArcs = dayMap.get(day)!;

    // Within a day: active first, then by start time desc
    dayArcs.sort((a, b) => {
      const aActive = isArcActive(a) ? 0 : 1;
      const bActive = isArcActive(b) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      // Both same activity status — newest first
      return new Date(arcStartTime(b)).getTime() - new Date(arcStartTime(a)).getTime();
    });

    const cards = dayArcs.map(renderArcCard).join("\n");

    return `<div class="day-group">
  <h3 class="day-heading">${escapeHtml(longDate(day))}</h3>
${cards}
</div>`;
  });

  const dayGroupsHtml = dayGroups.length > 0
    ? dayGroups.join("\n")
    : `<div class="runs-empty">No arcs to display.</div>`;

  const directsHtml = renderDirectDispatches(directs);

  return `${dayGroupsHtml}\n${directsHtml}`;
}

/**
 * Render a complete HTML document for the arc-first /runs page.
 */
export function renderArcRunsPageDocument(
  arcs: Arc[],
  opts: RunsPageRenderOptions = {},
): string {
  return renderFullDocument(renderArcRunsPage(arcs), opts);
}

// ---------------------------------------------------------------------------
// Shared document shell
// ---------------------------------------------------------------------------

function renderFullDocument(bodyContent: string, opts: RunsPageRenderOptions = {}): string {
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
    ["TASTE", "/taste"],
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
  ${bodyContent}
</div>
${scriptBlock}
</body>
</html>`;
}
