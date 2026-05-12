/**
 * Masthead, dateline, and health ticker strip.
 */
export const MASTHEAD_CSS = `
/* ---------- Masthead ---------- */

.masthead {
  border-top: 4px double var(--ink);
  border-bottom: 1px solid var(--ink);
  padding: 28px 0 14px;
  text-align: center;
}

.masthead h1 {
  margin: 0;
  font-size: 68px;
  letter-spacing: 0.02em;
  font-weight: 900;
  line-height: 1;
  font-variant-ligatures: common-ligatures;
}

.dateline {
  margin-top: 10px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}

.dateline .sep { margin: 0 10px; color: var(--faint); }

/* Health ticker strip: mono, small, single line */
.ticker {
  border-top: 1px solid var(--ink);
  border-bottom: 1px solid var(--ink);
  padding: 6px 12px;
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-soft);
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  justify-content: center;
}
.ticker .item { white-space: nowrap; }
.ticker .label {
  color: var(--amber);
  letter-spacing: var(--smallcaps-tracking);
  margin-right: 6px;
}
`;
