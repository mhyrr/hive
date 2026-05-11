import { describe, test, expect } from "bun:test";

import type {
  Arc,
  GoalArc,
  CampaignArc,
  DirectArc,
  RunRow,
  GoalArcChild,
} from "../lib/dashboard/runs/collect";
import type { Ticket, TicketWithBody } from "../lib/ticket";
import {
  renderArcRunsPage,
  renderArcRunsPageDocument,
} from "../lib/dashboard/runs/render";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeTicket(overrides: Partial<TicketWithBody> = {}): TicketWithBody {
  return {
    id: "TK-100",
    title: "Test ticket",
    type: "task",
    status: "open",
    priority: 2,
    tags: [],
    depends: [],
    created: "2026-05-10T10:00:00Z",
    updated: "2026-05-10T10:00:00Z",
    project: "hive",
    body: "",
    ...overrides,
  };
}

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
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

function makeGoalArc(overrides: Partial<GoalArc> = {}): GoalArc {
  return {
    kind: "goal",
    epic: makeTicket({
      id: "TK-090",
      title: "Build /runs page",
      type: "epic",
      status: "open",
      created: "2026-05-10T08:00:00Z",
      updated: "2026-05-10T12:00:00Z",
      body: "## Goal\nBuild an arc-first runs page.\n\n## Children\n- TK-091\n- TK-092",
    }),
    children: [
      {
        ticket: makeTicket({
          id: "TK-091",
          title: "Collect runs data",
          status: "closed",
          parentEpic: "TK-090",
        }),
        runs: [{ id: "RUN-010", status: "shipped" }],
      },
      {
        ticket: makeTicket({
          id: "TK-092",
          title: "Render runs page",
          status: "in_progress",
          parentEpic: "TK-090",
        }),
        runs: [{ id: "RUN-011", status: "running" }],
      },
    ],
    totalCost: null,
    runCount: 2,
    status: "in-flight",
    ...overrides,
  };
}

function makeCampaignArc(overrides: Partial<CampaignArc> = {}): CampaignArc {
  return {
    kind: "campaign",
    campaign: makeRunRow({
      kind: "campaign",
      id: "CAMP-003",
      status: "shipped",
      startedAt: "2026-05-09T20:00:00Z",
      endedAt: "2026-05-09T22:00:00Z",
      elapsedSec: 7200,
      goalSummary: "Optimize frozen prefix cache",
    }),
    iterations: [
      {
        iterationN: 1,
        exitReason: "complete",
        judgeDecision: "accept",
        cost: 0.45,
        elapsedSec: 3600,
      },
      {
        iterationN: 2,
        exitReason: "complete",
        judgeDecision: "done",
        cost: 0.38,
        elapsedSec: 3600,
      },
    ],
    totalCost: 0.83,
    iterationCount: 2,
    status: "shipped",
    goal: "Optimize frozen prefix cache for better hit rate",
    frozenPrefix: null,
    finalArtifact: null,
    ...overrides,
  };
}

function makeDirectArc(overrides: Partial<DirectArc> = {}): DirectArc {
  return {
    kind: "direct",
    run: makeRunRow({
      id: "RUN-020",
      status: "shipped",
      startedAt: "2026-05-10T06:00:00Z",
      endedAt: "2026-05-10T07:00:00Z",
      elapsedSec: 3600,
      goalSummary: "Fix broken nightly",
      ticketId: "TK-050",
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Day grouping tests
// ---------------------------------------------------------------------------

describe("renderArcRunsPage — day grouping", () => {
  test("arcs from different days appear under separate day headings", () => {
    const arcs: Arc[] = [
      makeGoalArc({
        epic: makeTicket({
          id: "TK-090",
          title: "May 10 goal",
          type: "epic",
          created: "2026-05-10T08:00:00Z",
          updated: "2026-05-10T12:00:00Z",
          body: "Goal body",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
      makeCampaignArc({
        campaign: makeRunRow({
          kind: "campaign",
          id: "CAMP-003",
          status: "shipped",
          startedAt: "2026-05-09T20:00:00Z",
          goalSummary: "May 9 campaign",
        }),
      }),
    ];

    const html = renderArcRunsPage(arcs);

    // Two day headings
    expect(html).toContain("day-heading");
    // May 10 heading comes first (newest first)
    const may10Idx = html.indexOf("May 10, 2026");
    const may9Idx = html.indexOf("May 9, 2026");
    expect(may10Idx).toBeGreaterThanOrEqual(0);
    expect(may9Idx).toBeGreaterThanOrEqual(0);
    expect(may10Idx).toBeLessThan(may9Idx);
  });

  test("arcs on the same day appear in the same group", () => {
    const arcs: Arc[] = [
      makeGoalArc({
        epic: makeTicket({
          id: "TK-090",
          title: "Morning goal",
          type: "epic",
          created: "2026-05-10T08:00:00Z",
          updated: "2026-05-10T12:00:00Z",
          body: "Goal body",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
      makeCampaignArc({
        campaign: makeRunRow({
          kind: "campaign",
          id: "CAMP-005",
          status: "shipped",
          startedAt: "2026-05-10T14:00:00Z",
          goalSummary: "Afternoon campaign",
        }),
      }),
    ];

    const html = renderArcRunsPage(arcs);

    // Only one day-group (both arcs on May 10)
    const dayGroups = html.match(/class="day-group"/g) || [];
    expect(dayGroups.length).toBe(1);
    expect(html).toContain("Morning goal");
    expect(html).toContain("CAMP-005");
  });

  test("days with no arcs are not rendered (no empty placeholders)", () => {
    // Only May 10 arcs — May 9, 8, etc. should not appear
    const arcs: Arc[] = [
      makeGoalArc({
        epic: makeTicket({
          id: "TK-090",
          title: "Only goal",
          type: "epic",
          created: "2026-05-10T08:00:00Z",
          updated: "2026-05-10T12:00:00Z",
          body: "",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
    ];

    const html = renderArcRunsPage(arcs);

    const dayGroups = html.match(/class="day-group"/g) || [];
    expect(dayGroups.length).toBe(1);
    // No May 9 heading
    expect(html).not.toContain("May 9");
  });
});

// ---------------------------------------------------------------------------
// Active bubbling tests
// ---------------------------------------------------------------------------

describe("renderArcRunsPage — active bubbling", () => {
  test("active arcs appear before inactive within the same day", () => {
    const arcs: Arc[] = [
      // Inactive goal arc — started earlier
      makeGoalArc({
        epic: makeTicket({
          id: "TK-080",
          title: "Shipped goal (earlier)",
          type: "epic",
          created: "2026-05-10T06:00:00Z",
          updated: "2026-05-10T10:00:00Z",
          body: "",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
      // Active goal arc — started later
      makeGoalArc({
        epic: makeTicket({
          id: "TK-090",
          title: "Active goal (later)",
          type: "epic",
          created: "2026-05-10T10:00:00Z",
          updated: "2026-05-10T12:00:00Z",
          body: "",
        }),
        children: [],
        runCount: 1,
        status: "in-flight",
      }),
    ];

    const html = renderArcRunsPage(arcs);

    // Active arc should appear first in the HTML
    const activeIdx = html.indexOf("Active goal (later)");
    const shippedIdx = html.indexOf("Shipped goal (earlier)");
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(shippedIdx).toBeGreaterThanOrEqual(0);
    expect(activeIdx).toBeLessThan(shippedIdx);
  });

  test("active campaign arc bubbles above shipped goal arc on same day", () => {
    const arcs: Arc[] = [
      makeGoalArc({
        epic: makeTicket({
          id: "TK-080",
          title: "Shipped goal",
          type: "epic",
          created: "2026-05-10T12:00:00Z",
          updated: "2026-05-10T14:00:00Z",
          body: "",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
      makeCampaignArc({
        campaign: makeRunRow({
          kind: "campaign",
          id: "CAMP-010",
          status: "running",
          startedAt: "2026-05-10T08:00:00Z",
          goalSummary: "Running campaign",
        }),
        status: "in-flight",
      }),
    ];

    const html = renderArcRunsPage(arcs);

    const campaignIdx = html.indexOf("CAMP-010");
    const goalIdx = html.indexOf("Shipped goal");
    expect(campaignIdx).toBeLessThan(goalIdx);
  });
});

// ---------------------------------------------------------------------------
// Direct dispatches section
// ---------------------------------------------------------------------------

describe("renderArcRunsPage — direct dispatches", () => {
  test("direct dispatches appear as a single section below day groups", () => {
    const arcs: Arc[] = [
      makeGoalArc({
        epic: makeTicket({
          id: "TK-090",
          title: "Goal arc",
          type: "epic",
          created: "2026-05-10T08:00:00Z",
          updated: "2026-05-10T12:00:00Z",
          body: "",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
      makeDirectArc(),
    ];

    const html = renderArcRunsPage(arcs);

    // Day group comes first
    const dayGroupIdx = html.indexOf("day-group");
    const directIdx = html.indexOf("direct-section");
    expect(dayGroupIdx).toBeGreaterThanOrEqual(0);
    expect(directIdx).toBeGreaterThanOrEqual(0);
    expect(dayGroupIdx).toBeLessThan(directIdx);

    // Direct dispatch run ID present
    expect(html).toContain("RUN-020");
  });

  test("direct dispatches section hidden when there are none", () => {
    const arcs: Arc[] = [
      makeGoalArc({
        epic: makeTicket({
          id: "TK-090",
          title: "Goal only",
          type: "epic",
          created: "2026-05-10T08:00:00Z",
          updated: "2026-05-10T12:00:00Z",
          body: "",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
    ];

    const html = renderArcRunsPage(arcs);
    expect(html).not.toContain("direct-section");
  });

  test("only direct dispatches (no goal/campaign arcs)", () => {
    const arcs: Arc[] = [
      makeDirectArc({ run: makeRunRow({ id: "RUN-020" }) }),
      makeDirectArc({ run: makeRunRow({ id: "RUN-021", startedAt: "2026-05-10T07:00:00Z" }) }),
    ];

    const html = renderArcRunsPage(arcs);

    // No day groups (only directs, which aren't grouped by day)
    expect(html).not.toContain("day-group");
    // Empty state for arcs
    expect(html).toContain("No arcs to display");
    // Direct section present
    expect(html).toContain("direct-section");
    expect(html).toContain("RUN-020");
    expect(html).toContain("RUN-021");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("renderArcRunsPage — empty state", () => {
  test("no arcs at all shows empty message and no direct section", () => {
    const html = renderArcRunsPage([]);

    expect(html).toContain("No arcs to display");
    expect(html).not.toContain("day-group");
    expect(html).not.toContain("direct-section");
  });
});

// ---------------------------------------------------------------------------
// Document wrapper
// ---------------------------------------------------------------------------

describe("renderArcRunsPageDocument", () => {
  test("wraps body in full HTML with nav, masthead, CSS, JS", () => {
    const arcs: Arc[] = [makeGoalArc()];
    const html = renderArcRunsPageDocument(arcs);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>HIVE · Runs");
    expect(html).toContain('class="page-nav"');
    expect(html).toContain('<a href="/runs" class="nav-active">RUNS</a>');
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });

  test("uses page-wide layout", () => {
    const arcs: Arc[] = [makeGoalArc()];
    const html = renderArcRunsPageDocument(arcs);
    expect(html).toContain("page page-wide");
  });

  test("omits JS in non-interactive mode", () => {
    const arcs: Arc[] = [makeGoalArc()];
    const html = renderArcRunsPageDocument(arcs, { interactive: false });
    expect(html).not.toContain("<script>");
  });

  test("includes masthead with date", () => {
    const arcs: Arc[] = [makeGoalArc()];
    const html = renderArcRunsPageDocument(arcs);
    expect(html).toContain("class=\"masthead\"");
    expect(html).toContain("Runs");
  });
});

// ---------------------------------------------------------------------------
// Deep link preservation
// ---------------------------------------------------------------------------

describe("renderArcRunsPage — deep links", () => {
  test("goal arc children link to /runs/:id", () => {
    const arc = makeGoalArc();
    const html = renderArcRunsPage([arc]);

    expect(html).toContain('href="/runs/RUN-010"');
    expect(html).toContain('href="/runs/RUN-011"');
  });

  test("direct dispatch rows link to /runs/:id", () => {
    const direct = makeDirectArc();
    const html = renderArcRunsPage([direct]);

    expect(html).toContain('href="/runs/RUN-020"');
  });

  test("campaign arc card links to /runs/:id via campaign id", () => {
    // Campaign arcs don't have individual run links in their card,
    // but they should still be identifiable
    const arc = makeCampaignArc();
    const html = renderArcRunsPage([arc]);

    expect(html).toContain("CAMP-003");
  });
});

// ---------------------------------------------------------------------------
// Mixed arcs in single day
// ---------------------------------------------------------------------------

describe("renderArcRunsPage — mixed arc types", () => {
  test("goal and campaign arcs intermixed within a day by sort order", () => {
    const arcs: Arc[] = [
      makeGoalArc({
        epic: makeTicket({
          id: "TK-090",
          title: "Goal at noon",
          type: "epic",
          created: "2026-05-10T12:00:00Z",
          updated: "2026-05-10T14:00:00Z",
          body: "",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
      makeCampaignArc({
        campaign: makeRunRow({
          kind: "campaign",
          id: "CAMP-005",
          status: "shipped",
          startedAt: "2026-05-10T14:00:00Z",
          goalSummary: "Campaign in afternoon",
        }),
      }),
      makeGoalArc({
        epic: makeTicket({
          id: "TK-091",
          title: "Goal in morning",
          type: "epic",
          created: "2026-05-10T06:00:00Z",
          updated: "2026-05-10T08:00:00Z",
          body: "",
        }),
        children: [],
        runCount: 0,
        status: "shipped",
      }),
    ];

    const html = renderArcRunsPage(arcs);

    // One day group
    const dayGroups = html.match(/class="day-group"/g) || [];
    expect(dayGroups.length).toBe(1);

    // All three arcs sorted newest-first: CAMP-005 (14:00) > TK-090 (12:00) > TK-091 (06:00)
    const campIdx = html.indexOf("CAMP-005");
    const goal1Idx = html.indexOf("Goal at noon");
    const goal2Idx = html.indexOf("Goal in morning");
    expect(campIdx).toBeLessThan(goal1Idx);
    expect(goal1Idx).toBeLessThan(goal2Idx);
  });
});
