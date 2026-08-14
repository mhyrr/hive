/**
 * Page navigation and sticky top bar.
 */
export const NAVIGATION_CSS = `
/* ---------- Page-level cross-route nav (used on /tickets) ---------- */

.page-nav {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
  text-align: center;
  padding: 8px 0 14px;
  border-bottom: 1px solid var(--faint);
  margin-bottom: 6px;
}
.page-nav a {
  color: var(--ink-soft);
  border-bottom: none;
  margin: 0 4px;
}
.page-nav a:hover { color: var(--rust); }
.page-nav a.nav-active {
  color: var(--ink);
  font-weight: 700;
  border-bottom: 1px solid var(--amber);
  padding-bottom: 1px;
}
.page-nav .nav-sep { color: var(--faint); margin: 0 2px; }

/* ---------- Sticky top navigation ---------- */

html { scroll-padding-top: 84px; }

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
  flex-wrap: wrap;
  gap: 4px 18px;
  padding: 6px 0;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: var(--smallcaps-tracking);
  text-transform: uppercase;
}
.sticky-row--filter { padding-top: 0; justify-content: flex-end; }
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
  gap: 4px 16px;
  flex: 1;
  justify-content: center;
  flex-wrap: wrap;
  min-width: 0;
}
.jump-links a {
  color: var(--ink);
  white-space: nowrap;
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
  gap: 6px 14px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.sticky-filter .pills { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.sticky-filter .pill { font-size: 10.5px; padding: 0; white-space: nowrap; }
.sticky-filter .needs-action-toggle { font-size: 10px; white-space: nowrap; }
@media (max-width: 900px) {
  .jump-links { justify-content: flex-start; }
  .sticky-filter { justify-content: flex-start; }
}
`;
