/**
 * Strips internal system content from steward output before it reaches the UI.
 *
 * The Pi agent sometimes leaks tool output (file contents, system-reminder tags,
 * turn-meta comments, run metadata) into its assistant text.  This filter
 * removes those artifacts while leaving legitimate markdown and code blocks
 * intact.
 */

// <system-reminder> ... </system-reminder>  (can span multiple lines)
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// <!-- turn-meta: ... -->  (single-line HTML comment)
const TURN_META_RE = /<!--\s*turn-meta:.*?-->/g;

// Lines produced by the Read tool: leading spaces, a number, then the arrow char
// e.g. "     1→import { foo } from 'bar';"
// We match entire lines so we can strip them without leaving blank holes.
const READ_TOOL_LINE_RE = /^[ \t]*\d+→.*$/gm;

// Run metadata key-value lines the steward regurgitates from result frontmatter.
// Matches lines like "cognitive-model: claude-haiku-4-5-20251001" or
// "assignment-message: assign-scout-haiku-002-20260321-011500.md"
const RUN_METADATA_KEYS = [
  "run",
  "agent",
  "status",
  "ended",
  "exit-code",
  "assignment-message",
  "assignment-status-after-exit",
  "assignment-resolved-by-worker",
  "git-summary",
  "cost-usd",
  "auth-mode",
  "duration-ms",
  "num-turns",
  "input-tokens",
  "output-tokens",
  "cache-creation-input-tokens",
  "cache-read-input-tokens",
  "total-tokens",
  "cognitive-provider",
  "cognitive-model",
  "cognitive-summary",
  "cognitive-outcome",
  "cognitive-key-decisions",
  "cognitive-files-changed",
  "cognitive-input-tokens",
  "cognitive-output-tokens",
  "cognitive-total-tokens",
  "cognitive-duration-ms",
  "worker-runtime",
  "worker-model",
  "changed-files",
];

// Build a single regex that matches any of the known metadata key lines.
// Anchored to start of line; requires ": " separator to avoid false positives.
const RUN_METADATA_RE = new RegExp(
  `^(?:${RUN_METADATA_KEYS.join("|")}): .+$`,
  "gm",
);

export function sanitizeStewardOutput(text: string): string {
  if (!text) {
    return text;
  }

  let result = text;

  result = result.replace(SYSTEM_REMINDER_RE, "");
  result = result.replace(TURN_META_RE, "");
  result = result.replace(READ_TOOL_LINE_RE, "");
  result = result.replace(RUN_METADATA_RE, "");

  // Collapse runs of 3+ blank lines left behind by the removals into at most 2.
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
