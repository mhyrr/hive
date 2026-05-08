/**
 * CSS for the HIVE Morning Edition dashboard.
 *
 * Design intent: broadsheet newspaper, not SaaS dashboard.
 * Serif everywhere, cream/ink/amber palette, hairline rules, no shadows,
 * no icons, no emojis, no border-radius above 2px. System fonts only.
 */

export const DASHBOARD_CSS = `
:root {
  --paper: #f7f3ea;
  --ink: #1a1a1a;
  --ink-soft: #2a2724;
  --muted: #6f6a5e;
  --faint: #d8d1be;
  --amber: #c47b1c;
  --rust: #8b4a2a;
  --serif: "Iowan Old Style", "Apple Garamond", Palatino, "Palatino Linotype", Georgia, serif;
  --mono: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --smallcaps-tracking: 0.08em;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--serif);
  font-size: 15px;
  line-height: 1.55;
  font-feature-settings: "tnum" 0, "onum" 1;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

a {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid var(--amber);
  padding-bottom: 1px;
}
a:hover { color: var(--rust); }

code, .mono, .mono * {
  font-family: var(--mono);
  font-size: 0.92em;
  font-feature-settings: "tnum" 1;
}

.page {
  max-width: 1280px;
  margin: 0 auto;
  padding: 32px 36px 96px;
}

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

/* ---------- Inbox ---------- */

.inbox-grid {
  column-count: 2;
  column-gap: 28px;
  column-rule: 1px solid var(--faint);
}
.inbox-entry {
  break-inside: avoid-column;
  margin-bottom: 22px;
}
.inbox-entry .head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  border-bottom: 1px solid var(--ink);
  padding-bottom: 2px;
  margin-bottom: 6px;
}
.inbox-entry .head .project {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.01em;
}
.inbox-entry .head .mtime {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.inbox-entry .body {
  font-size: 13.5px;
  line-height: 1.5;
}
.inbox-entry .body h1,
.inbox-entry .body h2,
.inbox-entry .body h3 {
  font-size: 13px;
  font-weight: 700;
  margin: 10px 0 4px;
  letter-spacing: 0.01em;
}
.inbox-entry .body p,
.inbox-entry .body li { margin: 0 0 6px; }
.inbox-entry .body code { color: var(--rust); }
.inbox-entry .body pre {
  font-family: var(--mono);
  font-size: 11px;
  border-left: 2px solid var(--amber);
  padding-left: 8px;
  margin: 4px 0;
  white-space: pre-wrap;
}
.inbox-entry .body strong { font-weight: 800; }
.inbox-entry.empty .body { color: var(--muted); font-style: italic; }
.toggle {
  cursor: pointer;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--amber);
  user-select: none;
  border-bottom: 1px dotted var(--amber);
}

/* ---------- Tickets ---------- */

.ticket-groups {
  column-count: 3;
  column-gap: 28px;
  column-rule: 1px solid var(--faint);
}
.ticket-group {
  break-inside: avoid-column;
  margin-bottom: 22px;
}
.ticket-group h3 {
  font-size: 12px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  margin: 0 0 6px;
  color: var(--muted);
  border-bottom: 1px solid var(--ink);
  padding-bottom: 2px;
  font-weight: 700;
}
.ticket-row {
  padding: 5px 0;
  border-bottom: 1px solid var(--faint);
  font-size: 13px;
}
.ticket-row:last-child { border-bottom: 0; }
.ticket-row .id {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink-soft);
  margin-right: 8px;
}
.ticket-row .title { font-weight: 600; }
.ticket-row .meta {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  margin-top: 2px;
}
.ticket-row .deps {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--rust);
  font-style: italic;
  margin-top: 2px;
}
.ticket-row .prio-P0 { color: var(--rust); }
.ticket-row .prio-P1 { color: var(--amber); }
.ticket-row .prio-P2 { color: var(--muted); }
.ticket-row .prio-P3 { color: var(--faint); }

.status-tag {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.status-tag.open     { color: var(--amber); }
.status-tag.progress { color: var(--ink); font-weight: 800; }
.status-tag.blocked  { color: var(--rust); }
.status-tag.closed   { color: var(--faint); }

/* ---------- Dispatch log ---------- */

.dispatch-list { margin: 0; padding: 0; list-style: none; }
.dispatch-row {
  display: grid;
  grid-template-columns: 110px 90px 90px 1fr 110px;
  gap: 16px;
  padding: 8px 0;
  border-bottom: 1px solid var(--faint);
  align-items: baseline;
}
.dispatch-row .id,
.dispatch-row .status,
.dispatch-row .duration,
.dispatch-row .ticket {
  font-family: var(--mono);
  font-size: 12px;
}
.dispatch-row .status { letter-spacing: var(--smallcaps-tracking); text-transform: uppercase; }
.dispatch-row .goal {
  font-style: italic;
  color: var(--ink-soft);
  font-size: 14px;
  line-height: 1.45;
}
.dispatch-row .status.status-complete { color: var(--ink); font-weight: 800; }
.dispatch-row .status.status-partial  { color: var(--amber); }
.dispatch-row .status.status-failed,
.dispatch-row .status.status-crashed,
.dispatch-row .status.status-timed_out { color: var(--rust); }
.dispatch-row .status.status-running  { color: var(--amber); font-weight: 800; }

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

/* Archive inline briefings are pre-rendered but hidden until activated */
.briefing-article { display: none; }
.briefing-article.active { display: block; }

.footer {
  margin-top: 56px;
  padding-top: 16px;
  border-top: 1px solid var(--ink);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  text-align: center;
}

/* =====================================================================
   v2: pill row, Top Three, collapsed projects, action buttons, snackbar
   Typographic, no filled pills, no shadows, no border-radius above 2px.
   ===================================================================== */

/* ---------- Sticky top navigation ---------- */

html { scroll-padding-top: 48px; }

.sticky-nav {
  position: sticky;
  top: 0;
  z-index: 1000;
  isolation: isolate;
  background: var(--paper);
  border-bottom: 1px solid var(--amber);
  padding: 0 18px;
}
.sticky-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
  padding: 6px 0;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.sticky-title {
  font-weight: 700;
  color: var(--ink);
  white-space: nowrap;
}
.sticky-title .sep {
  color: var(--muted);
  font-weight: 400;
  margin: 0 6px;
}
.jump-links {
  display: flex;
  gap: 16px;
  flex: 1;
  justify-content: center;
  flex-wrap: wrap;
}
.jump-links a {
  color: var(--ink);
  text-decoration: none;
  padding-bottom: 2px;
  border-bottom: 1px solid transparent;
  transition: border-color 120ms, color 120ms;
}
.jump-links a:hover {
  color: var(--amber);
  border-bottom-color: var(--amber);
}
.sticky-filter {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.sticky-filter .pills { gap: 10px; }
.sticky-filter .pill { font-size: 10.5px; padding: 0; }
.sticky-filter .needs-action-toggle { font-size: 10px; }
@media (max-width: 900px) {
  .sticky-row { flex-wrap: wrap; gap: 8px; }
  .jump-links { justify-content: flex-start; order: 3; flex-basis: 100%; }
  .sticky-filter { order: 2; }
}

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

/* ---------- Today's Three Things ---------- */

.top-three {
  margin: 22px 0 8px;
  border: 1px solid var(--amber);
  padding: 14px 20px 12px;
}
.top-three-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.top-three-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.01em;
}
.top-three-head .kicker {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.top-three-list {
  margin: 0;
  padding-left: 1.4em;
  font-size: 14.5px;
  line-height: 1.55;
}
.top-three-list li { margin-bottom: 4px; }
.top-three-list li:last-child { margin-bottom: 0; }

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
