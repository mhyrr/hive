/**
 * Inbox section: two-column grid with project entries.
 */
export const INBOX_CSS = `
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
`;
