/**
 * Ledger table: financial-pages style for "Projects at a Glance."
 */
export const TABLES_CSS = `
/* ---------- Projects at a Glance — financial table ---------- */

table.ledger {
  width: 100%;
  border-collapse: collapse;
  font-feature-settings: "tnum" 1;
  font-size: 14px;
}
table.ledger th {
  text-align: left;
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--ink);
  padding: 5px 8px;
}
table.ledger td {
  border-bottom: 1px solid var(--faint);
  padding: 6px 8px;
  vertical-align: top;
}
table.ledger td.num,
table.ledger th.num {
  text-align: right;
  font-family: var(--mono);
  font-size: 13px;
}
table.ledger td.project-name {
  font-weight: 800;
}
table.ledger td.path { color: var(--muted); font-family: var(--mono); font-size: 11px; }
`;
