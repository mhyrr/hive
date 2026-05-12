/**
 * Briefing section: three-column broadsheet body, lede, drop cap, tables.
 */
export const BRIEFING_CSS = `
/* ---------- Briefing section (three-column broadsheet body) ---------- */

.briefing-wrap {
  position: relative;
}

.briefing {
  column-count: 3;
  column-gap: 28px;
  column-rule: 1px solid var(--faint);
}

.briefing h1, .briefing h2, .briefing h3 {
  column-span: all;
  -webkit-column-span: all;
  font-weight: 800;
  letter-spacing: 0.01em;
  line-height: 1.2;
}
.briefing h1 {
  margin: 0 0 8px;
  font-size: 30px;
  text-align: center;
  border-bottom: 1px solid var(--ink);
  padding-bottom: 8px;
}
.briefing h2 {
  margin: 18px 0 6px;
  font-size: 17px;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--faint);
}
.briefing h3 {
  margin: 14px 0 4px;
  font-size: 14px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 700;
}
.briefing p, .briefing li {
  margin: 0 0 8px;
  break-inside: avoid-column;
}
.briefing ul, .briefing ol {
  margin: 4px 0 10px 1.1em;
  padding: 0;
}
.briefing strong { font-weight: 800; }
.briefing em { font-style: italic; }
.briefing hr {
  border: 0;
  border-top: 1px solid var(--faint);
  margin: 14px 0;
  column-span: all;
  -webkit-column-span: all;
}
.briefing code {
  background: transparent;
  color: var(--rust);
}
.briefing pre {
  font-family: var(--mono);
  font-size: 12px;
  background: transparent;
  border-left: 2px solid var(--amber);
  padding-left: 10px;
  margin: 8px 0;
  white-space: pre-wrap;
}
.briefing blockquote {
  margin: 10px 0;
  padding-left: 14px;
  border-left: 3px solid var(--amber);
  font-style: italic;
  color: var(--ink-soft);
}

/* Lede paragraph — full-width across all columns, like a newspaper standfirst */
.briefing > h2:first-of-type + p,
.briefing > h1 + p,
.briefing > p:first-of-type {
  column-span: all;
  -webkit-column-span: all;
  font-size: 17px;
  line-height: 1.45;
  margin: 0 0 14px;
}

/* Drop cap on the first paragraph after the lede heading */
.briefing > p:first-of-type::first-letter,
.briefing > h1 + p::first-letter,
.briefing > h2:first-of-type + p::first-letter {
  initial-letter: 3;
  -webkit-initial-letter: 3;
  float: left;
  font-size: 48px;
  line-height: 0.9;
  padding: 2px 6px 0 0;
  font-weight: 800;
  color: var(--amber);
}

/* Tables inside briefing — financial pages style */
.briefing table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0 14px;
  font-size: 13px;
  break-inside: avoid-column;
  font-feature-settings: "tnum" 1;
}
.briefing th {
  text-align: left;
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  border-bottom: 1px solid var(--ink);
  padding: 4px 6px;
  color: var(--muted);
  font-weight: 700;
}
.briefing td {
  border-bottom: 1px solid var(--faint);
  padding: 4px 6px;
  vertical-align: top;
}

/* Archive inline briefings are pre-rendered but hidden until activated */
.briefing-article { display: none; }
.briefing-article.active { display: block; }
`;
