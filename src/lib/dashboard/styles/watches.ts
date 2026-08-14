/**
 * Watches: the fleet page's output cards and the per-watch detail page
 * (spec table, verbatim prompt blocks, invocation history).
 *
 * Output is prose a model wrote — set it as prose, single column, not as a
 * log dump. Prompts are the opposite: monospace, verbatim, amber-ruled.
 */
export const WATCHES_CSS = `
/* ---------- Watch output cards ---------- */

.watch-card {
  border-top: 1px solid var(--faint);
  padding-top: 10px;
  margin-bottom: 22px;
}
.watch-card:first-of-type { border-top: 0; }
.watch-card .head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  border-bottom: 1px solid var(--ink);
  padding-bottom: 2px;
  margin-bottom: 8px;
}
.watch-card .head .watch-name {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.01em;
}
.watch-card .head .meta {
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  text-align: right;
}

.watch-out {
  font-size: 14px;
  line-height: 1.55;
  max-width: 74ch;
}
.watch-out h1, .watch-out h2, .watch-out h3 {
  font-size: 14px;
  font-weight: 800;
  margin: 12px 0 4px;
}
.watch-out p, .watch-out li { margin: 0 0 8px; }
.watch-out ul, .watch-out ol { margin: 4px 0 10px 1.1em; padding: 0; }
.watch-out strong { font-weight: 800; }
.watch-out em { font-style: italic; }
.watch-out code { color: var(--rust); }
.watch-out pre {
  font-family: var(--mono);
  font-size: 11.5px;
  border-left: 2px solid var(--amber);
  padding-left: 8px;
  margin: 6px 0;
  white-space: pre-wrap;
}

.watch-silence, .watch-reasons, .watch-note, .watch-truncated {
  color: var(--muted);
  font-size: 12.5px;
  margin: 4px 0 8px;
}
.watch-reasons, .watch-truncated { font-size: 10.5px; }
.watch-silence { font-style: italic; }

.watch-error {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--rust);
  border-left: 2px solid var(--rust);
  padding-left: 8px;
  margin: 6px 0;
  white-space: pre-wrap;
}

/* Paths are case-sensitive — never small-caps them. */
.watch-source {
  font-size: 10px;
  color: var(--muted);
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.watch-dropped {
  font-size: 11px;
  color: var(--rust);
  border-left: 2px solid var(--rust);
  padding-left: 8px;
  margin: 0 0 8px;
}

/* ---------- /watches/<name> — spec + prompts ---------- */

.watch-spec { border-collapse: collapse; margin: 4px 0 0; }
.watch-spec th {
  text-align: left;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 400;
  padding: 3px 18px 3px 0;
  vertical-align: baseline;
  white-space: nowrap;
}
.watch-spec td {
  font-size: 13.5px;
  padding: 3px 0;
  vertical-align: baseline;
}
.watch-spec .muted { color: var(--muted); }

.watch-sub {
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--muted);
  margin: 14px 0 4px;
}

.watch-prompt {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.5;
  border-left: 2px solid var(--amber);
  padding-left: 10px;
  margin: 4px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 460px;
  overflow-y: auto;
}

.watch-detail { margin-top: 8px; }
.watch-detail summary {
  cursor: pointer;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  color: var(--amber);
  list-style: none;
}
.watch-detail summary::-webkit-details-marker { display: none; }
.watch-detail summary::before { content: "▸ "; }
.watch-detail[open] summary::before { content: "▾ "; }
`;
