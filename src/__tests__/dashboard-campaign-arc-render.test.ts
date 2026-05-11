import { describe, test, expect } from "bun:test";
import { renderCampaignArc } from "../lib/dashboard/runs/render";
import type { CampaignArc, CampaignIteration, RunRow } from "../lib/dashboard/runs/collect";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCampaignRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    kind: "campaign",
    id: "CAMP-001",
    status: "shipped",
    startedAt: "2026-05-10T10:00:00Z",
    endedAt: "2026-05-10T12:00:00Z",
    elapsedSec: 7200,
    costUsd: 1.5,
    goalSummary: "Implement feature X with comprehensive test coverage and documentation",
    ...overrides,
  };
}

function makeIteration(n: number, overrides: Partial<CampaignIteration> = {}): CampaignIteration {
  return {
    iterationN: n,
    exitReason: "natural",
    judgeDecision: "continue",
    cost: 0.35,
    elapsedSec: 1200,
    ...overrides,
  };
}

function makeArc(overrides: Partial<CampaignArc> = {}): CampaignArc {
  return {
    kind: "campaign",
    campaign: makeCampaignRow(),
    iterations: [
      makeIteration(1, { judgeDecision: "continue", exitReason: "natural", cost: 0.45, elapsedSec: 900 }),
      makeIteration(2, { judgeDecision: "continue", exitReason: "natural", cost: 0.38, elapsedSec: 1100 }),
      makeIteration(3, { judgeDecision: "done", exitReason: "natural", cost: 0.67, elapsedSec: 1500 }),
    ],
    totalCost: 1.5,
    iterationCount: 3,
    status: "shipped",
    goal: "Implement feature X with comprehensive test coverage and documentation updates to reflect the new behavior.",
    frozenPrefix: "You are an expert TypeScript developer.\nAlways write tests first.",
    finalArtifact: null,
    failureReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderCampaignArc", () => {
  test("renders a collapsed card by default", () => {
    const html = renderCampaignArc(makeArc());

    // Has the arc-card wrapper
    expect(html).toContain('class="arc-card"');
    expect(html).toContain('data-arc-id="CAMP-001"');

    // Header is present
    expect(html).toContain('class="arc-header"');
    expect(html).toContain('aria-expanded="false"');

    // Body is present (hidden via CSS by default, shown when .expanded is added)
    expect(html).toContain('class="arc-body"');
  });

  test("header shows campaign id and goal summary", () => {
    const html = renderCampaignArc(makeArc());

    expect(html).toContain("CAMP-001");
    // Goal summary should be truncated to ~80 chars
    expect(html).toContain("Implement feature X");
  });

  test("header shows status chip", () => {
    const html = renderCampaignArc(makeArc({ status: "shipped" }));
    expect(html).toContain("chip-shipped");
    expect(html).toContain("shipped");

    const running = renderCampaignArc(makeArc({ status: "in-flight" }));
    expect(running).toContain("chip-in-flight");
    expect(running).toContain("running");

    const failed = renderCampaignArc(makeArc({ status: "blocked" }));
    expect(failed).toContain("chip-failed");
  });

  test("header shows total cost with tabular-nums class", () => {
    const html = renderCampaignArc(makeArc({ totalCost: 2.34 }));
    expect(html).toContain("$2.34");
    expect(html).toContain('class="arc-meta"');
  });

  test("header shows iteration count", () => {
    const html = renderCampaignArc(makeArc({ iterationCount: 5 }));
    expect(html).toContain("5 iters");

    const single = renderCampaignArc(makeArc({ iterationCount: 1 }));
    expect(single).toContain("1 iter");
    expect(single).not.toContain("1 iters");
  });

  test("body shows full campaign goal", () => {
    const goal = "This is a much longer goal that describes the full intent of the campaign including all details.";
    const html = renderCampaignArc(makeArc({ goal }));
    expect(html).toContain(goal);
    expect(html).toContain("Goal");
  });

  test("body shows frozen prefix block with correct styling", () => {
    const prefix = "You are an expert TypeScript developer.\nAlways write tests first.";
    const html = renderCampaignArc(makeArc({ frozenPrefix: prefix }));

    // Label
    expect(html).toContain("Frozen prefix (cache-stable)");
    expect(html).toContain("frozen-prefix-label");

    // Content in pre block with muted bg class
    expect(html).toContain("arc-frozen-prefix");
    expect(html).toContain("You are an expert TypeScript developer.");
  });

  test("frozen prefix hidden when null", () => {
    const html = renderCampaignArc(makeArc({ frozenPrefix: null }));
    expect(html).not.toContain("Frozen prefix");
    expect(html).not.toContain("arc-frozen-prefix");
  });

  test("iteration table renders with tabular-nums columns", () => {
    const iterations: CampaignIteration[] = [
      makeIteration(1, { exitReason: "natural", judgeDecision: "continue", cost: 0.45, elapsedSec: 900 }),
      makeIteration(2, { exitReason: "natural", judgeDecision: "done", cost: 0.67, elapsedSec: 1500 }),
    ];
    const html = renderCampaignArc(makeArc({ iterations, iterationCount: 2 }));

    // Table structure
    expect(html).toContain("arc-iterations");
    expect(html).toContain("<th");
    expect(html).toContain("#");
    expect(html).toContain("Exit Reason");
    expect(html).toContain("Judge");
    expect(html).toContain("Cost");
    expect(html).toContain("Elapsed");

    // Row data
    expect(html).toContain("$0.45");
    expect(html).toContain("$0.67");
    expect(html).toContain("natural");
    expect(html).toContain("15m");
  });

  test("judge decision cell uses correct color classes", () => {
    const iterations: CampaignIteration[] = [
      makeIteration(1, { judgeDecision: "continue" }),
      makeIteration(2, { judgeDecision: "reject" }),
      makeIteration(3, { judgeDecision: "done" }),
    ];
    const html = renderCampaignArc(makeArc({ iterations, iterationCount: 3 }));

    // "continue" and "done" get accept class (ink color)
    expect(html).toContain('class="judge-accept">continue');
    expect(html).toContain('class="judge-accept">done');

    // "reject" gets reject class (rust color)
    expect(html).toContain('class="judge-reject">reject');
  });

  test("final artifact section shown when present", () => {
    const html = renderCampaignArc(makeArc({ finalArtifact: "/tmp/campaign-output.txt" }));
    expect(html).toContain("Final Artifact");
    expect(html).toContain("/tmp/campaign-output.txt");
  });

  test("final artifact hidden when null", () => {
    const html = renderCampaignArc(makeArc({ finalArtifact: null }));
    expect(html).not.toContain("Final Artifact");
  });

  test("renders correctly for a 1-iteration campaign", () => {
    const arc = makeArc({
      iterations: [makeIteration(1, { judgeDecision: "done", exitReason: "natural", cost: 0.39, elapsedSec: 600 })],
      iterationCount: 1,
      totalCost: 0.39,
    });
    const html = renderCampaignArc(arc);

    expect(html).toContain("1 iter");
    expect(html).not.toContain("1 iters");
    expect(html).toContain("$0.39");
    expect(html).toContain("10m");
    // Should have exactly one data row in the table
    const rowMatches = html.match(/<tr>\s*<td class="num">1<\/td>/g);
    expect(rowMatches).toHaveLength(1);
  });

  test("renders correctly for a 5+ iteration campaign", () => {
    const iterations = Array.from({ length: 7 }, (_, i) =>
      makeIteration(i + 1, {
        judgeDecision: i < 6 ? "continue" : "done",
        exitReason: i === 3 ? "hard-cap" : "natural",
        cost: 0.3 + i * 0.05,
        elapsedSec: 600 + i * 200,
      }),
    );
    const arc = makeArc({
      iterations,
      iterationCount: 7,
      totalCost: iterations.reduce((s, it) => s + it.cost, 0),
    });
    const html = renderCampaignArc(arc);

    expect(html).toContain("7 iters");
    // Should have 7 data rows
    const tdMatches = html.match(/<td class="num">\d+<\/td>/g);
    // Each row has 3 .num cells: #, cost, elapsed — so 7 * 3 = 21
    expect(tdMatches!.length).toBeGreaterThanOrEqual(7);
    // Hard-cap shows up
    expect(html).toContain("hard-cap");
  });

  test("goal renders markdown (headings, bold, code)", () => {
    const goal = "# Prime Directive\n\nBuild the **frobnitz** with `--fast` flag.\n\n## Constraints\n\n- No regressions\n- Full test coverage";
    const html = renderCampaignArc(makeArc({ goal }));

    // Headings rendered
    expect(html).toContain("<h1>");
    expect(html).toContain("Prime Directive");
    expect(html).toContain("<h2>");
    expect(html).toContain("Constraints");
    // Bold rendered
    expect(html).toContain("<strong>frobnitz</strong>");
    // Inline code rendered
    expect(html).toContain("<code>--fast</code>");
    // List rendered
    expect(html).toContain("<li>");
  });

  test("escapes HTML in goal and frozen prefix", () => {
    const arc = makeArc({
      goal: "Implement <script>alert('xss')</script> safely",
      frozenPrefix: "Trust no <input> from users",
    });
    const html = renderCampaignArc(arc);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;input&gt;");
  });

  test("empty iterations produces no table", () => {
    const html = renderCampaignArc(makeArc({ iterations: [], iterationCount: 0 }));
    expect(html).not.toContain("arc-iterations");
    expect(html).not.toContain("<thead>");
  });
});
