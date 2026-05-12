/**
 * Reflections section: two-column layout with markdown rendering.
 */
export const REFLECTIONS_CSS = `
/* ---------- Reflections ---------- */

.reflections {
  column-count: 2;
  column-gap: 28px;
  column-rule: 1px solid var(--faint);
}
.reflections h1, .reflections h2, .reflections h3 {
  column-span: all;
  -webkit-column-span: all;
  font-weight: 800;
  letter-spacing: 0.01em;
  line-height: 1.2;
}
.reflections h1 {
  margin: 0 0 8px;
  font-size: 22px;
  border-bottom: 1px solid var(--ink);
  padding-bottom: 6px;
}
.reflections h2 {
  margin: 16px 0 6px;
  font-size: 12px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 1px solid var(--faint);
  padding-bottom: 2px;
}
.reflections h3 {
  margin: 12px 0 4px;
  font-size: 13px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.reflections p, .reflections li {
  font-size: 14px;
  line-height: 1.55;
  margin: 0 0 8px;
}
.reflections ul, .reflections ol {
  margin: 0 0 12px;
  padding-left: 18px;
}
.reflections em { color: var(--muted); font-style: italic; }
.reflections code {
  font-family: var(--mono);
  font-size: 11px;
  background: rgba(196, 123, 28, 0.10);
  padding: 0 3px;
  border-radius: 2px;
}

.section-head .kicker-warn {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--rust);
}
`;
