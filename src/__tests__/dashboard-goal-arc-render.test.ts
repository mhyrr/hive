import { describe, test, expect } from "bun:test";

import { renderGoalArc } from "../lib/dashboard/runs/render";
import type { GoalArc, GoalArcChild, ArcStatus } from "../lib/dashboard/runs/collect";
import type { TicketWithBody } from "../lib/ticket";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEpic(overrides: Partial<TicketWithBody> = {}): TicketWithBody {
  return {
    id: "TK-010",
    title: "Redesign the frobnitz subsystem",
    status: "open",
    type: "epic",
    priority: 2,
    tags: ["dashboard"],
    created: "2026-05-01T10:00:00Z",
    updated: "2026-05-09T22:00:00Z",
    closed: null,
    ref: null,
    depends: [],
    parentEpic: null,
    body: `## Goal
Replace the old frobnitz with a new one that handles edge cases.

## Why
The current frobnitz is brittle and breaks under load.

## Children
- TK-011 — First child
- TK-012 — Second child`,
    ...overrides,
  };
}

function makeChild(
  id: string,
  title: string,
  status: "open" | "in_progress" | "closed" = "open",
  runs: GoalArcChild["runs"] = [],
): GoalArcChild {
  return {
    ticket: {
      id,
      title,
      status,
      type: "task",
      priority: 2,
      tags: [],
      created: "2026-05-01T12:00:00Z",
      updated: "2026-05-05T15:00:00Z",
      closed: status === "closed" ? "2026-05-05T15:00:00Z" : null,
      ref: null,
      depends: [],
      parentEpic: "TK-010",
    },
    runs,
  };
}

function makeArc(overrides: Partial<GoalArc> = {}): GoalArc {
  return {
    kind: "goal",
    epic: makeEpic(),
    children: [
      makeChild("TK-011", "First child task", "closed", [
        { id: "RUN-001", status: "shipped" },
      ]),
      makeChild("TK-012", "Second child task", "in_progress", [
        { id: "RUN-002", status: "running" },
      ]),
    ],
    totalCost: null,
    runCount: 2,
    status: "in-flight",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderGoalArc", () => {
  test("produces an arc-card with correct structure", () => {
    const html = renderGoalArc(makeArc());

    // Top-level card
    expect(html).toContain('class="arc-card"');
    expect(html).toContain('data-arc-kind="goal"');
    expect(html).toContain('id="arc-goal-TK-010"');

    // Header elements
    expect(html).toContain('class="arc-header"');
    expect(html).toContain('class="arc-expand">+</span>');
    expect(html).toContain("Redesign the frobnitz subsystem");
  });

  test("header shows status chip with correct class", () => {
    const html = renderGoalArc(makeArc({ status: "in-flight" }));
    expect(html).toContain("chip-in-flight");
    expect(html).toContain("in-flight");
  });

  test("status chip classes for each status", () => {
    const statuses: ArcStatus[] = ["shipped", "in-flight", "blocked", "mixed"];
    const expectedClasses = ["chip-shipped", "chip-in-flight", "chip-blocked", "chip-mixed"];

    for (let i = 0; i < statuses.length; i++) {
      const html = renderGoalArc(makeArc({ status: statuses[i] }));
      expect(html).toContain(expectedClasses[i]);
    }
  });

  test("header shows run count", () => {
    const html = renderGoalArc(makeArc({ runCount: 5 }));
    expect(html).toContain("5 runs");
  });

  test("header shows '1 run' singular", () => {
    const html = renderGoalArc(makeArc({ runCount: 1 }));
    expect(html).toContain("1 run");
    expect(html).not.toContain("1 runs");
  });

  test("header shows cost as dash when null", () => {
    const html = renderGoalArc(makeArc({ totalCost: null }));
    // The cost meta span should contain a dash
    expect(html).toMatch(/arc-meta[^>]*>[^<]*—/);
  });

  test("header shows start and last-activity dates", () => {
    const html = renderGoalArc(makeArc());
    expect(html).toContain("May 1");
  });

  test("body contains 'Original Ask' section with first paragraph", () => {
    const html = renderGoalArc(makeArc());
    expect(html).toContain("Original Ask");
    expect(html).toContain("Replace the old frobnitz with a new one that handles edge cases.");
  });

  test("body renders remaining epic content as markdown", () => {
    const html = renderGoalArc(makeArc());
    // The "Why" section heading should be rendered as an HTML heading
    expect(html).toMatch(/<h2[^>]*>.*Why/);
    // Prose content present
    expect(html).toContain("brittle and breaks under load");
  });

  test("original ask renders markdown (bold, code, links)", () => {
    const epic = makeEpic({
      body: `## Goal
Build the **frobnitz** with \`--fast\` flag and [docs](https://example.com).

## Why
Performance.`,
    });
    const html = renderGoalArc(makeArc({ epic }));
    // Bold rendered in Original Ask
    expect(html).toContain("<strong>frobnitz</strong>");
    // Inline code rendered
    expect(html).toContain("<code>--fast</code>");
  });

  test("escapes HTML in epic body while rendering markdown", () => {
    const epic = makeEpic({
      body: `## Goal
Fix <script>alert('xss')</script> in the **parser**.

## Why
Security.`,
    });
    const html = renderGoalArc(makeArc({ epic }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    // Markdown still renders
    expect(html).toContain("<strong>parser</strong>");
  });

  test("decomposition tree shows all children", () => {
    const html = renderGoalArc(makeArc());
    expect(html).toContain("TK-011");
    expect(html).toContain("First child task");
    expect(html).toContain("TK-012");
    expect(html).toContain("Second child task");
  });

  test("children with runs show run IDs as links", () => {
    const html = renderGoalArc(makeArc());
    expect(html).toContain('href="/runs/RUN-001"');
    expect(html).toContain("RUN-001");
    expect(html).toContain('href="/runs/RUN-002"');
    expect(html).toContain("RUN-002");
  });

  test("children without runs show dash", () => {
    const arc = makeArc({
      children: [
        makeChild("TK-011", "No run child", "open", []),
      ],
    });
    const html = renderGoalArc(arc);
    expect(html).toContain('class="runs-muted">—</span>');
  });

  test("cost column uses dash (dispatches don't track cost)", () => {
    const html = renderGoalArc(makeArc());
    // arc-child-cost cells should all contain "—"
    const costMatches = html.match(/arc-child-cost[^>]*>[^<]*/g);
    expect(costMatches).not.toBeNull();
    for (const m of costMatches!) {
      expect(m).toContain("—");
    }
  });

  test("arc body is hidden by default (CSS handles via .expanded class)", () => {
    const html = renderGoalArc(makeArc());
    // The card should NOT have the "expanded" class by default
    expect(html).not.toContain('class="arc-card expanded"');
    // The arc-body div should be present (CSS hides it)
    expect(html).toContain('class="arc-body"');
  });

  test("closed epic shows result line", () => {
    const epic = makeEpic({
      status: "closed",
      closed: "2026-05-10T00:00:00Z",
      body: `## Goal
Do the thing.

### 2026-05-09T22:00:00Z [maya]
Shipped in commit abc123, all tests passing.`,
    });
    const html = renderGoalArc(makeArc({ epic, status: "shipped" }));
    expect(html).toContain("arc-result");
    expect(html).toContain("Shipped in commit abc123");
  });

  test("open epic does not show result line", () => {
    const html = renderGoalArc(makeArc());
    expect(html).not.toContain("arc-result");
  });

  test("renders correctly with 1 child", () => {
    const arc = makeArc({
      children: [
        makeChild("TK-011", "Only child", "closed", [
          { id: "RUN-001", status: "shipped" },
        ]),
      ],
      runCount: 1,
      status: "shipped",
    });
    const html = renderGoalArc(arc);
    expect(html).toContain("TK-011");
    expect(html).toContain("Only child");
    expect(html).toContain("1 run");
    // Should have exactly one arc-child
    const childMatches = html.match(/class="arc-child"/g);
    expect(childMatches?.length).toBe(1);
  });

  test("renders correctly with 7 children", () => {
    const children: GoalArcChild[] = [];
    for (let i = 1; i <= 7; i++) {
      const id = `TK-${String(i + 10).padStart(3, "0")}`;
      const runs = i <= 3 ? [{ id: `RUN-${String(i).padStart(3, "0")}` as const, status: "shipped" as const }] : [];
      children.push(makeChild(id, `Child task ${i}`, i <= 3 ? "closed" : "open", runs));
    }

    const arc = makeArc({
      children,
      runCount: 3,
      status: "mixed",
    });
    const html = renderGoalArc(arc);

    // All 7 children present
    const childMatches = html.match(/class="arc-child"/g);
    expect(childMatches?.length).toBe(7);

    // First 3 have runs, last 4 have dashes
    for (let i = 1; i <= 3; i++) {
      expect(html).toContain(`RUN-${String(i).padStart(3, "0")}`);
    }
  });

  test("ticket IDs link to /tickets#TK-NNN", () => {
    const html = renderGoalArc(makeArc());
    expect(html).toContain('href="/tickets#TK-011"');
    expect(html).toContain('href="/tickets#TK-012"');
  });

  test("child with multiple runs shows all run links", () => {
    const arc = makeArc({
      children: [
        makeChild("TK-011", "Multi-run child", "in_progress", [
          { id: "RUN-001", status: "shipped" },
          { id: "RUN-005", status: "running" },
        ]),
      ],
    });
    const html = renderGoalArc(arc);
    expect(html).toContain("RUN-001");
    expect(html).toContain("RUN-005");
  });

  test("empty epic body produces no Original Ask section", () => {
    const epic = makeEpic({ body: "" });
    const html = renderGoalArc(makeArc({ epic }));
    expect(html).not.toContain("Original Ask");
  });

  test("escapes HTML in titles", () => {
    const epic = makeEpic({ title: 'Fix <script>alert("xss")</script>' });
    const html = renderGoalArc(makeArc({ epic }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
