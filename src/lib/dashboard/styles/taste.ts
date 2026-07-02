/**
 * Taste: the home-page taste-track strip and the standalone /taste library
 * page (category blocks, unit cards, lifecycle badges, principles rail).
 *
 * Palette-consistent with the rest of the broadsheet — amber accents, hairline
 * rules, no shadows. Status is carried by a small-caps badge, not colour alone.
 */
export const TASTE_CSS = `
/* ---------- Taste (shared stats strip) ---------- */

.taste-stats {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  font-size: 13px;
}
.taste-stats li { color: var(--muted); }
.taste-stats .num {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  margin-right: 4px;
}
.taste-stats .num strong { color: var(--rust); }

.taste-proposals { margin-top: 12px; }
.taste-proposals h3 {
  font-size: 12px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 4px;
}

/* ---------- /taste — the library ---------- */

.taste-cat { break-inside: avoid; }

.taste-unit {
  padding: 10px 0 12px;
  border-bottom: 1px solid var(--faint);
  border-left: 2px solid transparent;
  padding-left: 12px;
  margin-left: -12px;
}
.taste-unit:last-child { border-bottom: 0; }
.taste-unit--active { border-left-color: var(--amber); }
.taste-unit--pending { border-left-color: var(--faint); }
.taste-unit--holding { border-left-color: transparent; }

.taste-unit-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.taste-rule {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.35;
  min-width: 0; /* let the flex item shrink so long rules wrap... */
  max-width: 76ch; /* ...at a readable measure instead of the full page width */
}

.taste-badge {
  flex: 0 0 auto;
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  padding: 1px 6px;
  border: 1px solid var(--faint);
  color: var(--muted);
  white-space: nowrap;
}
.taste-badge--active {
  color: var(--paper);
  background: var(--amber);
  border-color: var(--amber);
}
.taste-badge--pending {
  color: var(--rust);
  border-color: var(--rust);
}

.taste-meta {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.taste-ladder { color: var(--amber); }

.taste-detail { margin-top: 8px; }
.taste-detail summary {
  cursor: pointer;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--amber);
  list-style: none;
}
.taste-detail summary::-webkit-details-marker { display: none; }
.taste-detail summary::before { content: "▸ "; }
.taste-detail[open] summary::before { content: "▾ "; }
.taste-why {
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  margin: 8px 0 0;
  max-width: 68ch;
}

.taste-eg {
  margin-top: 8px;
  padding-left: 12px;
  border-left: 2px solid var(--faint);
}
.taste-eg p {
  font-size: 13px;
  line-height: 1.45;
  margin: 4px 0;
  color: var(--ink-soft);
}
.taste-eg-label {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  margin-right: 6px;
}
.taste-eg-bad { color: var(--rust); }
.taste-eg-good { color: var(--amber); }

/* Review queue — the actionable table. Left-aligned, its own width. */
.taste-review-table {
  border-collapse: collapse;
  width: auto;
  margin: 2px 0 10px;
}
.taste-review-table th {
  text-align: left;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 700;
  border-bottom: 1px solid var(--ink);
  padding: 0 28px 4px 0;
}
.taste-review-table td {
  font-size: 13px;
  padding: 6px 28px 6px 0;
  border-bottom: 1px solid var(--faint);
  vertical-align: baseline;
}
.taste-review-table tr:last-child td { border-bottom: 0; }
.taste-review-table td.num { font-family: var(--mono); font-size: 12px; }
.taste-review-table .rule-key {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  font-weight: 600;
}

/* Principles rail — name + gloss, two columns. */
.taste-principle-list {
  columns: 2;
  column-gap: 40px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.taste-principle {
  break-inside: avoid;
  padding: 9px 0;
  border-bottom: 1px solid var(--faint);
}
.taste-principle h3 {
  font-size: 14px;
  font-weight: 700;
  color: var(--ink);
  margin: 0 0 3px;
}
.taste-principle p {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--muted);
  margin: 0;
  max-width: 52ch;
}

/* Home-page section → full-library link. */
.taste-more {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
`;
