/**
 * Dispatch log rows and dispatch detail (drill-in) view.
 */
export const DISPATCH_CSS = `
/* ---------- Dispatch log ---------- */

.dispatch-list { margin: 0; padding: 0; list-style: none; }
.dispatch-row {
  display: grid;
  grid-template-columns: 110px 90px 90px 1fr 110px;
  gap: 16px;
  padding: 8px 0;
  border-bottom: 1px solid var(--faint);
  align-items: baseline;
}
.dispatch-row .id,
.dispatch-row .status,
.dispatch-row .duration,
.dispatch-row .ticket {
  font-family: var(--mono);
  font-size: 12px;
}
.dispatch-row .status { letter-spacing: var(--smallcaps-tracking); text-transform: uppercase; }
.dispatch-row .goal {
  font-style: italic;
  color: var(--ink-soft);
  font-size: 14px;
  line-height: 1.45;
}
.dispatch-row .status.status-complete { color: var(--ink); font-weight: 800; }
.dispatch-row .status.status-review_ready { color: #8a5a00; font-weight: 800; }
.dispatch-row .status.status-partial  { color: var(--amber); }
.dispatch-row .status.status-failed,
.dispatch-row .status.status-crashed,
.dispatch-row .status.status-timed_out { color: var(--rust); }
.dispatch-row .status.status-running  { color: var(--amber); font-weight: 800; }

/* ---------- Dispatch drill-in fragment ---------- */

.dispatch-detail {
  margin-top: 30px;
}

.dispatch-detail-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  border-top: 1px solid var(--ink);
  border-bottom: 1px solid var(--faint);
  padding: 12px 0;
}

.dispatch-detail-head-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.dispatch-detail-eyebrow {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--amber);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}

.dispatch-detail-id {
  font-family: var(--mono);
  font-size: 18px;
  font-weight: 700;
  color: var(--ink);
  letter-spacing: 0.02em;
}

.dispatch-detail-status {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  font-weight: 700;
}
.dispatch-detail-status.status-shipped { color: var(--ink); }
.dispatch-detail-status.status-running { color: var(--amber); }
.dispatch-detail-status.status-partial { color: var(--amber); }
.dispatch-detail-status.status-failed  { color: var(--rust); }
.dispatch-detail-status.status-crashed { color: var(--rust); }

.dispatch-detail-ticket {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-soft);
  border-bottom: 1px solid var(--amber);
  padding-bottom: 1px;
}

.dispatch-detail-branch {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.branch-state {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  margin-left: 6px;
}
.branch-state.branch-alive  { color: var(--amber); font-weight: 700; }
.branch-state.branch-merged { color: var(--ink); }
.branch-state.branch-pruned { color: var(--muted); font-style: italic; }

/* Metadata strip — horizontal key-value pairs */
.dispatch-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 24px;
  padding: 10px 0;
  border-bottom: 1px solid var(--faint);
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-soft);
}

.meta-item {
  white-space: nowrap;
}

.meta-label {
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  margin-right: 6px;
}

/* Goal section — rendered markdown */
.dispatch-detail-goal {
  padding: 18px 0;
  border-bottom: 1px solid var(--faint);
  line-height: 1.55;
}

.dispatch-detail-section-head {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 700;
  margin: 0 0 10px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--ink);
}

.dispatch-detail-goal h1,
.dispatch-detail-goal h2,
.dispatch-detail-goal h3 {
  font-weight: 700;
  margin: 14px 0 6px;
  line-height: 1.25;
}
.dispatch-detail-goal h1 { font-size: 20px; }
.dispatch-detail-goal h2 { font-size: 16px; }
.dispatch-detail-goal h3 { font-size: 14px; }
.dispatch-detail-goal p { margin: 0 0 10px; }
.dispatch-detail-goal ul,
.dispatch-detail-goal ol {
  margin: 4px 0 12px;
  padding-left: 22px;
}
.dispatch-detail-goal li { margin: 2px 0; }
.dispatch-detail-goal code {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--rust);
}
.dispatch-detail-goal pre {
  font-family: var(--mono);
  font-size: 12px;
  border-left: 2px solid var(--amber);
  padding: 8px 12px;
  margin: 8px 0;
  white-space: pre-wrap;
  background: rgba(26, 26, 26, 0.03);
}

.dispatch-detail-goal input[type="checkbox"] {
  margin-right: 4px;
  accent-color: var(--amber);
}

/* Output log — scrollable monospace block */
.dispatch-detail-log {
  padding: 18px 0;
}

.log-tail {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.5;
  background: rgba(26, 26, 26, 0.03);
  border: 1px solid var(--faint);
  border-left: 2px solid var(--ink);
  padding: 12px 14px;
  max-height: 600px;
  overflow-y: auto;
  overflow-x: auto;
  white-space: pre;
  margin: 0;
  color: var(--ink-soft);
}

.log-tail code {
  font-family: inherit;
  font-size: inherit;
  background: transparent;
  padding: 0;
}

.log-tail .empty-state {
  color: var(--muted);
  font-style: italic;
}

.dispatch-detail-goal .empty-state {
  color: var(--muted);
  font-style: italic;
}

@media (max-width: 760px) {
  .dispatch-detail-head {
    flex-direction: column;
    gap: 6px;
  }
  .dispatch-detail-meta {
    flex-direction: column;
    gap: 4px;
  }
  .log-tail {
    max-height: 400px;
    font-size: 10.5px;
  }
}
`;
