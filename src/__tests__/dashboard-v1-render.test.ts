import { describe, test, expect } from "bun:test";

import {
  renderOpenQuestions,
  renderRecentMemory,
  renderRunUsage,
} from "../lib/dashboard/render";
import type {
  OpenQuestion,
  RecentMemoryEntry,
  RunUsageSnapshot,
} from "../lib/dashboard/collect";

// ---------------------------------------------------------------------------
// renderOpenQuestions
// ---------------------------------------------------------------------------

describe("renderOpenQuestions", () => {
  test("empty / undefined renders 'No open questions'", () => {
    expect(renderOpenQuestions([])).toContain("No open questions");
    expect(renderOpenQuestions(undefined)).toContain("No open questions");
  });

  test("groups by project with counts in kicker", () => {
    const items: OpenQuestion[] = [
      { projectId: "alpha", text: "How to cache layers?", tags: ["caching"] },
      { projectId: "alpha", text: "Move off Kafka?", tags: [] },
      { projectId: "bravo", text: "Migrate SDK?", tags: ["sdk"] },
    ];
    const html = renderOpenQuestions(items);
    expect(html).toContain("3 across 2 projects");
    expect(html).toContain('data-project="alpha"');
    expect(html).toContain('data-project="bravo"');
    expect(html).toContain("How to cache layers?");
    expect(html).toContain("<code>caching</code>");
  });

  test("escapes HTML in question text", () => {
    const html = renderOpenQuestions([
      { projectId: "alpha", text: "<script>alert(1)</script>", tags: [] },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// renderRecentMemory
// ---------------------------------------------------------------------------

describe("renderRecentMemory", () => {
  test("empty / undefined renders 'Quiet week'", () => {
    expect(renderRecentMemory([])).toContain("Quiet week");
    expect(renderRecentMemory(undefined)).toContain("Quiet week");
  });

  test("renders entries with project, section, strength, recency, tags", () => {
    const items: RecentMemoryEntry[] = [
      {
        projectId: "alpha",
        section: "convention",
        text: "Stage by name",
        tags: ["git", "hygiene"],
        createdAt: "2026-04-25",
        lastRecalled: "2026-04-26",
        strength: 1.42,
      },
      {
        projectId: "bravo",
        section: "fact",
        text: "PostgreSQL only",
        tags: [],
        createdAt: "2026-04-26",
        lastRecalled: null,
        strength: 1.0,
      },
    ];
    const html = renderRecentMemory(items);
    expect(html).toContain("alpha");
    expect(html).toContain("convention");
    expect(html).toContain("str 1.42");
    expect(html).toContain("recalled 2026-04-26");
    expect(html).toContain("created 2026-04-26");
    expect(html).toContain("Stage by name");
    expect(html).toContain("<code>git</code>");
    expect(html).toContain('data-project="alpha"');
    expect(html).toContain('data-project="bravo"');
  });

  test("kicker reports total count", () => {
    const items: RecentMemoryEntry[] = Array.from({ length: 7 }, (_, i) => ({
      projectId: "alpha",
      section: "fact",
      text: `entry ${i}`,
      tags: [],
      createdAt: "2026-04-26",
      lastRecalled: null,
      strength: 1.0,
    }));
    const html = renderRecentMemory(items);
    expect(html).toContain("7 entries");
  });
});

// ---------------------------------------------------------------------------
// renderRunUsage
// ---------------------------------------------------------------------------

describe("renderRunUsage", () => {
  test("missing / unavailable shows 'No nightly run'", () => {
    const snap: RunUsageSnapshot = {
      date: "2026-04-26",
      available: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalUsd: 0,
      totalUsdFormatted: "$0.0000",
      passes: [],
    };
    expect(renderRunUsage(snap)).toContain("No nightly run on file");
    expect(renderRunUsage(undefined)).toContain("No nightly run on file");
  });

  test("renders total dollar prominently and per-pass rows", () => {
    const snap: RunUsageSnapshot = {
      date: "2026-04-26",
      available: true,
      totalInputTokens: 80_000,
      totalOutputTokens: 6_000,
      totalUsd: 1.17,
      totalUsdFormatted: "$1.17",
      passes: [
        {
          pass: "B",
          project: "alpha",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          inputTokens: 8_000,
          outputTokens: 800,
          usd: 0.036,
          usdFormatted: "$0.036",
          durationMs: 200,
        },
        {
          pass: "V",
          project: null,
          provider: "anthropic",
          model: "claude-opus-4-6",
          inputTokens: 60_000,
          outputTokens: 4_000,
          usd: 1.2,
          usdFormatted: "$1.20",
          durationMs: 1500,
        },
      ],
    };
    const html = renderRunUsage(snap);
    expect(html).toContain("$1.17");
    expect(html).toContain("80,000 input + 6,000 output");
    expect(html).toContain("Pass B");
    expect(html).toContain("alpha");
    expect(html).toContain("Pass V");
    expect(html).toContain("claude-opus-4-6");
    // Per-pass dollar values
    expect(html).toContain("$0.036");
    expect(html).toContain("$1.20");
    // Duration rendered in seconds
    expect(html).toContain("0.2s");
    expect(html).toContain("1.5s");
  });

  test("kicker reflects pass count and date", () => {
    const snap: RunUsageSnapshot = {
      date: "2026-04-26",
      available: true,
      totalInputTokens: 100,
      totalOutputTokens: 100,
      totalUsd: 0.001,
      totalUsdFormatted: "$0.0010",
      passes: [
        {
          pass: "B",
          project: "alpha",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          inputTokens: 100,
          outputTokens: 100,
          usd: 0.001,
          usdFormatted: "$0.0010",
          durationMs: 100,
        },
      ],
    };
    const html = renderRunUsage(snap);
    expect(html).toContain("2026-04-26");
    expect(html).toContain("1 pass"); // singular
  });
});
