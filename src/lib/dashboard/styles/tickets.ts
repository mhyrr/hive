/**
 * Tickets: home-page summary, tickets page kanbans, epic boards, ticket cards,
 * filter bar, and "Today's Three Things."
 */
export const TICKETS_CSS = `
/* ---------- Tickets ---------- */

.ticket-groups {
  column-count: 3;
  column-gap: 28px;
  column-rule: 1px solid var(--faint);
}
.ticket-group {
  break-inside: avoid-column;
  margin-bottom: 22px;
}
.ticket-group h3 {
  font-size: 12px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  margin: 0 0 6px;
  color: var(--muted);
  border-bottom: 1px solid var(--ink);
  padding-bottom: 2px;
  font-weight: 700;
}
.ticket-row {
  padding: 5px 0;
  border-bottom: 1px solid var(--faint);
  font-size: 13px;
}
.ticket-row:last-child { border-bottom: 0; }
.ticket-row .id {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink-soft);
  margin-right: 8px;
}
.ticket-row .title { font-weight: 600; }
.ticket-row .meta {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  margin-top: 2px;
}
.ticket-row .deps {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--rust);
  font-style: italic;
  margin-top: 2px;
}
.ticket-row .prio-P0 { color: var(--rust); }
.ticket-row .prio-P1 { color: var(--amber); }
.ticket-row .prio-P2 { color: var(--muted); }
.ticket-row .prio-P3 { color: var(--faint); }

.status-tag {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.status-tag.open     { color: var(--amber); }
.status-tag.progress { color: var(--ink); font-weight: 800; }
.status-tag.blocked  { color: var(--rust); }
.status-tag.closed   { color: var(--faint); }

/* ---------- Tickets page (per-epic kanbans) ---------- */

.tickets-page-meta {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  margin-top: 4px;
}

.tickets-page-empty {
  text-align: center;
  font-style: italic;
  color: var(--muted);
  padding: 60px 0;
  border-top: 1px dashed var(--faint);
  border-bottom: 1px dashed var(--faint);
  margin-top: 32px;
}

.epic-board, .standalone-board {
  margin-top: 30px;
  border-top: 1px solid var(--ink);
  padding-top: 12px;
}

.standalone-board .board-head .board-title {
  font-style: italic;
}

.board-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.board-head .board-eyebrow {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--amber);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  margin-right: 8px;
}

.board-head .board-id {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-soft);
  margin-right: 10px;
}

.board-head .board-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.005em;
  flex: 1 1 auto;
  min-width: 0;
}

.board-head .board-chips {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}
.board-head .board-chips .chip {
  margin-left: 12px;
}
.board-head .board-chips .chip-prio { color: var(--amber); font-weight: 700; }
.board-head .board-chips .chip-prio.p0 { color: var(--rust); }
.board-head .board-chips .chip-active { color: var(--ink); font-weight: 700; }
.board-head[role="button"] {
  cursor: pointer;
  outline: none;
}
.board-head[role="button"]:hover .board-title { color: var(--rust); }
.board-head[role="button"]:focus-visible { background: rgba(196, 123, 28, 0.04); }
.board-chevron {
  font-family: var(--mono);
  font-size: 16px;
  color: var(--amber);
  font-weight: 700;
  margin-left: 12px;
  display: inline-block;
  width: 16px;
  text-align: center;
  line-height: 1;
  transition: transform 0.15s ease;
}
.epic-board.expanded .board-chevron { transform: rotate(45deg); }

.epic-body {
  margin: 6px 0 14px;
  padding: 14px 18px;
  border-left: 3px solid var(--amber);
  background: rgba(196, 123, 28, 0.04);
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--ink);
}
.epic-body h1, .epic-body h2, .epic-body h3 {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--ink);
  margin: 16px 0 6px;
  font-weight: 700;
}
.epic-body h1:first-child,
.epic-body h2:first-child,
.epic-body h3:first-child { margin-top: 0; }
.epic-body p { margin: 0 0 10px; }
.epic-body ul, .epic-body ol { margin: 6px 0 10px; padding-left: 22px; }
.epic-body code {
  font-family: var(--mono);
  font-size: 12.5px;
  background: rgba(26,26,26,0.06);
  padding: 1px 4px;
}
.epic-body a { color: var(--rust); border-bottom: 1px dotted var(--amber); }

.kanban {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  border-top: 1px solid var(--faint);
  border-bottom: 1px solid var(--faint);
}

.kanban-col {
  padding: 10px 14px;
  border-right: 1px solid var(--faint);
  min-width: 0;
}
.kanban-col:last-child { border-right: 0; }

.kanban-col-head {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  font-weight: 700;
  margin: 0 0 10px 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--ink);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.kanban-col-head .col-count {
  color: var(--muted);
  font-weight: 400;
}
.kanban-col-head.ready    { color: var(--amber); }
.kanban-col-head.progress { color: var(--ink); }
.kanban-col-head.blocked  { color: var(--rust); }

.kanban-col-empty {
  text-align: center;
  color: var(--faint);
  font-family: var(--mono);
  font-size: 14px;
  padding: 6px 0;
}

.ticket-card {
  padding: 8px 0;
  border-bottom: 1px dotted var(--faint);
  cursor: pointer;
  outline: none;
}
.ticket-card:last-child { border-bottom: 0; }
.ticket-card:hover .card-id { color: var(--rust); }
.ticket-card:focus-visible {
  background: rgba(196, 123, 28, 0.04);
}

.ticket-card .card-id {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-soft);
  letter-spacing: 0.02em;
  text-decoration: underline;
  text-decoration-color: var(--amber);
  text-underline-offset: 2px;
}
.ticket-card .card-title {
  font-size: 14px;
  line-height: 1.35;
  font-weight: 500;
  display: block;
  margin-top: 1px;
}
.ticket-card .card-chevron {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 14px;
  color: var(--amber);
  font-weight: 700;
  width: 14px;
  text-align: center;
  line-height: 1;
  transition: transform 0.15s ease;
}
.ticket-card.expanded .card-chevron {
  transform: rotate(45deg); /* + → × */
}
.ticket-card .card-byline {
  margin-top: 3px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
.ticket-card .card-byline .project { color: var(--amber); }
.ticket-card .card-byline .prio-P0 { color: var(--rust); font-weight: 700; }
.ticket-card .card-byline .prio-P1 { color: var(--amber); font-weight: 700; }
.ticket-card .card-byline .prio-P2 { color: var(--muted); }
.ticket-card .card-byline .prio-P3 { color: var(--faint); }
.ticket-card .card-byline .age { color: var(--faint); }
.ticket-card .blocked-by {
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--rust);
  font-style: italic;
}

.ticket-card .card-runs {
  margin-top: 3px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
}
.ticket-card .card-runs-label {
  font-weight: 600;
  color: var(--ink-soft, var(--ink));
}
.ticket-card .card-runs .run-link {
  color: var(--amber);
  text-decoration: none;
}
.ticket-card .card-runs .run-link:hover {
  text-decoration: underline;
}
.ticket-card .card-runs .run-link .run-link-status { color: var(--muted); }
.ticket-card .card-runs .run-link.run-status-shipped .run-link-status { color: #3a7d44; }
.ticket-card .card-runs .run-link.run-status-failed .run-link-status,
.ticket-card .card-runs .run-link.run-status-crashed .run-link-status { color: var(--rust); }
.ticket-card .card-runs .run-link.run-status-running .run-link-status { color: var(--amber); }

/* Expanded inline detail */
.ticket-card .card-body {
  margin-top: 10px;
  padding: 10px 12px 10px;
  border-left: 2px solid var(--amber);
  background: rgba(196, 123, 28, 0.04);
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink-soft);
  cursor: text;
}
.ticket-card .card-body h1,
.ticket-card .card-body h2,
.ticket-card .card-body h3 {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--ink);
  margin: 14px 0 6px;
  font-weight: 700;
}
.ticket-card .card-body h1:first-child,
.ticket-card .card-body h2:first-child,
.ticket-card .card-body h3:first-child {
  margin-top: 0;
}
.ticket-card .card-body p { margin: 0 0 8px; }
.ticket-card .card-body ul,
.ticket-card .card-body ol {
  margin: 4px 0 8px;
  padding-left: 22px;
}
.ticket-card .card-body li { margin: 2px 0; }
.ticket-card .card-body code {
  font-family: var(--mono);
  font-size: 12px;
  background: rgba(26,26,26,0.06);
  padding: 1px 4px;
  border-radius: 1px;
}
.ticket-card .card-body pre {
  font-family: var(--mono);
  font-size: 12px;
  background: rgba(26,26,26,0.06);
  padding: 8px 10px;
  overflow-x: auto;
  margin: 6px 0;
}
.ticket-card .card-body input[type="checkbox"] {
  margin-right: 4px;
  accent-color: var(--amber);
}
.ticket-card .card-body a {
  color: var(--rust);
  border-bottom: 1px dotted var(--amber);
}

.ticket-card .card-tags {
  margin-top: 6px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ticket-card .card-tags span::before { content: "#"; color: var(--faint); margin-right: 1px; }

/* Mobile: kanban collapses to single column. */
@media (max-width: 720px) {
  .kanban {
    grid-template-columns: 1fr;
  }
  .kanban-col {
    border-right: 0;
    border-bottom: 1px solid var(--faint);
  }
  .kanban-col:last-child { border-bottom: 0; }
}

/* ---------- Tickets-page filter bar ---------- */

.tickets-filter-bar {
  display: flex;
  align-items: baseline;
  gap: 18px;
  margin: 6px 0 14px;
  padding: 6px 0 8px;
  border-top: 1px solid var(--amber);
  border-bottom: 1px solid var(--amber);
}
.tickets-filter-bar .pills { font-size: 12px; }

/* ---------- Today's Three Things ---------- */

.top-three {
  margin: 22px 0 8px;
  border: 1px solid var(--amber);
  padding: 14px 20px 12px;
}
.top-three-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.top-three-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.01em;
}
.top-three-head .kicker {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.top-three-list {
  margin: 0;
  padding-left: 1.4em;
  font-size: 14.5px;
  line-height: 1.55;
}
.top-three-list li { margin-bottom: 4px; }
.top-three-list li:last-child { margin-bottom: 0; }
`;
