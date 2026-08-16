/**
 * Shared HTML helpers for the standalone dashboard pages.
 *
 * The main render.ts keeps its own copies (they sit under briefing-specific
 * post-processing); these exist so the watch pages share one escape and one
 * markdown path rather than each growing their own.
 */

import { marked } from "marked";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Markdown → HTML. Local-only server, so `marked` output goes in unsanitized —
 * same posture as the briefing body. */
export function md(source: string): string {
  if (!source || !source.trim()) return "";
  return marked.parse(source, { async: false, breaks: false, gfm: true }) as string;
}

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
  ["WATCHES", "/watches"],
];

/** Render the shared nav strip; `active` is the href of the current page. */
export function renderPageNav(active: string): string {
  return PAGE_NAV.map(([label, href]) => {
    const on = href === active ? ' class="nav-active"' : "";
    return `<a href="${href}"${on}>${label}</a>`;
  }).join(' <span class="nav-sep">&middot;</span> ');
}
