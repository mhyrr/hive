/**
 * Interactive UI: pill filters, action buttons, snackbar, optimistic states,
 * focus ring, and needs-action toggle.
 */
export const INTERACTIVE_CSS = `
/* ---------- Pill row + Needs-Action toggle ---------- */

.pill-row {
  margin-top: 18px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-bottom: 1px solid var(--amber);
  padding: 4px 0 6px;
  gap: 18px;
}
.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  font-variant: small-caps;
  letter-spacing: var(--smallcaps-tracking);
  font-size: 13px;
}
.pill {
  color: var(--ink);
  background: transparent;
  border: 0;
  padding: 2px 0;
  cursor: pointer;
  font-family: var(--serif);
  font-size: inherit;
  letter-spacing: inherit;
  font-variant: inherit;
  border-bottom: 1px solid transparent;
}
.pill:hover { color: var(--rust); }
.pill--active {
  font-weight: 700;
  border-bottom: 2px solid var(--amber);
  color: var(--ink);
}
.filter-banner {
  display: none;
  padding: 8px 12px;
  margin: 4px 0 10px 0;
  border-top: 1px solid var(--amber);
  border-bottom: 1px solid var(--amber);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--ink);
  background: transparent;
}
.filter-banner.visible { display: block; }
.filter-banner strong {
  font-weight: 700;
  color: var(--amber);
  text-transform: none;
  letter-spacing: 0;
}
.filter-clear {
  background: transparent;
  border: 0;
  padding: 0 0 0 6px;
  margin-left: 6px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--rust);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--rust);
  text-underline-offset: 2px;
}
.filter-clear:hover { color: var(--ink); }
.needs-action-toggle {
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--amber);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  padding: 2px 0;
}
.needs-action-toggle[aria-pressed="true"] { color: var(--rust); font-weight: 700; }

/* When filter on: rows without action buttons fade out */
body.filtered-by-actions .row-less:not(.has-action) {
  display: none;
}

/* ---------- Action buttons — typographic [ label ] ---------- */

.action {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--amber);
  background: transparent;
  border: 0;
  padding: 0 6px 0 0;
  cursor: pointer;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: lowercase;
}
.action:hover { color: var(--rust); }
.action[aria-pressed="true"] { color: var(--rust); font-weight: 700; }
.action[disabled] { color: var(--muted); cursor: default; }

/* Row actions cluster to the right/below row content */
.row-actions {
  margin-top: 4px;
  font-family: var(--mono);
  font-size: 10.5px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.ticket-row .row-actions,
.dispatch-row .row-actions,
.inbox-entry .row-actions {
  margin-top: 4px;
}

/* ---------- Snackbar ---------- */

.snackbar {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--ink);
  color: var(--paper);
  padding: 8px 18px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
  z-index: 100;
  max-width: 520px;
}
.snackbar.visible { opacity: 1; }
.snackbar.err { background: var(--rust); }

/* ---------- Row fade for optimistic UI ---------- */

.pending { opacity: 0.4; transition: opacity 0.15s ease; }
.gone { display: none !important; }

/* ---------- Focus ring for keyboard nav ---------- */

.focused {
  outline: 2px solid var(--amber);
  outline-offset: 2px;
}
`;
