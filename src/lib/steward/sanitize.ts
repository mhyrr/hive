/**
 * Strips internal system content from steward output before it reaches the UI.
 *
 * The Pi agent sometimes leaks tool output (file contents, system-reminder tags,
 * turn-meta comments) into its assistant text.  This filter removes those
 * artifacts while leaving legitimate markdown and code blocks intact.
 */

// <system-reminder> ... </system-reminder>  (can span multiple lines)
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// <!-- turn-meta: ... -->  (single-line HTML comment)
const TURN_META_RE = /<!--\s*turn-meta:.*?-->/g;

// Lines produced by the Read tool: leading spaces, a number, then the arrow char
// e.g. "     1→import { foo } from 'bar';"
// We match entire lines so we can strip them without leaving blank holes.
const READ_TOOL_LINE_RE = /^[ \t]*\d+→.*$/gm;

export function sanitizeStewardOutput(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;

  result = result.replace(SYSTEM_REMINDER_RE, "");
  result = result.replace(TURN_META_RE, "");
  result = result.replace(READ_TOOL_LINE_RE, "");

  // Collapse runs of 3+ blank lines left behind by the removals into at most 2.
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
