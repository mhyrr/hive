import { describe, expect, test } from "bun:test";

import {
  buildDecomposeUserMessage,
  buildOrientUserMessage,
  DECOMPOSE_SYSTEM_PROMPT,
  ORIENT_SYSTEM_PROMPT,
  type DecomposeContext,
} from "./decompose-prompt";

const baseCtx: DecomposeContext = {
  projectId: "hive",
  goal: "Add overnight retry for flaky test runs",
  indexMd: "## Tags\n`testing`(5)  `dispatch`(3)\n",
  principlesMd: "- Solve the right problem.\n- Show, don't narrate.",
  searchHits: [
    {
      source: "knowledge",
      file: "knowledge.md",
      section: "facts",
      entry: "Dispatch retries on transient failure are off by default.",
      tags: ["dispatch"],
      score: 4.2,
    },
  ],
  openTickets: [
    {
      id: "TK-040",
      title: "hive tail: live view into a running dispatch",
      tags: ["dispatch", "ux"],
      type: "feature",
    },
  ],
};

describe("DECOMPOSE_SYSTEM_PROMPT", () => {
  test("declares plan-then-emit shape with analysis + json blocks", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("<analysis>");
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("<json>");
  });
  test("names the count guardrails", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("3-10 children");
  });
  test("requires substantive children, no TBD placeholders", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("TBD");
  });
  test("includes a SELF-CHECK section", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("SELF-CHECK");
  });
  test("includes a worked example", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("<example>");
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("<input_goal>");
  });
  test("frames dedup as coverage-not-filtering", () => {
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("COVERAGE, not filtering");
    expect(DECOMPOSE_SYSTEM_PROMPT).toContain("possibly-covered");
  });
});

describe("ORIENT_SYSTEM_PROMPT", () => {
  test("declares all three levers", () => {
    expect(ORIENT_SYSTEM_PROMPT).toContain("retry-with-reframe");
    expect(ORIENT_SYSTEM_PROMPT).toContain("accept-with-warn");
    expect(ORIENT_SYSTEM_PROMPT).toContain("abort");
  });
  test("declares JSON-only output", () => {
    expect(ORIENT_SYSTEM_PROMPT).toContain("JSON only");
  });
});

describe("buildDecomposeUserMessage", () => {
  test("includes the goal", () => {
    const msg = buildDecomposeUserMessage(baseCtx);
    expect(msg).toContain(baseCtx.goal);
  });

  test("includes the index, principles, and tickets", () => {
    const msg = buildDecomposeUserMessage(baseCtx);
    expect(msg).toContain("Project Memory Index");
    expect(msg).toContain("`testing`(5)");
    expect(msg).toContain("Taste Principles");
    expect(msg).toContain("Solve the right problem");
    expect(msg).toContain("TK-040");
  });

  test("includes search hits with tags", () => {
    const msg = buildDecomposeUserMessage(baseCtx);
    expect(msg).toContain("Dispatch retries");
    expect(msg).toContain("[dispatch]");
  });

  test("handles empty index gracefully", () => {
    const msg = buildDecomposeUserMessage({ ...baseCtx, indexMd: "" });
    expect(msg).toContain("(empty — project has no compiled memory yet)");
  });

  test("handles no open tickets gracefully", () => {
    const msg = buildDecomposeUserMessage({ ...baseCtx, openTickets: [] });
    expect(msg).toContain("Open tickets in this project\n(none)");
  });

  test("handles no search hits", () => {
    const msg = buildDecomposeUserMessage({ ...baseCtx, searchHits: [] });
    expect(msg).toContain("(no direct hits)");
  });

  test("calls out duplicate-awareness when tickets are present", () => {
    const msg = buildDecomposeUserMessage(baseCtx);
    expect(msg).toContain("If the goal overlaps");
  });
});

describe("buildOrientUserMessage", () => {
  test("includes the goal, attempt, failure summary, and raw output", () => {
    const msg = buildOrientUserMessage({
      goal: "build auth",
      attempt: 2,
      maxAttempts: 8,
      failures: [{ kind: "cycle", path: ["A", "B", "A"] }],
      rawOutput: '{"epic":{"title":"X"},"children":[]}',
      priorReframes: [],
    });
    expect(msg).toContain("build auth");
    expect(msg).toContain("Attempt: 2 of 8");
    expect(msg).toContain("Dependency cycle: A -> B -> A");
    expect(msg).toContain("epic");
  });

  test("includes prior reframes when present, and asks orient to escalate", () => {
    const msg = buildOrientUserMessage({
      goal: "x",
      attempt: 3,
      maxAttempts: 8,
      failures: [{ kind: "schema", message: "missing children" }],
      rawOutput: "{}",
      priorReframes: ["Remove cycle between A and B."],
    });
    expect(msg).toContain("Reframes already tried");
    expect(msg).toContain("Remove cycle between A and B.");
  });

  test("truncates very long raw output", () => {
    const huge = "x".repeat(5000);
    const msg = buildOrientUserMessage({
      goal: "x",
      attempt: 1,
      maxAttempts: 8,
      failures: [{ kind: "json-parse", message: "bad", rawSnippet: "..." }],
      rawOutput: huge,
      priorReframes: [],
    });
    expect(msg).toContain("[truncated]");
    expect(msg.length).toBeLessThan(huge.length + 2000);
  });
});
