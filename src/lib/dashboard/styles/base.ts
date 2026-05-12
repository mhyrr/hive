/**
 * Base styles: CSS custom properties, reset, page layout, footer.
 */
export const BASE_CSS = `
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

/* Tickets page wants horizontal real estate for the 3-col kanbans. */
.page.page-wide {
  max-width: 1680px;
}

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
`;
