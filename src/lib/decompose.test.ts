import { describe, expect, test } from "bun:test";

import {
  COUNT_CEILING,
  describeFailures,
  extractJson,
  parseOrientResponse,
  parseProposal,
  resolvePriority,
  validateGraph,
  type Proposal,
} from "./decompose";

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

describe("extractJson", () => {
  test("returns bare JSON unchanged", () => {
    expect(extractJson(`{"a":1}`)).toBe(`{"a":1}`);
  });

  test("strips ```json fences", () => {
    const raw = "```json\n{\"a\":1}\n```";
    expect(extractJson(raw)).toBe(`{"a":1}`);
  });

  test("strips bare ``` fences", () => {
    const raw = "```\n{\"a\":1}\n```";
    expect(extractJson(raw)).toBe(`{"a":1}`);
  });

  test("trims preamble before {", () => {
    const raw = `Sure, here's the JSON:\n{"a":1}\n`;
    expect(extractJson(raw)).toBe(`{"a":1}`);
  });

  test("strips <json> tags (plan-then-emit shape)", () => {
    const raw = `<analysis>thinking…</analysis>\n<json>\n{"a":1}\n</json>`;
    expect(extractJson(raw)).toBe(`{"a":1}`);
  });

  test("<json> wins over a stray { in the analysis block", () => {
    const raw = `<analysis>I considered { foo: 1 } as a shape.</analysis>\n<json>{"a":2}</json>`;
    expect(extractJson(raw)).toBe(`{"a":2}`);
  });
});

// ---------------------------------------------------------------------------
// parseProposal — happy path
// ---------------------------------------------------------------------------

const validProposal: Proposal = {
  epic: { title: "Build auth", body: "## Goal\n…", tags: ["auth"] },
  children: [
    {
      ref: "C1",
      title: "Add session model",
      body: "## Scope\n…",
      type: "task",
      tags: ["auth"],
      depends: [],
    },
    {
      ref: "C2",
      title: "Add login endpoint",
      body: "## Scope\n…",
      type: "feature",
      tags: ["auth"],
      depends: ["C1"],
    },
  ],
};

describe("parseProposal", () => {
  test("accepts valid JSON", () => {
    const result = parseProposal(JSON.stringify(validProposal));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.children).toHaveLength(2);
  });

  test("accepts code-fenced JSON", () => {
    const fenced = "```json\n" + JSON.stringify(validProposal) + "\n```";
    const result = parseProposal(fenced);
    expect(result.ok).toBe(true);
  });

  test("rejects malformed JSON", () => {
    const result = parseProposal("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures[0]?.kind).toBe("json-parse");
    }
  });

  test("rejects missing epic", () => {
    const result = parseProposal(JSON.stringify({ children: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.kind === "schema")).toBe(true);
    }
  });

  test("rejects missing children", () => {
    const result = parseProposal(JSON.stringify({ epic: { title: "X" } }));
    expect(result.ok).toBe(false);
  });

  test("rejects empty epic title", () => {
    const result = parseProposal(
      JSON.stringify({ epic: { title: "" }, children: [] }),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects child without ref", () => {
    const result = parseProposal(
      JSON.stringify({
        epic: { title: "X" },
        children: [{ title: "no ref" }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("coerces unknown ticket type to task", () => {
    const result = parseProposal(
      JSON.stringify({
        epic: { title: "X" },
        children: [{ ref: "C1", title: "T1", type: "weirdthing" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal.children[0]?.type).toBe("task");
  });
});

// ---------------------------------------------------------------------------
// validateGraph — graph-shape failures
// ---------------------------------------------------------------------------

describe("validateGraph", () => {
  test("flags duplicate refs", () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        { ref: "C1", title: "A", body: "", type: "task", tags: [], depends: [] },
        { ref: "C1", title: "B", body: "", type: "task", tags: [], depends: [] },
      ],
    };
    const result = validateGraph(proposal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.kind === "duplicate-ref")).toBe(true);
    }
  });

  test("flags self-reference", () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        {
          ref: "C1",
          title: "A",
          body: "",
          type: "task",
          tags: [],
          depends: ["C1"],
        },
      ],
    };
    const result = validateGraph(proposal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.kind === "self-reference")).toBe(true);
    }
  });

  test("flags missing dep ref", () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        {
          ref: "C1",
          title: "A",
          body: "",
          type: "task",
          tags: [],
          depends: ["GHOST"],
        },
      ],
    };
    const result = validateGraph(proposal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.kind === "missing-ref")).toBe(true);
    }
  });

  test("flags cycle", () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        { ref: "A", title: "A", body: "", type: "task", tags: [], depends: ["B"] },
        { ref: "B", title: "B", body: "", type: "task", tags: [], depends: ["C"] },
        { ref: "C", title: "C", body: "", type: "task", tags: [], depends: ["A"] },
      ],
    };
    const result = validateGraph(proposal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycle = result.failures.find((f) => f.kind === "cycle");
      expect(cycle).toBeDefined();
      // Path closes the loop, so first === last
      if (cycle && cycle.kind === "cycle") {
        expect(cycle.path[0]).toBe(cycle.path[cycle.path.length - 1]);
      }
    }
  });

  test("flags count > ceiling", () => {
    const tooMany = Array.from({ length: COUNT_CEILING + 2 }, (_, i) => ({
      ref: `C${i}`,
      title: `T${i}`,
      body: "",
      type: "task" as const,
      tags: [],
      depends: [],
    }));
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: tooMany,
    };
    const result = validateGraph(proposal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.some((f) => f.kind === "count-too-high")).toBe(true);
    }
  });

  test("count = 1 or 2 is not a failure (handled by writer)", () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        { ref: "C1", title: "A", body: "", type: "task", tags: [], depends: [] },
      ],
    };
    expect(validateGraph(proposal).ok).toBe(true);
  });

  test("missing-ref does not falsely trigger cycle", () => {
    // C1 -> GHOST (missing). Should NOT report a cycle.
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        {
          ref: "C1",
          title: "A",
          body: "",
          type: "task",
          tags: [],
          depends: ["GHOST"],
        },
      ],
    };
    const result = validateGraph(proposal);
    if (!result.ok) {
      expect(result.failures.some((f) => f.kind === "cycle")).toBe(false);
    }
  });

  test("valid proposal passes", () => {
    expect(validateGraph(validProposal).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseOrientResponse — three lever shapes
// ---------------------------------------------------------------------------

describe("parseOrientResponse", () => {
  test("retry-with-reframe", () => {
    const r = parseOrientResponse(
      JSON.stringify({
        decision: "retry-with-reframe",
        reframe: "Remove the cycle between A and B by inverting…",
      }),
    );
    expect(r?.decision).toBe("retry-with-reframe");
  });

  test("accept-with-warn", () => {
    const r = parseOrientResponse(
      JSON.stringify({
        decision: "accept-with-warn",
        warning: "Decomposed to 2 tickets, smaller than typical.",
      }),
    );
    expect(r?.decision).toBe("accept-with-warn");
  });

  test("abort", () => {
    const r = parseOrientResponse(
      JSON.stringify({ decision: "abort", reason: "Goal too vague to decompose." }),
    );
    expect(r?.decision).toBe("abort");
  });

  test("rejects unknown decision", () => {
    expect(
      parseOrientResponse(JSON.stringify({ decision: "convene-council" })),
    ).toBeNull();
  });

  test("rejects retry-with-reframe with empty reframe", () => {
    expect(
      parseOrientResponse(
        JSON.stringify({ decision: "retry-with-reframe", reframe: "" }),
      ),
    ).toBeNull();
  });

  test("rejects malformed JSON", () => {
    expect(parseOrientResponse("not json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describeFailures — used to brief the orient call
// ---------------------------------------------------------------------------

describe("describeFailures", () => {
  test("renders each failure kind", () => {
    const text = describeFailures([
      { kind: "json-parse", message: "x", rawSnippet: "abc" },
      { kind: "schema", message: "missing epic" },
      { kind: "duplicate-ref", ref: "C1" },
      { kind: "self-reference", ref: "C1" },
      { kind: "missing-ref", from: "C1", to: "GHOST" },
      { kind: "cycle", path: ["A", "B", "A"] },
      { kind: "count-too-high", count: 12, ceiling: 10 },
    ]);
    expect(text).toContain("JSON parse failed");
    expect(text).toContain("missing epic");
    expect(text).toContain("Duplicate child ref: C1");
    expect(text).toContain("depends on itself");
    expect(text).toContain("GHOST");
    expect(text).toContain("A -> B -> A");
    expect(text).toContain("Too many children: 12");
  });
});

// ---------------------------------------------------------------------------
// resolvePriority — string + number coercion
// ---------------------------------------------------------------------------

describe("resolvePriority", () => {
  test("default = 2", () => {
    expect(resolvePriority()).toBe(2);
  });
  test("numeric in range", () => {
    expect(resolvePriority(0)).toBe(0);
    expect(resolvePriority(3)).toBe(3);
  });
  test("string names", () => {
    expect(resolvePriority("high")).toBe(1);
    expect(resolvePriority("P1-high")).toBe(1);
    expect(resolvePriority("medium")).toBe(2);
  });
  test("unknown falls back to medium", () => {
    expect(resolvePriority("urgent-pls")).toBe(2);
  });
});
