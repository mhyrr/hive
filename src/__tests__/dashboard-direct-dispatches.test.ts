import { describe, test, expect } from "bun:test";

import { renderDirectDispatches } from "../lib/dashboard/runs/render";
import type { DirectArc, RunRow } from "../lib/dashboard/runs/collect";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    kind: "dispatch",
    id: "RUN-010",
    status: "shipped",
    startedAt: "2026-05-10T02:00:00.000Z",
    endedAt: "2026-05-10T03:30:00.000Z",
    elapsedSec: 5400,
    ticketId: "TK-050",
    goalSummary: "Implement the widget layer",
    ...overrides,
  };
}

function makeDirect(overrides: Partial<RunRow> = {}): DirectArc {
  return { kind: "direct", run: makeRunRow(overrides) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderDirectDispatches", () => {
  // ------ Empty state ------

  test("returns empty string when no direct dispatches", () => {
    const html = renderDirectDispatches([]);
    expect(html).toBe("");
  });

  // ------ Section heading ------

  test("renders section heading when directs exist", () => {
    const html = renderDirectDispatches([makeDirect()]);
    expect(html).toContain("direct-section-head");
    expect(html).toContain("Direct dispatches");
  });

  test("section has id for anchor linking", () => {
    const html = renderDirectDispatches([makeDirect()]);
    expect(html).toContain('id="section-direct-dispatches"');
  });

  // ------ Row content ------

  test("row contains run id with link", () => {
    const html = renderDirectDispatches([makeDirect({ id: "RUN-042" })]);
    expect(html).toContain("RUN-042");
    expect(html).toContain('href="/runs/RUN-042"');
  });

  test("row contains ticket id with link to tickets page", () => {
    const html = renderDirectDispatches([makeDirect({ ticketId: "TK-088" })]);
    expect(html).toContain("TK-088");
    expect(html).toContain('href="/tickets#TK-088"');
  });

  test("row shows dash when no ticket id", () => {
    const html = renderDirectDispatches([
      makeDirect({ ticketId: undefined }),
    ]);
    expect(html).toContain("direct-muted");
  });

  test("row contains goal summary as title", () => {
    const html = renderDirectDispatches([
      makeDirect({ goalSummary: "Fix the deployment bug" }),
    ]);
    expect(html).toContain("Fix the deployment bug");
  });

  test("row contains status badge", () => {
    const html = renderDirectDispatches([makeDirect({ status: "shipped" })]);
    expect(html).toContain("chip-shipped");
    expect(html).toContain("shipped");
  });

  test("failed status renders with failed chip", () => {
    const html = renderDirectDispatches([makeDirect({ status: "failed" })]);
    expect(html).toContain("chip-failed");
  });

  test("running status renders with running chip", () => {
    const html = renderDirectDispatches([makeDirect({ status: "running" })]);
    expect(html).toContain("chip-running");
  });

  test("row contains formatted elapsed time", () => {
    const html = renderDirectDispatches([makeDirect({ elapsedSec: 5400 })]);
    expect(html).toContain("1h 30m");
  });

  test("row contains formatted start time", () => {
    const html = renderDirectDispatches([
      makeDirect({ startedAt: "2026-05-10T14:30:00.000Z" }),
    ]);
    // Should contain a human-readable date
    expect(html).toContain("May 10");
  });

  // ------ Table structure ------

  test("renders thead with column headers", () => {
    const html = renderDirectDispatches([makeDirect()]);
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>Run</th>");
    expect(html).toContain("<th>Ticket</th>");
    expect(html).toContain("<th>Title</th>");
    expect(html).toContain("<th>Status</th>");
    expect(html).toContain("<th>Elapsed</th>");
    expect(html).toContain("<th>Started</th>");
  });

  test("renders table with direct-table class", () => {
    const html = renderDirectDispatches([makeDirect()]);
    expect(html).toContain("direct-table");
  });

  // ------ Sort order ------

  test("sorts by start time descending (newest first)", () => {
    const directs: DirectArc[] = [
      makeDirect({ id: "RUN-001", startedAt: "2026-05-08T10:00:00.000Z" }),
      makeDirect({ id: "RUN-003", startedAt: "2026-05-10T10:00:00.000Z" }),
      makeDirect({ id: "RUN-002", startedAt: "2026-05-09T10:00:00.000Z" }),
    ];

    const html = renderDirectDispatches(directs);

    const run1Pos = html.indexOf("RUN-001");
    const run2Pos = html.indexOf("RUN-002");
    const run3Pos = html.indexOf("RUN-003");

    // RUN-003 (newest) should appear before RUN-002, which appears before RUN-001
    expect(run3Pos).toBeLessThan(run2Pos);
    expect(run2Pos).toBeLessThan(run1Pos);
  });

  // ------ Multiple rows ------

  test("renders multiple rows", () => {
    const directs: DirectArc[] = [
      makeDirect({ id: "RUN-010" }),
      makeDirect({ id: "RUN-011" }),
      makeDirect({ id: "RUN-012" }),
    ];

    const html = renderDirectDispatches(directs);
    expect(html).toContain("RUN-010");
    expect(html).toContain("RUN-011");
    expect(html).toContain("RUN-012");
  });

  // ------ HTML safety ------

  test("escapes HTML in goal summary", () => {
    const html = renderDirectDispatches([
      makeDirect({ goalSummary: "<script>alert('xss')</script>" }),
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes HTML in run id", () => {
    const html = renderDirectDispatches([
      makeDirect({ id: 'RUN-"bad"' as any }),
    ]);
    expect(html).not.toContain('"bad"');
    expect(html).toContain("&quot;bad&quot;");
  });

  // ------ Visual weight ------

  test("uses direct-section class (quieter than arc cards)", () => {
    const html = renderDirectDispatches([makeDirect()]);
    expect(html).toContain("direct-section");
    // Should NOT contain arc-card class — these are NOT arc cards
    expect(html).not.toContain("arc-card");
  });

  test("rows use direct-row class for tighter styling", () => {
    const html = renderDirectDispatches([makeDirect()]);
    expect(html).toContain("direct-row");
  });

  // ------ Truncation ------

  test("truncates long goal summaries", () => {
    const longGoal = "A".repeat(200);
    const html = renderDirectDispatches([
      makeDirect({ goalSummary: longGoal }),
    ]);
    // Should be truncated (100 char limit in the renderer)
    expect(html).not.toContain(longGoal);
  });
});
