/**
 * Dispatch drill-in fragment renderer.
 *
 * Pure function: DispatchDetail → HTML string. No I/O.
 *
 * Shows the full goal text (with markdown rendering), worktree branch
 * state, output.log tail (~80 lines, scrollable), ticket link, and a
 * metadata strip (started/ended/elapsed/cost/exit-status).
 *
 * Uses the same broadsheet palette + type stack as the rest of the
 * dashboard (styles.ts).
 */

import { marked } from "marked";

import type { RunRowStatus } from "./runs/collect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorktreeState = "alive" | "merged" | "pruned";

export type DispatchDetail = {
  id: string; // RUN-NNN
  status: RunRowStatus;
  startedAt: string; // ISO
  endedAt?: string;
  elapsedSec: number;
  costUsd?: number;
  ticketId?: string;
  goalFull: string; // full goal markdown
  worktreeBranch?: string;
  worktreeState?: WorktreeState;
  logTail: string; // last ~80 lines of output.log
  logAvailable: boolean; // false when log is missing or 0-byte
  runDir: string; // absolute path for the fallback message
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

function md(source: string): string {
  if (!source || !source.trim()) return "";
  return marked.parse(source, { async: false, breaks: false, gfm: true }) as string;
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hh}:${mm}`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

const STATUS_LABELS: Record<RunRowStatus, string> = {
  running: "Running",
  shipped: "Shipped",
  partial: "Partial",
  failed: "Failed",
  crashed: "Crashed",
};

const STATUS_CLASSES: Record<RunRowStatus, string> = {
  running: "status-running",
  shipped: "status-shipped",
  partial: "status-partial",
  failed: "status-failed",
  crashed: "status-crashed",
};

const WORKTREE_LABELS: Record<WorktreeState, string> = {
  alive: "alive",
  merged: "merged",
  pruned: "pruned",
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render a dispatch drill-in fragment as an HTML string.
 *
 * Designed to be embedded in the /runs/:id page or swapped in via
 * fragment fetch. Self-contained section, no wrapping <html> needed.
 */
export function renderDispatchFragment(run: DispatchDetail): string {
  return [
    renderHeader(run),
    renderMetadataStrip(run),
    renderGoal(run),
    renderLogTail(run),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Sub-renderers
// ---------------------------------------------------------------------------

function renderHeader(run: DispatchDetail): string {
  const statusLabel = STATUS_LABELS[run.status] ?? run.status;
  const statusClass = STATUS_CLASSES[run.status] ?? "";
  const ticketLink = run.ticketId
    ? ` <a href="/tickets#${escapeHtml(run.ticketId)}" class="dispatch-detail-ticket">${escapeHtml(run.ticketId)}</a>`
    : "";

  const branchBlock = run.worktreeBranch
    ? renderBranchBadge(run.worktreeBranch, run.worktreeState)
    : "";

  return `
<section class="dispatch-detail" data-run-id="${escapeHtml(run.id)}">
  <div class="dispatch-detail-head">
    <div class="dispatch-detail-head-left">
      <span class="dispatch-detail-eyebrow">Dispatch</span>
      <span class="dispatch-detail-id mono">${escapeHtml(run.id)}</span>
      <span class="dispatch-detail-status ${statusClass}">${escapeHtml(statusLabel)}</span>
      ${ticketLink}
    </div>
    <div class="dispatch-detail-head-right">
      ${branchBlock}
    </div>
  </div>`;
}

function renderBranchBadge(
  branch: string,
  state?: WorktreeState,
): string {
  const stateLabel = state ? WORKTREE_LABELS[state] : "";
  const stateClass = state ? `branch-${state}` : "";
  const stateTag = stateLabel
    ? ` <span class="branch-state ${stateClass}">${escapeHtml(stateLabel)}</span>`
    : "";
  return `<span class="dispatch-detail-branch mono">${escapeHtml(branch)}${stateTag}</span>`;
}

function renderMetadataStrip(run: DispatchDetail): string {
  const items: string[] = [];

  items.push(`<span class="meta-item"><span class="meta-label">started</span>${escapeHtml(formatTimestamp(run.startedAt))}</span>`);

  if (run.endedAt) {
    items.push(`<span class="meta-item"><span class="meta-label">ended</span>${escapeHtml(formatTimestamp(run.endedAt))}</span>`);
  }

  items.push(`<span class="meta-item"><span class="meta-label">elapsed</span>${escapeHtml(formatElapsed(run.elapsedSec))}</span>`);

  if (run.costUsd !== undefined) {
    items.push(`<span class="meta-item"><span class="meta-label">cost</span>${escapeHtml(formatCost(run.costUsd))}</span>`);
  }

  const statusLabel = STATUS_LABELS[run.status] ?? run.status;
  items.push(`<span class="meta-item"><span class="meta-label">status</span>${escapeHtml(statusLabel)}</span>`);

  return `  <div class="dispatch-detail-meta">${items.join("")}</div>`;
}

function renderGoal(run: DispatchDetail): string {
  if (!run.goalFull || !run.goalFull.trim()) {
    return `  <div class="dispatch-detail-goal"><p class="empty-state">(no goal text)</p></div>`;
  }

  return `  <div class="dispatch-detail-goal">
    <h3 class="dispatch-detail-section-head">Goal</h3>
    ${md(run.goalFull)}
  </div>`;
}

function renderLogTail(run: DispatchDetail): string {
  if (!run.logAvailable) {
    const hint = run.runDir
      ? `(no output captured — see ${run.runDir}/output.log)`
      : "(no output captured)";
    return `  <div class="dispatch-detail-log">
    <h3 class="dispatch-detail-section-head">Output</h3>
    <pre class="log-tail"><code class="empty-state">${escapeHtml(hint)}</code></pre>
  </div>
</section>`;
  }

  return `  <div class="dispatch-detail-log">
    <h3 class="dispatch-detail-section-head">Output</h3>
    <pre class="log-tail"><code>${escapeHtml(run.logTail)}</code></pre>
  </div>
</section>`;
}
