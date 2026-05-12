/**
 * Cross-cutting responsive breakpoints that affect multiple sections.
 */
export const RESPONSIVE_CSS = `
/* ---------- Responsive ---------- */

@media (max-width: 1100px) {
  .briefing { column-count: 2; }
  .ticket-groups { column-count: 2; }
  .inbox-grid { column-count: 1; }
}
@media (max-width: 760px) {
  .page { padding: 16px; }
  .masthead h1 { font-size: 44px; }
  .briefing, .ticket-groups { column-count: 1; }
  .dispatch-row {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: auto auto auto;
  }
  .dispatch-row .goal { grid-column: 1 / -1; }
}
`;
