/**
 * Tests for TK-103: Surface failure reason inline on failed arcs.
 *
 * Covers:
 *   - renderWhyFailed block rendering
 *   - renderWhyFailedInline for child rows and direct dispatches
 *   - Campaign arc with error.txt → shows error text
 *   - Campaign arc without artifacts → shows fallback
 *   - Goal arc with one failed child → child row has failure reason
 *   - Direct dispatch with failed status → row has failure reason
 *   - Campaign with scorecard-only failure source
 */

import { describe, test, expect } from "bun:test";

import type {
  CampaignArc,
  CampaignIteration,
  DirectArc,
  GoalArc,
  RunRow,
  GoalArcChild,
  RunRef,
} from "../lib/dashboard/runs/collect";
import type { TicketWithBody } from "../lib/ticket";
import {
  renderWhyFailed,
  renderWhyFailedInline,
  renderCampaignArc,
  renderGoalArc,
  renderDirectDispatches,
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

function makeRunRef(overrides: Partial<RunRef> = {}): RunRef {
  return {
    id: "RUN-010",
    status: "shipped",
    ...overrides,
  };
}

function makeCampaignArc(overrides: Partial<CampaignArc> = {}): CampaignArc {
  return {
    kind: "campaign",
    campaign: makeRunRow({
      kind: "campaign",
      id: "CAMP-004",
      status: "failed",
      startedAt: "2026-05-09T20:00:00Z",
      endedAt: "2026-05-09T20:05:00Z",
      elapsedSec: 300,
      goalSummary: "Run a campaign that fails",
    }),
    iterations: [],
    totalCost: 0,
    iterationCount: 0,
    status: "blocked",
    goal: "Run a campaign that fails",
    frozenPrefix: null,
    finalArtifact: null,
    failureReason: null,
    ...overrides,
  };
}

function makeGoalArc(overrides: Partial<GoalArc> = {}): GoalArc {
  return {
    kind: "goal",
    epic: makeTicket({
      id: "TK-090",
      title: "Build something",
      type: "epic",
      status: "open",
      created: "2026-05-10T08:00:00Z",
      updated: "2026-05-10T12:00:00Z",
      body: "## Goal\nBuild something.\n\n## Children\n- TK-091",
    }),
    children: [],
    totalCost: null,
    runCount: 0,
    status: "mixed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderWhyFailed block tests
// ---------------------------------------------------------------------------

describe("renderWhyFailed", () => {
  test("returns empty string for null reason", () => {
    expect(renderWhyFailed(null)).toBe("");
  });

  test("returns empty string for undefined reason", () => {
    expect(renderWhyFailed(undefined)).toBe("");
  });

  test("returns empty string for empty string reason", () => {
    expect(renderWhyFailed("")).toBe("");
  });

  test("renders block with rust-colored label and monospace body", () => {
    const html = renderWhyFailed("Connection refused");
    expect(html).toContain("why-failed");
    expect(html).toContain("Why Failed");
    expect(html).toContain("why-failed-body");
    expect(html).toContain("Connection refused");
    expect(html).toContain("data-why-failed");
  });

  test("escapes HTML in reason", () => {
    const html = renderWhyFailed("<script>alert('xss')</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  test("preserves multiline reason in body", () => {
    const reason = "Error: ENOENT\n  at readFile (/path/to.ts:42)\n  at main (/entry.ts:10)";
    const html = renderWhyFailed(reason);
    expect(html).toContain("ENOENT");
    expect(html).toContain("readFile");
    expect(html).toContain("main");
  });

  test("includes click-to-expand toggle", () => {
    const html = renderWhyFailed("some error");
    expect(html).toContain("why-failed-toggle");
    expect(html).toContain("click to expand");
  });
});

// ---------------------------------------------------------------------------
// renderWhyFailedInline tests
// ---------------------------------------------------------------------------

describe("renderWhyFailedInline", () => {
  test("returns empty string for null", () => {
    expect(renderWhyFailedInline(null)).toBe("");
  });

  test("renders inline span with last meaningful line", () => {
    const html = renderWhyFailedInline("line 1\nline 2\nfinal error");
    expect(html).toContain("why-failed-inline");
    expect(html).toContain("final error");
    expect(html).toContain("data-why-failed-inline");
  });

  test("includes full reason as title attribute", () => {
    const reason = "first\nsecond\nthird";
    const html = renderWhyFailedInline(reason);
    expect(html).toContain("title=");
    expect(html).toContain("first");
  });
});

// ---------------------------------------------------------------------------
// Campaign arc with error.txt
// ---------------------------------------------------------------------------

describe("campaign arc — failure reason rendering", () => {
  test("campaign with error.txt shows failure block", () => {
    const arc = makeCampaignArc({
      failureReason: "Orchestrator crashed: ENOMEM",
    });
    const html = renderCampaignArc(arc);
    expect(html).toContain("why-failed");
    expect(html).toContain("Why Failed");
    expect(html).toContain("Orchestrator crashed: ENOMEM");
  });

  test("campaign without artifacts shows fallback message", () => {
    const arc = makeCampaignArc({
      failureReason: "Campaign failed before iteration 1 started — no error log captured",
    });
    const html = renderCampaignArc(arc);
    expect(html).toContain("why-failed");
    expect(html).toContain("no error log captured");
  });

  test("shipped campaign shows no failure block", () => {
    const arc = makeCampaignArc({
      status: "shipped",
      campaign: makeRunRow({
        kind: "campaign",
        id: "CAMP-002",
        status: "shipped",
        startedAt: "2026-05-09T20:00:00Z",
        elapsedSec: 7200,
        goalSummary: "Shipped campaign",
      }),
      failureReason: null,
    });
    const html = renderCampaignArc(arc);
    expect(html).not.toContain("why-failed");
  });

  test("campaign with scorecard-based failure reason", () => {
    const arc = makeCampaignArc({
      failureReason: "exit: budget-exhausted · judge: abort",
      iterations: [
        { iterationN: 1, exitReason: "budget-exhausted", judgeDecision: "abort", cost: 5.0, elapsedSec: 600 },
      ],
      iterationCount: 1,
    });
    const html = renderCampaignArc(arc);
    expect(html).toContain("why-failed");
    expect(html).toContain("budget-exhausted");
    expect(html).toContain("abort");
  });

  test("why-failed block appears before the goal block", () => {
    const arc = makeCampaignArc({
      failureReason: "Some error message",
      goal: "The campaign goal text",
    });
    const html = renderCampaignArc(arc);
    const whyIdx = html.indexOf("why-failed");
    const goalIdx = html.indexOf("The campaign goal text");
    expect(whyIdx).toBeLessThan(goalIdx);
  });
});

// ---------------------------------------------------------------------------
// Goal arc with failed child
// ---------------------------------------------------------------------------

describe("goal arc — failed child inline reason", () => {
  test("failed child shows inline failure reason", () => {
    const arc = makeGoalArc({
      children: [
        {
          ticket: makeTicket({
            id: "TK-091",
            title: "Child that failed",
            status: "open",
            parentEpic: "TK-090",
          }),
          runs: [
            makeRunRef({
              id: "RUN-015",
              status: "failed",
              failureReason: "Error: connection refused",
            }),
          ],
        },
        {
          ticket: makeTicket({
            id: "TK-092",
            title: "Child that shipped",
            status: "closed",
            parentEpic: "TK-090",
          }),
          runs: [makeRunRef({ id: "RUN-016", status: "shipped" })],
        },
      ],
      runCount: 2,
    });
    const html = renderGoalArc(arc);
    expect(html).toContain("why-failed-inline");
    expect(html).toContain("connection refused");
    expect(html).toContain("arc-child-failure");
  });

  test("shipped children show no failure inline", () => {
    const arc = makeGoalArc({
      children: [
        {
          ticket: makeTicket({
            id: "TK-091",
            title: "Shipped child",
            status: "closed",
            parentEpic: "TK-090",
          }),
          runs: [makeRunRef({ id: "RUN-015", status: "shipped" })],
        },
      ],
      runCount: 1,
    });
    const html = renderGoalArc(arc);
    expect(html).not.toContain("why-failed-inline");
    expect(html).not.toContain("arc-child-failure");
  });
});

// ---------------------------------------------------------------------------
// Direct dispatches with failure reason
// ---------------------------------------------------------------------------

describe("direct dispatches — failure reason", () => {
  test("failed dispatch shows inline failure reason", () => {
    const directs: DirectArc[] = [
      {
        kind: "direct",
        run: makeRunRow({
          id: "RUN-020",
          status: "failed",
          startedAt: "2026-05-10T06:00:00Z",
          elapsedSec: 600,
          goalSummary: "Fix broken thing",
          failureReason: "TypeError: undefined is not a function",
        }),
      },
    ];
    const html = renderDirectDispatches(directs);
    expect(html).toContain("why-failed-inline");
    expect(html).toContain("undefined is not a function");
    expect(html).toContain("Reason"); // header column
  });

  test("shipped dispatch shows no failure reason", () => {
    const directs: DirectArc[] = [
      {
        kind: "direct",
        run: makeRunRow({
          id: "RUN-021",
          status: "shipped",
          startedAt: "2026-05-10T06:00:00Z",
          elapsedSec: 3600,
          goalSummary: "Ship something",
        }),
      },
    ];
    const html = renderDirectDispatches(directs);
    expect(html).not.toContain("why-failed-inline");
  });

  test("crashed dispatch shows failure reason from last log lines", () => {
    const directs: DirectArc[] = [
      {
        kind: "direct",
        run: makeRunRow({
          id: "RUN-022",
          status: "crashed",
          startedAt: "2026-05-10T06:00:00Z",
          elapsedSec: 120,
          goalSummary: "Crashed dispatch",
          failureReason: "SIGKILL: process was killed",
        }),
      },
    ];
    const html = renderDirectDispatches(directs);
    expect(html).toContain("why-failed-inline");
    expect(html).toContain("SIGKILL");
  });
});
