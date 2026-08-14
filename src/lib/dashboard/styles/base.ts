/**
 * Base styles: CSS custom properties, reset, page layout, footer.
 *
 * Direction: The Apiary Record (seed 2570ec1e). Ground is weathered chalk,
 * not cream paper; colour comes from painted hive bodies, which is why the
 * project slots are flat and saturated and why oxide red is reserved for
 * escalation and never used decoratively.
 *
 * The --paper / --amber / --rust / --serif names below are migration
 * aliases: sections not yet rebuilt still reference them, so they resolve
 * into the new palette rather than shattering the page mid-migration.
 * Delete each alias as its section is rewritten.
 */
export const BASE_CSS = `
:root {
  /* Ground */
  --chalk: #e6e4dd;
  --chalk-deep: #dad7cc;
  --ink: #16150f;
  --ink-soft: #3d3a30;
  --muted: #6e6a5c;
  --faint: #c3bfb1;

  /* Reserved. Escalation only — never decoration. */
  --oxide: #b8532c;

  /* Painted hive bodies. Stable slot per project.
     Values alternate dark / mid / dark / mid / dark so any two neighbours
     separate by lightness as well as hue — the first palette was five
     mid-tones and read as mud. */
  --hive-0: #17529e;
  --hive-1: #57ad8b;
  --hive-2: #6a3f86;
  --hive-3: #79a7c9;
  --hive-4: #7d8b2e;

  /* Unpainted pine. A beekeeper paints the hives being tracked and leaves
     the rest bare, so paint carries "look at me" and wood carries "fine". */
  --wood: #c6ab7e;

  --ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  /* PLACEHOLDER: the stencil voice wants a real embedded face, not a
     condensed system stack. Tracked on TK-142; do not ship as-is. */
  --stencil: "Haettenschweiler", "Arial Narrow", var(--ui);
  --stencil-tracking: 0.06em;

  /* Migration aliases — remove with their sections. */
  --paper: var(--chalk);
  --amber: var(--hive-0);
  --rust: var(--oxide);
  --serif: var(--ui);
  --smallcaps-tracking: 0.08em;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--chalk);
  color: var(--ink);
  font-family: var(--ui);
  font-size: 15px;
  line-height: 1.55;
  font-feature-settings: "tnum" 1;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* Browser surfaces belong to the design too. */
::selection { background: var(--hive-0); color: var(--chalk); }
:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
* { scrollbar-color: var(--faint) transparent; scrollbar-width: thin; }
::-webkit-scrollbar { width: 11px; height: 11px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--faint);
  border: 3px solid var(--chalk);
  border-radius: 0;
}
::-webkit-scrollbar-thumb:hover { background: var(--muted); }

a {
  color: inherit;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: var(--faint);
}
a:hover { text-decoration-color: var(--ink); }

code, .mono, .mono * {
  font-family: var(--mono);
  font-size: 0.92em;
  font-feature-settings: "tnum" 1;
}

.page {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 36px 96px;
}

.page.page-wide { max-width: 1680px; }

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
