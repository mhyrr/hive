/**
 * Archive strip: grid of past briefing cards.
 */
export const ARCHIVE_CSS = `
/* ---------- Archive strip ---------- */

.archive {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 14px;
  margin-top: 12px;
}
.archive-card {
  padding: 10px 12px;
  border-top: 1px solid var(--ink);
  border-bottom: 1px solid var(--faint);
  cursor: pointer;
  background: transparent;
}
.archive-card:hover { background: rgba(196, 123, 28, 0.06); }
.archive-card.active {
  background: rgba(196, 123, 28, 0.1);
  border-top: 2px solid var(--amber);
}
.archive-card .date {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
}
.archive-card .head {
  font-size: 13px;
  margin-top: 4px;
  line-height: 1.3;
}
`;
