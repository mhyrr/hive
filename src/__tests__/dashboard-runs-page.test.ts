import { describe, test, expect } from "bun:test";

import type { CollectedRuns, RunRow } from "../lib/dashboard/runs/collect";
import {
  renderRunsPage,
  renderRunsPageDocument,
} from "../lib/dashboard/runs/render";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    kind: "dispatch",
    id: "RUN-001",
    status: "shipped",
    startedAt: "2026-05-10T10:00:00Z",
    endedAt: "2026-05-10T11:30:00Z",
    elapsedSec: 5400,
    goalSummary: "Implement the thing",
    ...overrides,
  };
}

function makeActiveFixture(): RunRow[] {
  return [
    makeRun({
      id: "RUN-010",
      status: "running",
      kind: "dispatch",
      startedAt: "2026-05-10T14:00:00Z",
      elapsedSec: 1200,
      ticketId: "TK-087",
      goalSummary: "Render /runs index page",
      lastLogLine: "Building component tree...",
    }),
    makeRun({
      id: "CAMP-003",
      status: "running",
      kind: "campaign",
      startedAt: "2026-05-10T13:00:00Z",
      elapsedSec: 4800,
      ticketId: "TK-085",
      goalSummary: "Build /runs dashboard page",
      lastLogLine: "Iteration 3 of 5 — judging...",
    }),
    makeRun({
      id: "RUN-011",
      status: "running",
      kind: "dispatch",
      startedAt: "2026-05-10T14:30:00Z",
      elapsedSec: 300,
      goalSummary: "Fix the broken test",
      lastLogLine: "",
    }),
  ];
}

function makeTerminalFixture(): RunRow[] {
  return [
    makeRun({
      id: "RUN-009",
      status: "shipped",
      kind: "dispatch",
      startedAt: "2026-05-10T09:00:00Z",
      endedAt: "2026-05-10T10:30:00Z",
      elapsedSec: 5400,
      costUsd: 0.56,
      ticketId: "TK-086",
      goalSummary: "Add runs data collector",
    }),
    makeRun({
      id: "RUN-008",
      status: "partial",
      kind: "dispatch",
      startedAt: "2026-05-10T07:00:00Z",
      endedAt: "2026-05-10T08:15:00Z",
      elapsedSec: 4500,
      costUsd: 0.42,
      ticketId: "TK-042",
      goalSummary: "Stack hint rewrite",
    }),
    makeRun({
      id: "RUN-007",
      status: "failed",
      kind: "dispatch",
      startedAt: "2026-05-09T22:00:00Z",
      endedAt: "2026-05-09T22:05:00Z",
      elapsedSec: 300,
      costUsd: 0.08,
      goalSummary: "Broken nightly run",
    }),
    makeRun({
      id: "CAMP-002",
      status: "shipped",
      kind: "campaign",
      startedAt: "2026-05-09T20:00:00Z",
      endedAt: "2026-05-09T21:30:00Z",
      elapsedSec: 5400,
      costUsd: 1.23,
      ticketId: "TK-080",
      goalSummary: "Campaign MCP tool surface",
    }),
    makeRun({
      id: "RUN-006",
      status: "crashed",
      kind: "dispatch",
      startedAt: "2026-05-09T18:00:00Z",
      endedAt: "2026-05-09T18:02:00Z",
      elapsedSec: 120,
      goalSummary: "OAuth token refresh",
    }),
    makeRun({
      id: "RUN-005",
      status: "shipped",
      kind: "dispatch",
      startedAt: "2026-05-09T15:00:00Z",
      endedAt: "2026-05-09T16:45:00Z",
      elapsedSec: 6300,
      costUsd: 0.89,
      ticketId: "TK-038",
      goalSummary: "Stack detection and session-start hint",
    }),
  ];
}

function makeFullFixture(): CollectedRuns {
  return {
    active: makeActiveFixture(),
    terminal: makeTerminalFixture(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderRunsPage", () => {
  test("renders active panel with 3 active runs", () => {
    const data = makeFullFixture();
    const html = renderRunsPage(data);

    // Active panel present
    expect(html).toContain('id="section-active-runs"');
    expect(html).toContain("Active Runs");
    expect(html).toContain("3 in flight");

    // Each active run shows
    expect(html).toContain("RUN-010");
    expect(html).toContain("CAMP-003");
    expect(html).toContain("RUN-011");

    // Kind badges
    expect(html).toContain("dispatch");
    expect(html).toContain("campaign");

    // Ticket link
    expect(html).toContain("TK-087");

    // Elapsed time
    expect(html).toContain("20m");

    // Last log line
    expect(html).toContain("Building component tree...");
    expect(html).toContain("Iteration 3 of 5");
  });

  test("renders terminal timeline with 6 completed runs", () => {
    const data = makeFullFixture();
    const html = renderRunsPage(data);

    // Timeline present
    expect(html).toContain('id="section-terminal-runs"');
    expect(html).toContain("Run History");
    expect(html).toContain("6 completed");

    // Table headers
    expect(html).toContain("<th>Run</th>");
    expect(html).toContain("<th>Kind</th>");
    expect(html).toContain("<th>Status</th>");
    expect(html).toContain("Cost</th>");
    expect(html).toContain("<th>Goal</th>");

    // Run IDs
    expect(html).toContain("RUN-009");
    expect(html).toContain("RUN-008");
    expect(html).toContain("CAMP-002");
    expect(html).toContain("RUN-005");
  });

  test("status badges: shipped gets ink, failed/crashed/partial get rust", () => {
    const data = makeFullFixture();
    const html = renderRunsPage(data);

    // Shipped → run-status-shipped (ink color)
    expect(html).toContain("run-status-shipped");
    // Failed/crashed/partial → run-status-failed (rust color)
    expect(html).toContain("run-status-failed");
  });

  test("cost column renders with dollar formatting", () => {
    const data = makeFullFixture();
    const html = renderRunsPage(data);

    expect(html).toContain("$0.56");
    expect(html).toContain("$1.23");
    expect(html).toContain("$0.89");
    // Missing cost → dash
    expect(html).toMatch(/class="num mono">\s*—\s*<\/td>/);
  });

  test("per-run links point to /runs/{id}", () => {
    const data = makeFullFixture();
    const html = renderRunsPage(data);

    expect(html).toContain('href="/runs/RUN-010"');
    expect(html).toContain('href="/runs/RUN-009"');
    expect(html).toContain('href="/runs/CAMP-002"');
  });

  test("empty active: shows 'No runs in flight'", () => {
    const data: CollectedRuns = { active: [], terminal: makeTerminalFixture() };
    const html = renderRunsPage(data);

    expect(html).toContain("No runs in flight.");
    expect(html).not.toContain("active-run-row");
  });

  test("empty terminal: shows 'No completed runs yet'", () => {
    const data: CollectedRuns = { active: makeActiveFixture(), terminal: [] };
    const html = renderRunsPage(data);

    expect(html).toContain("No completed runs yet.");
    expect(html).not.toContain("timeline-row");
  });

  test("both empty: both empty states render", () => {
    const data: CollectedRuns = { active: [], terminal: [] };
    const html = renderRunsPage(data);

    expect(html).toContain("No runs in flight.");
    expect(html).toContain("No completed runs yet.");
  });

  test("goal summary is truncated", () => {
    const longGoal = "A".repeat(200);
    const data: CollectedRuns = {
      active: [],
      terminal: [makeRun({ goalSummary: longGoal })],
    };
    const html = renderRunsPage(data);

    // Should be truncated — won't contain the full 200-char string
    expect(html).not.toContain(longGoal);
    expect(html).toContain("…");
  });

  test("active run with no lastLogLine shows placeholder", () => {
    const data: CollectedRuns = {
      active: [makeRun({ id: "RUN-099", status: "running", lastLogLine: "" })],
      terminal: [],
    };
    const html = renderRunsPage(data);
    expect(html).toContain("no output yet");
  });

  test("ticket-less runs show dash", () => {
    const data: CollectedRuns = {
      active: [makeRun({ id: "RUN-099", status: "running", ticketId: undefined })],
      terminal: [makeRun({ id: "RUN-098", ticketId: undefined })],
    };
    const html = renderRunsPage(data);

    // Both active and terminal should have a muted dash
    const dashes = html.match(/runs-muted/g);
    expect(dashes).not.toBeNull();
    expect(dashes!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("renderRunsPageDocument", () => {
  test("emits a full HTML document with RUNS active in nav", () => {
    const data = makeFullFixture();
    const html = renderRunsPageDocument(data);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>HIVE · Runs");
    expect(html).toContain('class="page-nav"');
    expect(html).toContain('<a href="/runs" class="nav-active">RUNS</a>');
    expect(html).toContain('<a href="/">BRIEFING</a>');
    expect(html).toContain('<a href="/tickets">TICKETS</a>');
  });

  test("includes CSS and JS in interactive mode", () => {
    const data = makeFullFixture();
    const html = renderRunsPageDocument(data, { interactive: true });

    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });

  test("omits JS in non-interactive mode", () => {
    const data = makeFullFixture();
    const html = renderRunsPageDocument(data, { interactive: false });

    expect(html).toContain("<style>");
    expect(html).not.toContain("<script>");
  });

  test("uses page-wide layout", () => {
    const data = makeFullFixture();
    const html = renderRunsPageDocument(data);
    expect(html).toContain("page-wide");
  });

  // Snapshot test: 3 active + 6 terminal fixture
  test("snapshot: 3-active / 6-terminal fixture", () => {
    const data = makeFullFixture();
    const html = renderRunsPage(data);

    // Structural invariants that a snapshot would catch:

    // 3 active rows
    const activeRowCount = (html.match(/class="active-run-row"/g) || []).length;
    expect(activeRowCount).toBe(3);

    // 6 terminal rows
    const timelineRowCount = (html.match(/class="timeline-row"/g) || []).length;
    expect(timelineRowCount).toBe(6);

    // All expected run IDs present
    const expectedIds = [
      "RUN-010", "CAMP-003", "RUN-011",
      "RUN-009", "RUN-008", "RUN-007", "CAMP-002", "RUN-006", "RUN-005",
    ];
    for (const id of expectedIds) {
      expect(html).toContain(id);
    }

    // Both section headers present
    expect(html).toContain("Active Runs");
    expect(html).toContain("Run History");

    // Cost column values
    expect(html).toContain("$0.56");
    expect(html).toContain("$0.42");
    expect(html).toContain("$0.08");
    expect(html).toContain("$1.23");
    expect(html).toContain("$0.89");
  });
});
