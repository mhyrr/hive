/**
 * Runs page: active runs, terminal timeline table, run status chips.
 */
export const RUNS_CSS = `
/* ---------- Runs page ---------- */

.runs-empty {
  text-align: center;
  font-style: italic;
  color: var(--muted);
  padding: 48px 0;
  border-top: 1px dashed var(--faint);
  border-bottom: 1px dashed var(--faint);
}

.runs-muted { color: var(--muted); }

/* Active runs: stacked rows */
.active-runs {
  border-top: 1px solid var(--ink);
}

.active-run-row {
  display: grid;
  grid-template-columns: 110px 80px 80px 90px 1fr;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--faint);
  align-items: baseline;
  font-size: 14px;
}
.active-run-row:last-child { border-bottom: 1px solid var(--ink); }

.run-id {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-soft);
  border-bottom: 1px solid var(--amber);
  padding-bottom: 1px;
}
.run-id:hover { color: var(--rust); }

.run-kind {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--amber);
}

.run-elapsed {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-soft);
}

.run-log {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* Terminal timeline: financial-pages table */
.runs-timeline {
  width: 100%;
  border-collapse: collapse;
  font-feature-settings: "tnum" 1;
  font-size: 14px;
}
.runs-timeline th {
  text-align: left;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--ink);
  padding: 5px 8px;
  font-weight: 700;
}
.runs-timeline th.num {
  text-align: right;
}
.runs-timeline td {
  border-bottom: 1px solid var(--faint);
  padding: 7px 8px;
  vertical-align: top;
}
.runs-timeline td.num {
  text-align: right;
  font-family: var(--mono);
  font-size: 13px;
  font-feature-settings: "tnum" 1;
}

.run-status {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.run-status-shipped { color: var(--ink); font-weight: 800; }
.run-status-review { color: #8a5a00; font-weight: 800; }
.run-status-failed  { color: var(--rust); }
.run-status-running { color: var(--amber); font-weight: 800; }

.run-goal {
  font-style: italic;
  color: var(--ink-soft);
  font-size: 13.5px;
  line-height: 1.45;
}

.timeline-row:hover { background: rgba(196, 123, 28, 0.04); }

@media (max-width: 900px) {
  .active-run-row {
    grid-template-columns: 1fr 1fr;
    gap: 6px 12px;
  }
  .active-run-row .run-log {
    grid-column: 1 / -1;
  }
  .runs-timeline { font-size: 13px; }
}
`;
