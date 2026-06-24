import { describe, expect, test } from "bun:test";

import { segmentWindows } from "./taste-segment";
import { parseTranscriptContent, type ParseContext, type TranscriptEvent } from "./transcript";
import {
  __PROMPTS,
  callTasteAnalyzer,
  callTasteClassifier,
  runTasteExtract,
  validateTasteCandidate,
  validateTasteFlag,
} from "./taste-extract";
import type { DivergenceWindow } from "./taste-types";
import type { ModelCaller } from "./extract";

const ctx: ParseContext = {
  sessionFile: "/Users/x/.claude/projects/-Users-x-work-proj/sess.jsonl",
  source: "claude",
  project: "proj",
};

let n = 0;
function correctionTranscript(): TranscriptEvent[] {
  const lines = [
    { type: "user", uuid: `u${n++}`, parentUuid: null, timestamp: "t", message: { role: "user", content: "build a schema" } },
    {
      type: "assistant",
      uuid: `a${n++}`,
      parentUuid: null,
      timestamp: "t",
      message: { role: "assistant", content: [{ type: "text", text: "done" }, { type: "tool_use", id: `tu${n++}`, name: "Edit", input: { file_path: "/x/schema.sql", old_string: "a", new_string: "b" } }] },
    },
    { type: "user", uuid: `u${n++}`, parentUuid: null, timestamp: "t", message: { role: "user", content: "no, use a foreign key instead" } },
    {
      type: "assistant",
      uuid: `a${n++}`,
      parentUuid: null,
      timestamp: "t",
      message: { role: "assistant", content: [{ type: "tool_use", id: `tu${n++}`, name: "Edit", input: { file_path: "/x/schema.sql", old_string: "b", new_string: "fk" } }] },
    },
  ];
  return parseTranscriptContent(lines.map((l) => JSON.stringify(l)).join("\n"), ctx);
}

function completion(text: string) {
  return { provider: "anthropic", model: "stub", text, inputTokens: 100, outputTokens: 50, durationMs: 10 };
}

// ---------------------------------------------------------------------------
// validateTasteFlag
// ---------------------------------------------------------------------------

describe("validateTasteFlag", () => {
  const windows = segmentWindows(correctionTranscript());
  const byId = new Map(windows.map((w) => [w.windowId, w]));
  const id = windows[0]!.windowId;

  test("rehydrates anchor + window from the known TA-0 window", () => {
    const f = validateTasteFlag(
      { windowId: id, type_guess: "CORRECTION", trigger_quote: "no, use a foreign key", crude_confidence: 0.8 },
      byId,
    );
    expect(f).not.toBeNull();
    expect(f!.anchor.id).toBe(windows[0]!.anchor.id); // taken from the window, not the model
    expect(f!.window.startId).toBe(windows[0]!.startId);
    expect(f!.type_guess).toBe("CORRECTION");
  });

  test("rejects an unknown windowId (model hallucination)", () => {
    expect(validateTasteFlag({ windowId: "nope:99", type_guess: "CORRECTION" }, byId)).toBeNull();
  });

  test("rejects an out-of-taxonomy type_guess", () => {
    expect(validateTasteFlag({ windowId: id, type_guess: "VIBES" }, byId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateTasteCandidate
// ---------------------------------------------------------------------------

describe("validateTasteCandidate", () => {
  const valid = {
    category: "IMPLEMENTATION",
    tier: "DETERMINISTIC",
    scope: { kind: "project", glob: "**/*.sql" },
    reasoning: "Prefer a foreign key over a denormalized id column; integrity belongs in the schema.",
    delta: { before: "plain id column", after: "foreign key constraint" },
    reason_source: "stated",
    rule_statement: "SQL relations use foreign keys",
    canonical_example: { bad: "user_id int", good: "user_id references users(id)" },
    check_sketch: "flag *_id int columns without a REFERENCES clause",
    evidence: [{ anchor: { sessionFile: "f", id: "u3", ts: null }, quote: "no, use a foreign key instead", confidence: 0.9 }],
    dedupe_key: "sql-foreign-keys",
    provenance: "human correction at id=u3",
  };

  test("accepts a well-formed candidate", () => {
    const c = validateTasteCandidate(valid);
    expect(c).not.toBeNull();
    expect(c!.category).toBe("IMPLEMENTATION");
    expect(c!.scope.glob).toBe("**/*.sql");
    expect(c!.check_sketch).toContain("REFERENCES");
  });

  test("rejects missing reasoning", () => {
    expect(validateTasteCandidate({ ...valid, reasoning: "" })).toBeNull();
  });

  test("rejects when there is no evidence anchor (design §5.4: no anchor ⇒ no candidate)", () => {
    expect(validateTasteCandidate({ ...valid, evidence: [] })).toBeNull();
  });

  test("rejects an out-of-set category", () => {
    expect(validateTasteCandidate({ ...valid, category: "ARCHITECTURE" })).toBeNull();
  });

  test("defaults reason_source to inferred and scope.kind to project", () => {
    const c = validateTasteCandidate({ ...valid, reason_source: "guessed", scope: { kind: "bogus" } });
    expect(c!.reason_source).toBe("inferred");
    expect(c!.scope.kind).toBe("project");
  });

  test("rejects quote-only evidence with an empty anchor.id (design §5.4)", () => {
    expect(
      validateTasteCandidate({
        ...valid,
        evidence: [{ anchor: { sessionFile: "f", id: "", ts: null }, quote: "x", confidence: 0.9 }],
      }),
    ).toBeNull();
  });

  test("drops a secondary_category equal to the primary", () => {
    const c = validateTasteCandidate({ ...valid, secondary_category: valid.category });
    expect(c!.secondary_category).toBeUndefined();
  });

  test("keeps a distinct secondary_category", () => {
    const c = validateTasteCandidate({ ...valid, secondary_category: "DESIGN" });
    expect(c!.secondary_category).toBe("DESIGN");
  });
});

// ---------------------------------------------------------------------------
// Pass calls with a stubbed ModelCaller (the makeStub idiom)
// ---------------------------------------------------------------------------

describe("call passes (stubbed caller)", () => {
  const windows = segmentWindows(correctionTranscript());
  const id = windows[0]!.windowId;

  test("callTasteClassifier parses + rehydrates flags", async () => {
    const caller: ModelCaller = async () =>
      completion(JSON.stringify([{ windowId: id, type_guess: "CORRECTION", trigger_quote: "no, use a foreign key", crude_confidence: 0.8 }]));
    const res = await callTasteClassifier(windows, caller);
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.windowId).toBe(id);
  });

  test("callTasteAnalyzer parses + validates candidates", async () => {
    const candidateJson = JSON.stringify([
      {
        category: "IMPLEMENTATION",
        tier: "FUZZY",
        scope: { kind: "project" },
        reasoning: "integrity belongs in the schema, not application code",
        delta: { before: "x", after: "y" },
        reason_source: "inferred",
        rule_statement: "use FKs",
        canonical_example: { bad: "x", good: "y" },
        check_sketch: null,
        evidence: [{ anchor: { sessionFile: "f", id: "u3", ts: null }, quote: "no, use a foreign key instead", confidence: 0.9 }],
        dedupe_key: "fk",
        provenance: "id=u3",
      },
    ]);
    const caller: ModelCaller = async () => completion(candidateJson);
    const res = await callTasteAnalyzer(windows, caller);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.category).toBe("IMPLEMENTATION");
  });
});

// ---------------------------------------------------------------------------
// runTasteExtract end-to-end (stubbed)
// ---------------------------------------------------------------------------

describe("runTasteExtract", () => {
  const events = correctionTranscript();
  const loaded = [{ sessionFile: ctx.sessionFile, source: ctx.source, project: ctx.project, events }];

  test("flags-only mode stops after TA-1 and records no candidates", async () => {
    const winId = segmentWindows(events)[0]!.windowId;
    const caller: ModelCaller = async () =>
      completion(JSON.stringify([{ windowId: winId, type_guess: "CORRECTION", trigger_quote: "no", crude_confidence: 0.7 }]));
    const res = await runTasteExtract(loaded, { caller, flagsOnly: true });
    expect(res.flaggedCount).toBe(1);
    expect(res.candidates).toHaveLength(0);
    expect(res.modelCalls).toBe(1);
  });

  test("full run threads flags into TB and collects candidates", async () => {
    const winId = segmentWindows(events)[0]!.windowId;
    const caller: ModelCaller = async (input) => {
      if (input.systemPrompt === __PROMPTS.flag) {
        return completion(JSON.stringify([{ windowId: winId, type_guess: "CORRECTION", trigger_quote: "no", crude_confidence: 0.7 }]));
      }
      return completion(
        JSON.stringify([
          {
            category: "IMPLEMENTATION",
            tier: "FUZZY",
            scope: { kind: "project" },
            reasoning: "integrity belongs in the schema",
            delta: { before: "x", after: "y" },
            reason_source: "inferred",
            rule_statement: "use FKs",
            canonical_example: { bad: "x", good: "y" },
            check_sketch: null,
            evidence: [{ anchor: { sessionFile: "f", id: "u3", ts: null }, quote: "no", confidence: 0.9 }],
            dedupe_key: "fk",
            provenance: "id=u3",
          },
        ]),
      );
    };
    const res = await runTasteExtract(loaded, { caller });
    expect(res.modelCalls).toBe(2);
    expect(res.flaggedCount).toBe(1);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.category).toBe("IMPLEMENTATION");
  });
});
