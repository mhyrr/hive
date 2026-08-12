// /watches — the watch fleet review page (TK-138).
//
// Renders what `hive watch status` knows, plus recent surfaced artifacts.
// Scope boundary: this is the WATCH fleet, not a run monitor — dispatch-run
// monitoring stays TK-030.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { type HivePaths } from "../paths";
import { now as hiveNow } from "../time";
import {
  discoverWatches,
  formatCadence,
  type WatchAutonomy,
  type WatchDef,
} from "../watch";
import { freshEntry, loadWatchState, usageSince } from "../watch-state";
import { clampAutonomy, readAutonomyCeiling } from "../watch-run";
import { DASHBOARD_CSS } from "./styles";

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

export type WatchRow = {
  qualifiedName: string;
  enabled: boolean;
  cadence: string;
  autonomy: WatchAutonomy;
  effectiveAutonomy: WatchAutonomy;
  tier: string;
  venue: string;
  project: string | null;
  lastRun: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  calls7d: number;
  tokens7d: number;
};

export type SurfacedArtifact = {
  watch: string;
  date: string;
  path: string;
};

export type WatchesPageData = {
  generatedAt: string;
  ceiling: WatchAutonomy;
  /** Last hourly tick, or null if the launchd job has never run. */
  lastTick: string | null;
  tickStale: boolean;
  rows: WatchRow[];
  artifacts: SurfacedArtifact[];
  warnings: string[];
};

/** The tick is hourly; past this gap it reads as dead, not slow. */
const TICK_STALE_MS = 2 * 3_600_000;
const ARTIFACT_LOOKBACK_DAYS = 7;

export async function collectWatchesPage(paths: HivePaths): Promise<WatchesPageData> {
  const now = hiveNow();
  const { watches, warnings } = await discoverWatches(paths);
  const state = await loadWatchState(paths);
  const ceiling = readAutonomyCeiling(paths);

  const rows: WatchRow[] = watches.map((w: WatchDef) => {
    const entry = state.watches[w.qualifiedName] ?? freshEntry();
    const spend = usageSince(entry, now.getTime() - 7 * 86_400_000);
    return {
      qualifiedName: w.qualifiedName,
      enabled: w.enabled,
      cadence: formatCadence(w.cadence),
      autonomy: w.autonomy,
      effectiveAutonomy: clampAutonomy(clampAutonomy(w.autonomy, ceiling), "propose"),
      tier: w.model,
      venue: w.venue,
      project: w.project,
      lastRun: entry.lastRun,
      lastOutcome: entry.lastOutcome,
      lastError: entry.lastError,
      calls7d: spend.calls,
      tokens7d: spend.inputTokens + spend.outputTokens,
    };
  });

  // Briefing-venue artifacts from the recent run dirs (bets.md et al).
  const artifacts: SurfacedArtifact[] = [];
  const briefingWatchNames = watches.filter((w) => w.venue === "briefing").map((w) => w.name);
  if (briefingWatchNames.length > 0) {
    const entries = await readdir(paths.memoryRunsDir, { withFileTypes: true }).catch(() => []);
    const dates = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, ARTIFACT_LOOKBACK_DAYS);
    for (const date of dates) {
      for (const name of briefingWatchNames) {
        const path = join(paths.memoryRunsDir, date, `${name}.md`);
        if (existsSync(path)) artifacts.push({ watch: name, date, path });
      }
    }
  }

  const lastTick = state.lastTick ?? null;
  const tickMs = lastTick ? new Date(lastTick).getTime() : NaN;
  const tickStale = Number.isNaN(tickMs) || now.getTime() - tickMs > TICK_STALE_MS;

  return {
    generatedAt: now.toISOString(),
    ceiling,
    lastTick,
    tickStale,
    rows,
    artifacts,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const WATCHES_NAV: Array<[string, string]> = [
  ["BRIEFING", "/"],
  ["TICKETS", "/tickets"],
  ["RUNS", "/runs"],
  ["TASTE", "/taste"],
  ["WATCHES", "/watches"],
];

function outcomeLabel(row: WatchRow): string {
  if (!row.lastOutcome) return "—";
  const base = escapeHtml(row.lastOutcome);
  return row.lastError ? `${base} <span class="mono">(${escapeHtml(row.lastError.slice(0, 80))})</span>` : base;
}

function autonomyLabel(row: WatchRow): string {
  return row.effectiveAutonomy === row.autonomy
    ? escapeHtml(row.autonomy)
    : `${escapeHtml(row.autonomy)} → ${escapeHtml(row.effectiveAutonomy)}`;
}

export function renderWatchesPageDocument(data: WatchesPageData): string {
  const today = data.generatedAt.slice(0, 10);
  const nav = WATCHES_NAV.map(([label, href]) => {
    const active = href === "/watches" ? ' class="nav-active"' : "";
    return `<a href="${href}"${active}>${label}</a>`;
  }).join(' <span class="nav-sep">·</span> ');

  const liveness = data.lastTick
    ? data.tickStale
      ? `<strong>tick stale</strong> — last ran ${escapeHtml(data.lastTick)}; expected hourly. Check: launchctl list | grep com.hive.watches`
      : `tick alive — last ran ${escapeHtml(data.lastTick)}`
    : "tick has never run — install with hive init, then: launchctl load ~/Library/LaunchAgents/com.hive.watches.plist";

  const tableRows = data.rows
    .map(
      (r) => `<tr>
      <td class="mono">${escapeHtml(r.qualifiedName)}</td>
      <td>${r.enabled ? "on" : "off"}</td>
      <td class="mono">${escapeHtml(r.cadence)}</td>
      <td>${autonomyLabel(r)}</td>
      <td>${escapeHtml(r.tier)}</td>
      <td>${escapeHtml(r.venue)}</td>
      <td class="mono">${escapeHtml(r.lastRun ?? "never")}</td>
      <td>${outcomeLabel(r)}</td>
      <td class="mono">${r.calls7d} call(s) · ${r.tokens7d} tok</td>
    </tr>`,
    )
    .join("\n");

  const table =
    data.rows.length === 0
      ? `<p>No watches yet. Drop a markdown file in <code class="mono">~/.hive/watches/</code> — see docs/watches.md.</p>`
      : `<table class="ledger">
    <thead><tr><th>Watch</th><th>On</th><th>Cadence</th><th>Autonomy</th><th>Tier</th><th>Venue</th><th>Last tick</th><th>Outcome</th><th>7d logged</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>`;

  const artifactList =
    data.artifacts.length === 0
      ? ""
      : `<section class="section">
    <h2>Recent surfaced artifacts</h2>
    <hr class="amber"/>
    <ul>${data.artifacts
      .map((a) => `<li class="mono">${escapeHtml(a.date)} · ${escapeHtml(a.watch)} → ${escapeHtml(a.path)}</li>`)
      .join("\n")}</ul>
  </section>`;

  const warningsBlock =
    data.warnings.length === 0
      ? ""
      : `<section class="section">
    <h2>Parse warnings</h2>
    <hr class="amber"/>
    <ul>${data.warnings.map((w) => `<li class="mono">${escapeHtml(w)}</li>`).join("\n")}</ul>
  </section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>HIVE · Watches · ${escapeHtml(today)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="page page-wide">
  <nav class="page-nav">${nav}</nav>
  <header class="masthead">
    <h1>HIVE</h1>
    <div class="dateline">
      <span>Watches</span>
      <span class="sep">·</span>
      <span>${escapeHtml(today)}</span>
    </div>
  </header>
  <section class="section">
    <h2>Fleet</h2>
    <hr class="amber"/>
    <p>Autonomy ceiling: <strong>${escapeHtml(data.ceiling)}</strong> (watches.max_autonomy in ~/.hive/config.md) <span class="sep">·</span> ${liveness}</p>
    ${table}
  </section>
  ${artifactList}
  ${warningsBlock}
</div>
</body>
</html>`;
}
