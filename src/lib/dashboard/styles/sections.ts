/**
 * Section structure: headings, kickers, and hairline rules.
 */
export const SECTIONS_CSS = `
/* ---------- Section structure ---------- */

.section {
  margin-top: 44px;
}
.section > .section-head {
  border-bottom: 1px solid var(--ink);
  padding-bottom: 6px;
  margin-bottom: 18px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.section-head h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.01em;
}
.section-head .kicker {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
}

/* Hairline rule under amber */
hr.amber {
  border: 0;
  border-top: 2px solid var(--amber);
  margin: 4px 0 18px;
  width: 60px;
}
`;
