/**
 * The semantic view of a per-project inbox.
 *
 * Inbox files carry a markdown header and older files may also carry a Pass F
 * tombstone. Neither is a finding. Keeping that distinction here prevents
 * each consumer from inventing its own definition of "empty".
 */

export type InboxContent =
  | { kind: "empty"; body: ""; byteLength: 0 }
  | { kind: "content"; body: string; byteLength: number };

const PASS_F_TOMBSTONE = /^\s*_Truncated by Pass F at [^\n]+_\s*$/gim;
const HIVE_MARKER = /<!--\s*hive(?::|\s)[\s\S]*?-->/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function emptyInbox(projectId: string): string {
  return `# Inbox: ${projectId}\n\n`;
}

export function parseInbox(raw: string, projectId: string): InboxContent {
  const header = new RegExp(
    `^\\s*#\\s+Inbox:\\s+${escapeRegExp(projectId)}\\s*(?:\\r?\\n|$)`,
    "i",
  );
  const body = raw
    .replace(header, "")
    .replace(PASS_F_TOMBSTONE, "")
    .replace(HIVE_MARKER, "")
    .trim();

  if (!body) {
    return { kind: "empty", body: "", byteLength: 0 };
  }

  return {
    kind: "content",
    body,
    byteLength: new TextEncoder().encode(body).byteLength,
  };
}
