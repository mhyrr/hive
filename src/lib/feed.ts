import { HivePaths } from "./paths";
import { toIsoTimestamp } from "./time";

export type FeedEntryInput = {
  project?: string | null;
  headline: string;
  details?: string[];
};

function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

export function renderFeedEntry(input: FeedEntryInput): string {
  const lines = [
    `## ${toIsoTimestamp()}${input.project ? ` [${input.project}]` : ""}`,
    input.headline.trim(),
    ...(input.details ?? []).map((line) => `- ${line.trim()}`),
  ].filter(Boolean);

  return `${lines.join("\n")}\n`;
}

export async function appendFeedEntry(
  paths: HivePaths,
  input: FeedEntryInput,
): Promise<void> {
  const existing = normalizeText(await Bun.file(paths.feed).text().catch(() => "# HIVE Feed"));
  const next = `${existing}\n\n${renderFeedEntry(input).trim()}\n`;

  await Bun.write(paths.feed, next);
}

export function parseFeedEntries(feedText: string): string[] {
  const normalized = normalizeText(feedText);
  const sections = normalized.split(/^##\s/m);

  return sections
    .slice(1)
    .map((section) => `## ${section.trim()}`)
    .filter(Boolean);
}

export function formatFeed(feedText: string, limit: number): string {
  const entries = parseFeedEntries(feedText);

  if (entries.length === 0) {
    return "# HIVE Feed\n\n(none yet)";
  }

  return ["# HIVE Feed", ...entries.slice(-limit)].join("\n\n");
}
