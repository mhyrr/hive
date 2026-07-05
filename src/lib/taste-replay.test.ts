import { describe, expect, test } from "bun:test";

import type { ModelCaller } from "./extract";
import {
  buildReplayCorpus,
  buildReplayUserContent,
  replayCandidates,
  validateReplayJudgment,
  type ReplayCorpus,
} from "./taste-replay";
import type { TranscriptEvent } from "./transcript";
import type { TasteCandidate } from "./taste-types";

// ---------------------------------------------------------------------------
// Event + candidate fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function ev(p: {
  role: TranscriptEvent["role"];
  kind: TranscriptEvent["kind"];
  text?: string;
  tool?: TranscriptEvent["tool"];
  sessionFile?: string;
}): TranscriptEvent {
  seq++;
  return {
    anchor: { sessionFile: p.sessionFile ?? "s.jsonl", id: `id${seq}`, line: seq, ts: null },
    parentId: null,
    source: "claude",
    project: "demo",
    role: p.role,
    kind: p.kind,
    tool: p.tool,
    text: p.text ?? "",
  };
}

const asst = (text: string, sf: string) => ev({ role: "assistant", kind: "message", text, sessionFile: sf });
const user = (text: string, sf: string) => ev({ role: "user", kind: "message", text, sessionFile: sf });
const tool = (name: string, target: string, sf: string) =>
  ev({ role: "assistant", kind: "tool_use", tool: { name, target, summary: `${name} ${target}` }, sessionFile: sf });

/** A clean correction window: assistant output, then the human redirects. */
const correctionSession = (sf: string) => [asst("here is the code", sf), user("no, that's wrong, use a UUID instead", sf)];
/** A clean accepted window: assistant output, no human reaction. */
const acceptedSession = (sf: string) => [asst("shipped it", sf), asst("also added the docs", sf)];

function candidate(over: Partial<TasteCandidate> = {}): TasteCandidate {
  return {
    category: "IMPLEMENTATION",
    tier: "FUZZY",
    scope: { kind: "project" },
    reasoning: "Identifiers should be UUIDs, not sequential ints.",
    delta: { before: "used an int id", after: "used a uuid" },
    reason_source: "stated",
    rule_statement: "Use UUIDs for entity identifiers",
    canonical_example: { bad: "id serial", good: "id uuid" },
    check_sketch: null,
    evidence: [{ anchor: { sessionFile: "s.jsonl", id: "id1", ts: null }, quote: "use a UUID", confidence: 0.9 }],
    dedupe_key: "use-uuid",
    provenance: "id=id1",
    ...over,
  };
}

/** One call answers for ALL rules: a fixed dedupe_key → flagged-ids map. */
function stubJudge(map: Record<string, string[]>, onCall?: () => void): ModelCaller {
  return async (input) => {
    onCall?.();
    return {
      provider: input.provider,
      model: input.modelId,
      text: JSON.stringify(Object.entries(map).map(([dedupe_key, flagged]) => ({ dedupe_key, flagged }))),
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 3,
    };
  };
}

/** A balanced 3+3 corpus: windows w0..w2 corrections, w3..w5 accepted. */
function corpus3x3(): ReplayCorpus {
  const events = [
    ...correctionSession("c1.jsonl"),
    ...correctionSession("c2.jsonl"),
    ...correctionSession("c3.jsonl"),
    ...acceptedSession("a1.jsonl"),
    ...acceptedSession("a2.jsonl"),
    ...acceptedSession("a3.jsonl"),
  ];
  return buildReplayCorpus(events);
}

const SMALL = { sample: 4, minWindows: 4, minPositives: 2, minNegatives: 2 };

// ---------------------------------------------------------------------------
// Corpus labeling
// ---------------------------------------------------------------------------

describe("buildReplayCorpus", () => {
  test("labels a redirect as a correction and untouched output as accepted", () => {
    const c = buildReplayCorpus([...correctionSession("c1.jsonl"), ...acceptedSession("a1.jsonl")]);
    expect(c.positives).toBe(1);
    expect(c.negatives).toBe(1);
    expect(c.windows.find((w) => w.sessionFile === "c1.jsonl")?.label).toBe("correction");
    expect(c.windows.find((w) => w.sessionFile === "a1.jsonl")?.label).toBe("accepted");
  });

  test("explicit praise is a clean negative (the human approved)", () => {
    const c = buildReplayCorpus([asst("here you go", "p.jsonl"), user("perfect, exactly what I wanted", "p.jsonl")]);
    expect(c.negatives).toBe(1);
    expect(c.positives).toBe(0);
    expect(c.windows[0]!.label).toBe("accepted");
  });

  test("ambiguous post-action turns are dropped, not mislabeled", () => {
    // A substantive user turn after a tool edit, with no lexical cue → post-action
    // locus → ambiguous → excluded entirely (neither positive nor negative).
    const c = buildReplayCorpus([tool("Edit", "f.ts", "amb.jsonl"), user("now add tests for it", "amb.jsonl")]);
    expect(c.windows).toHaveLength(0);
  });

  test("a window with no assistant output is dropped", () => {
    const c = buildReplayCorpus([user("hello there", "u.jsonl")]);
    expect(c.windows).toHaveLength(0);
  });

  test("windows never span sessions and ids are unique", () => {
    const c = corpus3x3();
    expect(c.windows).toHaveLength(6);
    expect(c.positives).toBe(3);
    expect(c.negatives).toBe(3);
    expect(new Set(c.windows.map((w) => w.windowId)).size).toBe(6);
    // Order: corrections first (w0..w2), then accepted (w3..w5).
    expect(c.windows.slice(0, 3).every((w) => w.label === "correction")).toBe(true);
    expect(c.windows.slice(3).every((w) => w.label === "accepted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Judge user content — labels never leak to the judge
// ---------------------------------------------------------------------------

describe("buildReplayUserContent", () => {
  test("renders rule ids + window ids but not the ground-truth labels", () => {
    const c = corpus3x3();
    const content = buildReplayUserContent([candidate()], c.windows);
    expect(content).toContain("use-uuid");
    expect(content).toContain("## w0");
    // The label words must not be emitted as window metadata.
    expect(content).not.toContain("label");
    expect(content).not.toContain('"correction"');
  });
});

describe("validateReplayJudgment", () => {
  test("drops unknown dedupe_keys and unknown window ids", () => {
    const keys = new Set(["use-uuid"]);
    const ids = new Set(["w0", "w1"]);
    expect(validateReplayJudgment({ dedupe_key: "ghost", flagged: ["w0"] }, keys, ids)).toBeNull();
    const j = validateReplayJudgment({ dedupe_key: "use-uuid", flagged: ["w0", "w9", "w1", "w0"] }, keys, ids);
    expect(j?.flagged.sort()).toEqual(["w0", "w1"]); // w9 dropped, w0 de-duped
  });
});

// ---------------------------------------------------------------------------
// Judge scoring + threshold gating
// ---------------------------------------------------------------------------

describe("replayCandidates — scoring", () => {
  test("a rule that flags only real corrections passes", async () => {
    const r = await replayCandidates([candidate()], corpus3x3(), {
      caller: stubJudge({ "use-uuid": ["w0", "w1"] }),
      thresholds: SMALL,
    });
    const v = r.byKey.get("use-uuid")!;
    expect(v.precision).toBe(1);
    expect(v.recall).toBe(1);
    expect(v.passed).toBe(true);
    expect(v.inconclusive).toBe(false);
    expect(r.sampled).toBe(4);
    expect(r.usage).not.toBeNull();
  });

  test("a rule that flags accepted work fails on precision", async () => {
    const r = await replayCandidates([candidate({ dedupe_key: "nag" })], corpus3x3(), {
      caller: stubJudge({ nag: ["w3"] }), // w3 is a negative (accepted)
      thresholds: SMALL,
    });
    const v = r.byKey.get("nag")!;
    expect(v.precision).toBe(0);
    expect(v.passed).toBe(false);
  });

  test("a half-right rule fails the precision floor (nagging is the expensive error)", async () => {
    const r = await replayCandidates([candidate({ dedupe_key: "half" })], corpus3x3(), {
      caller: stubJudge({ half: ["w0", "w3"] }), // one correction, one accepted → precision 0.5
      thresholds: SMALL,
    });
    const v = r.byKey.get("half")!;
    expect(v.precision).toBe(0.5);
    expect(v.passed).toBe(false); // 0.5 < 0.6 floor
  });

  test("scores every rule from one shared judge call", async () => {
    let calls = 0;
    const r = await replayCandidates(
      [candidate({ dedupe_key: "a" }), candidate({ dedupe_key: "b" })],
      corpus3x3(),
      {
        caller: stubJudge({ a: ["w0", "w1"], b: ["w3"] }, () => calls++),
        thresholds: SMALL,
      },
    );
    expect(calls).toBe(1); // ONE call per project, not per candidate
    expect(r.byKey.get("a")!.passed).toBe(true);
    expect(r.byKey.get("b")!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Thin corpus + failure → inconclusive (never fail open)
// ---------------------------------------------------------------------------

describe("replayCandidates — inconclusive", () => {
  test("a thin corpus holds the candidate without calling the judge", async () => {
    let calls = 0;
    const thin = buildReplayCorpus([...correctionSession("c1.jsonl"), ...acceptedSession("a1.jsonl")]); // 2 windows
    const r = await replayCandidates([candidate()], thin, { caller: stubJudge({ "use-uuid": ["w0"] }, () => calls++) });
    expect(calls).toBe(0); // no model call on a thin corpus
    const v = r.byKey.get("use-uuid")!;
    expect(v.inconclusive).toBe(true);
    expect(v.passed).toBe(false);
    expect(r.usage).toBeNull();
    expect(r.inconclusive).toBe(true);
  });

  test("a null corpus is inconclusive", async () => {
    const r = await replayCandidates([candidate()], null, { caller: stubJudge({}) });
    expect(r.byKey.get("use-uuid")!.inconclusive).toBe(true);
    expect(r.inconclusive).toBe(true);
  });

  test("a failed judge call holds (never passes) and records the error", async () => {
    const boom: ModelCaller = async () => {
      throw new Error("judge down");
    };
    const r = await replayCandidates([candidate()], corpus3x3(), { caller: boom, thresholds: SMALL });
    const v = r.byKey.get("use-uuid")!;
    expect(v.inconclusive).toBe(true);
    expect(v.passed).toBe(false);
    expect(r.errors.some((e) => e.includes("judge"))).toBe(true);
  });

  test("empty rules is a clean no-op with no call", async () => {
    let calls = 0;
    const r = await replayCandidates([], corpus3x3(), { caller: stubJudge({}, () => calls++), thresholds: SMALL });
    expect(calls).toBe(0);
    expect(r.byKey.size).toBe(0);
    expect(r.inconclusive).toBe(false);
  });
});
