import type { CompileTask } from "../packets";
import { fingerprintParts } from "../packets";
import { DEFAULT_PACKET_FRESHNESS_MS, truncateInline } from "./shared";

export type LogRollupInput = {
  projectId: string;
  logText: string;
  feedText: string;
};

export type LogRollupData = {
  window: "recent";
  logEntries: Array<{
    ts: string | null;
    actor: string;
    summary: string;
  }>;
  feedHeadlines: string[];
};

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function parseLogEntries(logText: string): LogRollupData["logEntries"] {
  const normalized = normalizeText(logText);
  const sections = normalized.split(/^##\s/m).slice(1);

  return sections
    .map((section) => {
      const lines = `## ${section}`.trim().split("\n").map((line) => line.trim()).filter(Boolean);
      const header = lines.shift();
      const summary = truncateInline(lines.join(" "), 220);

      if (!header || !summary) {
        return null;
      }

      const match = header.match(/^##\s+([^\s]+)\s+[—-]\s+(.+)$/);

      return {
        ts: match?.[1]?.trim() ?? null,
        actor: match?.[2]?.trim() ?? "unknown",
        summary,
      };
    })
    .filter((entry): entry is LogRollupData["logEntries"][number] => entry != null)
    .slice(-8)
    .reverse();
}

function parseFeedHeadlines(feedText: string): string[] {
  const normalized = normalizeText(feedText);
  const sections = normalized.split(/^##\s/m).slice(1);

  return sections
    .map((section) => {
      const lines = `## ${section}`.trim().split("\n").map((line) => line.trim()).filter(Boolean);
      return lines[1] ? truncateInline(lines[1], 180) : null;
    })
    .filter((line): line is string => line != null)
    .slice(-6)
    .reverse();
}

export const logRollupTask: CompileTask<LogRollupInput, LogRollupData> = {
  id: "log-rollup",
  kind: "log-rollup",
  trigger: "idle",
  freshnessMs: DEFAULT_PACKET_FRESHNESS_MS,
  priority: "background",
  shouldRun(input) {
    return normalizeText(input.logText).length > 0 || normalizeText(input.feedText).length > 0;
  },
  fingerprint(input) {
    return fingerprintParts("log-rollup", input.projectId, input.logText, input.feedText);
  },
  classify() {
    return "deterministic";
  },
  async run(input) {
    return {
      window: "recent",
      logEntries: parseLogEntries(input.logText),
      feedHeadlines: parseFeedHeadlines(input.feedText),
    };
  },
};
