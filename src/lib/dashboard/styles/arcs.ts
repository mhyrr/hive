/**
 * Arc cards (v3): goal / campaign / direct-dispatch renderers on /runs page.
 * Day grouping, decomposition tree, iteration table, frozen-prefix blocks,
 * direct dispatches section, why-failed blocks.
 */
export const ARCS_CSS = `
/* =====================================================================
   v3: Arc cards — shared styles for goal / campaign / direct-dispatch
   renderers on the /runs page.  Broadsheet palette, no shadows, no icons.
   ===================================================================== */

/* ---------- Page-wide variant (1680 max-width for arc pages) ---------- */

.page-wide {
  max-width: 1680px;
  margin: 0 auto;
  padding: 32px 36px 96px;
}

/* ---------- Day grouping ---------- */

.day-group {
  margin-top: 38px;
}
.day-group:first-child { margin-top: 0; }

.day-heading {
  font-family: var(--serif);
  font-size: 16px;
  font-weight: 700;
  color: var(--muted);
  letter-spacing: 0.01em;
  border-bottom: 1px solid var(--faint);
  padding-bottom: 4px;
  margin: 0 0 16px;
}

/* ---------- Arc card container ---------- */

.arc-card {
  background: var(--paper);
  border-top: 1px solid var(--amber);
  border-bottom: 1px solid var(--amber);
  border-radius: 0;
  box-shadow: none;
  margin-bottom: 12px;
}
.arc-card + .arc-card {
  /* Collapse adjacent amber borders into a single line */
  margin-top: -1px;
}

/* ---------- Arc header (clickable, always visible) ---------- */

.arc-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  transition: background-color 120ms ease;
}
.arc-header:hover {
  background: rgba(196, 123, 28, 0.06);
}

/* Expand/collapse glyph */
.arc-expand {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--muted);
  width: 12px;
  text-align: center;
  line-height: 1;
  transition: color 120ms ease;
}
.arc-header:hover .arc-expand {
  color: var(--amber);
}

/* Title — serif display */
.arc-title {
  font-family: var(--serif);
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Status chip — pill, 1px border, no fill */
.arc-chip {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  padding: 1px 8px;
  border-radius: 2px;
  border: 1px solid currentColor;
  background: transparent;
  white-space: nowrap;
  line-height: 1.6;
}
.chip-shipped   { color: var(--ink); }
.chip-complete  { color: var(--ink); }
.chip-in-flight { color: var(--amber); }
.chip-running   { color: var(--amber); }
.chip-blocked   { color: var(--rust); }
.chip-failed    { color: var(--rust); }
.chip-mixed     { color: var(--muted); }
.chip-unknown   { color: var(--muted); }

/* Tabular-nums metadata cells (cost, count, date) */
.arc-meta {
  font-family: var(--mono);
  font-size: 11px;
  font-feature-settings: "tnum" 1;
  color: var(--muted);
  white-space: nowrap;
}

/* ---------- Arc body (expandable) ---------- */

.arc-body {
  display: none;
  padding: 0 14px 14px 38px; /* 38px = 14px pad + 12px glyph + 12px gap */
  border-top: 1px solid var(--faint);
}
.arc-card.expanded .arc-body {
  display: block;
}

/* Section labels inside the body */
.arc-section-label {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  margin: 14px 0 6px;
}
.arc-section-label:first-child { margin-top: 10px; }

/* Prose blocks inside the body (original ask, campaign goal) */
.arc-prose {
  font-size: 14px;
  line-height: 1.55;
  color: var(--ink-soft);
  margin: 0 0 10px;
}
.arc-prose p { margin: 0 0 8px; }
.arc-prose p:last-child { margin-bottom: 0; }
.arc-prose code {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--rust);
}

/* ---------- Decomposition tree (goal arcs) ---------- */

.arc-tree {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.arc-child {
  display: grid;
  grid-template-columns: 72px 1fr 90px 80px 70px 70px;
  gap: 10px;
  align-items: baseline;
  padding: 5px 0;
  border-bottom: 1px solid var(--faint);
  font-size: 13px;
}
.arc-child:last-child { border-bottom: 0; }

.arc-child-id {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink-soft);
}
.arc-child-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arc-child-run {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}
.arc-child-status {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.arc-child-elapsed,
.arc-child-cost {
  font-family: var(--mono);
  font-size: 11px;
  font-feature-settings: "tnum" 1;
  text-align: right;
  color: var(--muted);
}
.arc-child-failure {
  grid-column: 2 / -1;
  padding-top: 2px;
}

/* ---------- Iteration table (campaign arcs) ---------- */

.arc-iterations {
  width: 100%;
  border-collapse: collapse;
  font-feature-settings: "tnum" 1;
  font-size: 13px;
  margin: 6px 0 0;
}
.arc-iterations th {
  text-align: left;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 700;
  border-bottom: 1px solid var(--ink);
  padding: 4px 6px;
}
.arc-iterations th.num { text-align: right; }
.arc-iterations td {
  border-bottom: 1px solid var(--faint);
  padding: 5px 6px;
  vertical-align: top;
}
.arc-iterations td.num {
  text-align: right;
  font-family: var(--mono);
  font-size: 11px;
}
.arc-iterations .judge-accept { color: var(--ink); }
.arc-iterations .judge-reject { color: var(--rust); }

/* Frozen-prefix block (campaign arcs) */
.arc-frozen-prefix {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  background: rgba(196, 123, 28, 0.06);
  padding: 10px 12px;
  margin: 6px 0 10px;
  white-space: pre-wrap;
  color: var(--ink-soft);
  border-left: 2px solid var(--amber);
}

/* ---------- Direct dispatches section ---------- */

.direct-section {
  margin-top: 44px;
}
.direct-section-head {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--ink);
  padding-bottom: 4px;
  margin-bottom: 14px;
  font-weight: 700;
}
.direct-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-feature-settings: "tnum" 1;
}
.direct-table th {
  text-align: left;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 700;
  border-bottom: 1px solid var(--faint);
  padding: 3px 6px;
}
.direct-table td {
  border-bottom: 1px solid var(--faint);
  padding: 4px 6px;
  vertical-align: baseline;
}
.direct-row:last-child td { border-bottom: 0; }
.direct-id { font-size: 11px; }
.direct-title {
  font-size: 13px;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 400px;
}
.direct-elapsed,
.direct-time {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.direct-muted {
  color: var(--muted);
}

/* Result line for closed arcs */
.arc-result {
  font-size: 13px;
  font-style: italic;
  color: var(--muted);
  margin-top: 10px;
  padding-top: 6px;
  border-top: 1px solid var(--faint);
}

/* ---------- Why-failed block ---------- */

.why-failed {
  margin: 10px 0 12px;
  padding: 8px 12px;
  border-left: 2px solid var(--rust);
  background: rgba(139, 74, 42, 0.04);
  cursor: pointer;
}
.why-failed-label {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--rust);
  margin: 0 0 4px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.why-failed-toggle {
  font-weight: 400;
  font-size: 9px;
  color: var(--muted);
}
.why-failed-body {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--rust);
  white-space: pre-wrap;
  max-height: 1.5em;
  overflow: hidden;
  transition: max-height 200ms ease;
}
.why-failed.expanded .why-failed-body {
  max-height: 600px;
}
/* Inline variant for decomposition tree child rows */
.why-failed-inline {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--rust);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 400px;
  cursor: pointer;
}
.why-failed-inline.expanded {
  white-space: pre-wrap;
  max-width: none;
  max-height: none;
}

/* ---------- Arc responsive ---------- */

@media (max-width: 1100px) {
  .page-wide { padding: 24px 24px 80px; }
  .arc-child {
    grid-template-columns: 72px 1fr 80px 70px;
  }
  .arc-child-elapsed,
  .arc-child-cost { display: none; }
}
@media (max-width: 760px) {
  .page-wide { padding: 16px; max-width: 100%; }
  .arc-header { flex-wrap: wrap; gap: 6px; padding: 8px 10px; }
  .arc-title { white-space: normal; }
  .arc-body { padding: 0 10px 10px 24px; }
  .arc-child {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: auto auto;
  }
  .arc-child-title { grid-column: 1 / -1; }
}
`;
