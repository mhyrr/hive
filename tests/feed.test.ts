import { describe, expect, test } from "bun:test";

import { parseStructuredFeedEntries, renderFeedEntry } from "../src/lib/feed";

describe("feed formatting", () => {
  test("parses grouped feed entries with details", () => {
    const feedText = [
      "# HIVE Feed",
      "",
      renderFeedEntry({
        project: "hive",
        headline: "steward exited",
        details: [
          "runtime: claude",
          "auth: subscription",
          "tokens: in 1200 | out 220 | total 1420",
          "cost: $0.0775",
        ],
      }).trim(),
    ].join("\n");

    const entries = parseStructuredFeedEntries(feedText);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.project).toBe("hive");
    expect(entries[0]?.headline).toBe("steward exited");
    expect(entries[0]?.details).toEqual([
      "runtime: claude",
      "auth: subscription",
      "tokens: in 1200 | out 220 | total 1420",
      "cost: $0.0775",
    ]);
  });
});
