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
