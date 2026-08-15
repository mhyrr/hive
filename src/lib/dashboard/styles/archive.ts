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
/* Honey-amber is the direction's binding anti-reference, and these two rules
   were the last hardcoded #c47b1c on the page — the migration alias never
   caught them because they never went through a token. Today's card is marked
   the way the yard marks a colony: by paint on the object, not a wash behind
   it. */
.archive-card:hover { border-top-color: var(--hive-0); }
.archive-card.active {
  border-top: 2px solid var(--hive-0);
  padding-top: 9px;
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
