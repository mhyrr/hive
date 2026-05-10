/**
 * Campaign drill-in fragment renderer.
 *
 * Pure renderer: CampaignFragmentData -> HTML string.
 * No I/O. The collector reads campaign state from disk; this module
 * transforms that state into a broadsheet-styled HTML fragment.
 *
 * Surfaces: campaign goal, scorecard table, per-iteration blocks
 * (collapsible), frozen prefix, and plan diffs across iterations.
 */

import type { ScorecardRow } from "../../campaign/state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IterationBlock = {
  n: number;
  startedAt: string;
  endedAt: string;
  status: "shipped" | "partial" | "failed" | "running";
  /** The executor's goal/task for this iteration. */
  executorGoal: string;
  /** The judge's verdict (from scorecard). */
  judgeVerdict: string | null;
  /** The judge's decision field. */
  judgeDecision: string | null;
  /** Progress fraction 0.0-1.0 from the judge. */
  progress: number | null;
  /** Confidence 1-5 from the judge. */
  confidence: number | null;
  /** Plan text at the END of this iteration (after any replan). */
  planSnapshot: string | null;
};

export type ScorecardCriterion = {
  name: string;
  /** Per-iteration values — index matches iteration_n (1-based, so index 0 = iter 1). */
  values: Array<{ score: number | null; label: string } | null>;
};

export type CampaignFragmentData = {
  id: string;
  goal: string;
  status: string;
  frozenPrefix: string | null;
  iterations: IterationBlock[];
  scorecard: ScorecardRow[];
  /** Plan at campaign start (before any iterations). */
  initialPlan: string | null;
  /** Plan diffs: each entry is a unified-diff-style string showing what changed. */
  planDiffs: Array<{ fromIter: number; toIter: number; diff: string }>;
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

function shortTimestamp(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${months[d.getMonth()]} ${d.getDate()} ${h}:${m}`;
}

function statusBadge(status: string): string {
  const cls = `status-badge status-${status}`;
  return `<span class="${cls}">${escapeHtml(status)}</span>`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * Compute a minimal unified diff between two text blocks.
 * Lines prefixed with `+` (added) or `-` (removed). Context lines unmarked.
 */
export function computeSimpleDiff(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  // Simple LCS-based diff (sufficient for short plans)
  const lcs = lcsLines(oldLines, newLines);
  const result: string[] = [];

  let oi = 0;
  let ni = 0;
  for (const common of lcs) {
    // Emit removals (lines in old before this common line)
    while (oi < oldLines.length && oldLines[oi] !== common) {
      result.push(`- ${oldLines[oi]}`);
      oi++;
    }
    // Emit additions (lines in new before this common line)
    while (ni < newLines.length && newLines[ni] !== common) {
      result.push(`+ ${newLines[ni]}`);
      ni++;
    }
    // Emit common line (context)
    result.push(`  ${common}`);
    oi++;
    ni++;
  }
  // Remaining lines
  while (oi < oldLines.length) {
    result.push(`- ${oldLines[oi]}`);
    oi++;
  }
  while (ni < newLines.length) {
    result.push(`+ ${newLines[ni]}`);
    ni++;
  }

  return result.join("\n");
}

/** Compute LCS of two string arrays. */
function lcsLines(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  // For very long inputs, skip the expensive LCS and just show full replacement
  if (m * n > 100_000) {
    return [];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack
  const result: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]!);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderGoalSection(data: CampaignFragmentData): string {
  return `
<section class="campaign-section campaign-goal">
  <div class="campaign-head">
    <span class="campaign-id mono">${escapeHtml(data.id)}</span>
    ${statusBadge(data.status)}
  </div>
  <h3 class="campaign-goal-text">${escapeHtml(data.goal || "(no goal text)")}</h3>
</section>`;
}

function renderScorecardTable(data: CampaignFragmentData): string {
  if (data.scorecard.length === 0) {
    return `
<section class="campaign-section campaign-scorecard">
  <h4 class="section-label">Scorecard</h4>
  <p class="empty-state">No iterations scored yet.</p>
</section>`;
  }

  // Build table: rows are criteria, columns are iterations
  const criteria = ["decision", "progress", "confidence", "cost", "tokens", "exit_reason"];
  const criteriaLabels: Record<string, string> = {
    decision: "Decision",
    progress: "Progress",
    confidence: "Confidence",
    cost: "Cost",
    tokens: "Tokens",
    exit_reason: "Exit",
  };

  const headerCells = data.scorecard
    .map((row) => `<th class="iter-col">Iter ${row.iteration_n}</th>`)
    .join("");

  const bodyRows = criteria.map((criterion) => {
    const cells = data.scorecard
      .map((row) => {
        let value: string;
        switch (criterion) {
          case "decision":
            value = row.judge_decision ?? "—";
            break;
          case "progress": {
            // Find matching iteration block for progress data
            const iter = data.iterations.find((i) => i.n === row.iteration_n);
            value = iter?.progress != null ? `${Math.round(iter.progress * 100)}%` : "—";
            break;
          }
          case "confidence": {
            const iter2 = data.iterations.find((i) => i.n === row.iteration_n);
            value = iter2?.confidence != null ? `${iter2.confidence}/5` : "—";
            break;
          }
          case "cost":
            value = row.cost_usd != null ? formatCost(row.cost_usd) : "—";
            break;
          case "tokens":
            value = row.tokens_used != null ? formatTokens(row.tokens_used) : "—";
            break;
          case "exit_reason":
            value = row.exit_reason ?? "—";
            break;
          default:
            value = "—";
        }
        return `<td>${escapeHtml(value)}</td>`;
      })
      .join("");

    return `<tr><td class="criterion-label">${escapeHtml(criteriaLabels[criterion] ?? criterion)}</td>${cells}</tr>`;
  });

  return `
<section class="campaign-section campaign-scorecard">
  <h4 class="section-label">Scorecard</h4>
  <table class="scorecard-table">
    <thead>
      <tr><th class="criterion-label"></th>${headerCells}</tr>
    </thead>
    <tbody>
      ${bodyRows.join("\n      ")}
    </tbody>
  </table>
</section>`;
}

function renderIterationBlocks(data: CampaignFragmentData): string {
  if (data.iterations.length === 0) {
    return `
<section class="campaign-section campaign-iterations">
  <h4 class="section-label">Iterations</h4>
  <p class="empty-state">No iterations yet — campaign just started.</p>
</section>`;
  }

  const blocks = data.iterations.map((iter) => {
    const verdict = iter.judgeVerdict
      ? `<div class="iter-verdict"><span class="verdict-label">Judge:</span> ${escapeHtml(iter.judgeVerdict)}</div>`
      : "";
    const decision = iter.judgeDecision
      ? `<span class="iter-decision">${escapeHtml(iter.judgeDecision)}</span>`
      : "";

    return `<details class="iter-block">
  <summary class="iter-summary">
    <span class="iter-number">Iteration ${iter.n}</span>
    <span class="iter-date">${escapeHtml(shortTimestamp(iter.startedAt))}</span>
    ${statusBadge(iter.status)}
    ${decision}
  </summary>
  <div class="iter-body">
    <div class="iter-goal"><span class="field-label">Goal:</span> ${escapeHtml(iter.executorGoal || "(none)")}</div>
    ${verdict}
  </div>
</details>`;
  });

  return `
<section class="campaign-section campaign-iterations">
  <h4 class="section-label">Iterations</h4>
  ${blocks.join("\n  ")}
</section>`;
}

function renderFrozenPrefix(data: CampaignFragmentData): string {
  if (!data.frozenPrefix) {
    return "";
  }

  return `
<section class="campaign-section campaign-frozen-prefix">
  <h4 class="section-label frozen-prefix-label">Frozen Prefix</h4>
  <span class="frozen-prefix-subtitle">(cache-stable across iterations)</span>
  <pre class="frozen-prefix-content">${escapeHtml(data.frozenPrefix)}</pre>
</section>`;
}

function renderPlanDiffs(data: CampaignFragmentData): string {
  if (data.planDiffs.length === 0 && !data.initialPlan) {
    return "";
  }

  // If there's only an initial plan with no diffs, show it as-is
  if (data.planDiffs.length === 0 && data.initialPlan) {
    return `
<section class="campaign-section campaign-plan-diffs">
  <h4 class="section-label">Plan</h4>
  <pre class="plan-content">${escapeHtml(data.initialPlan)}</pre>
</section>`;
  }

  const diffBlocks = data.planDiffs.map((d) => {
    const lines = d.diff.split("\n").map((line) => {
      if (line.startsWith("+ ")) {
        return `<span class="diff-add">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith("- ")) {
        return `<span class="diff-del">${escapeHtml(line)}</span>`;
      }
      return `<span class="diff-ctx">${escapeHtml(line)}</span>`;
    });

    return `<div class="plan-diff-block">
  <div class="diff-header">Iter ${d.fromIter} → Iter ${d.toIter}</div>
  <pre class="diff-content">${lines.join("\n")}</pre>
</div>`;
  });

  return `
<section class="campaign-section campaign-plan-diffs">
  <h4 class="section-label">Plan Changes</h4>
  ${diffBlocks.join("\n  ")}
</section>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a campaign drill-in fragment as an HTML string.
 * Pure function: given CampaignFragmentData, returns HTML.
 */
export function renderCampaignFragment(data: CampaignFragmentData): string {
  return `<article class="campaign-fragment" data-campaign-id="${escapeHtml(data.id)}">
  ${renderGoalSection(data)}
  ${renderScorecardTable(data)}
  ${renderIterationBlocks(data)}
  ${renderFrozenPrefix(data)}
  ${renderPlanDiffs(data)}
</article>`;
}
