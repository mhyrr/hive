/** Shared navigation for the standalone dashboard pages. */

/**
 * The one nav every standalone page carries.
 *
 * It was six copies, and they rotted together as the home page changed.
 * One list keeps the standalone surfaces honest.
 */
export const PAGE_NAV: ReadonlyArray<readonly [string, string]> = [
  ["BRIEFING", "/"],
  ["TICKETS", "/tickets"],
  ["TASTE", "/taste"],
];

/** Render the shared nav strip; `active` is the href of the current page. */
export function renderPageNav(active: string): string {
  return PAGE_NAV.map(([label, href]) => {
    const on = href === active ? ' class="nav-active"' : "";
    return `<a href="${href}"${on}>${label}</a>`;
  }).join(' <span class="nav-sep">&middot;</span> ');
}
