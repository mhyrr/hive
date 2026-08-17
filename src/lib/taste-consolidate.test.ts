import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelCaller } from "./extract";
import { getHivePaths, type HivePaths } from "./paths";
import {
  mergeConsolidateResults,
  runTasteConsolidate,
  validateCoherenceDecision,
  type CoherenceDecision,
  type TasteConsolidateResult,
} from "./taste-consolidate";
import {
  generalTasteDir,
  projectTasteDir,
  readTasteUnits,
  recordNegative,
  searchTasteForWork,
  unitHash,
  writeTasteUnit,
} from "./taste-store";
import type { ReplayCorpus } from "./taste-replay";
import type { TasteCandidate } from "./taste-types";

const PROJECT = "demo";
const PRINCIPLES = "### Solve the right problem\nFind the why under the ask.\n\n### As simple as possible\nThe best code is the code you didn't write.";

function candidate(over: Partial<TasteCandidate> = {}): TasteCandidate {
  return {
    category: "DESIGN",
    tier: "FUZZY",
    scope: { kind: "project" },
    reasoning: "Trace every consumer of an invariant before relaxing it.",
    delta: { before: "updated one read path", after: "updated all read paths" },
    reason_source: "stated",
    rule_statement: "When relaxing a constraint, update every query that assumed the old cardinality",
    canonical_example: { bad: "deduped one query", good: "grepped all queries" },
    check_sketch: null,
    evidence: [{ anchor: { sessionFile: "s1.jsonl", id: "u1", ts: null }, quote: "this was my miss", confidence: 0.9 }],
    dedupe_key: "trace-all-read-paths",
    provenance: "id=u1",
    ...over,
  };
}

/** A caller that replies with a fixed set of coherence decisions as JSON. */
function stubCaller(decisions: Partial<CoherenceDecision>[]): ModelCaller {
  return async (input) => ({
    provider: input.provider,
    model: input.modelId,
    text: JSON.stringify(decisions),
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    durationMs: 5,
  });
}

/**
 * Routes by system prompt: coherence decisions for the TC call, replay
 * judgments for the replay judge call (both share TC's single `caller` seam).
 */
function dualCaller(
  decisions: Partial<CoherenceDecision>[],
  replayFlags: Record<string, string[]>,
): ModelCaller {
  return async (input) => {
    const isReplay = input.systemPrompt.startsWith("You are validating candidate taste rules");
    const payload = isReplay
      ? Object.entries(replayFlags).map(([dedupe_key, flagged]) => ({ dedupe_key, flagged }))
      : decisions;
    return { provider: input.provider, model: input.modelId, text: JSON.stringify(payload), inputTokens: 100, outputTokens: 20, durationMs: 3 };
  };
}

/** A balanced 3+3 replay corpus (events unused by the stub judge). */
function replayCorpus(): ReplayCorpus {
  const w = (windowId: string, label: "correction" | "accepted"): ReplayCorpus["windows"][number] => ({
    windowId,
    label,
    sessionFile: "h.jsonl",
    events: [],
  });
  return {
    windows: [w("w0", "correction"), w("w1", "correction"), w("w2", "correction"), w("w3", "accepted"), w("w4", "accepted"), w("w5", "accepted")],
    positives: 3,
    negatives: 3,
  };
}

const REPLAY_T = { minWindows: 4, minPositives: 2, minNegatives: 2, sample: 4 };

/** Two same-hash candidates from distinct sessions → recurrence 2 (clears the gate). */
function recurringPair(over: Partial<TasteCandidate> = {}): TasteCandidate[] {
  return [
    candidate(over),
    candidate({ ...over, evidence: [{ anchor: { sessionFile: "s2.jsonl", id: "u9", ts: null }, quote: "again", confidence: 0.8 }] }),
  ];
}

let home: string;
let paths: HivePaths;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hive-tc-"));
  paths = getHivePaths(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function opts(caller: ModelCaller, over: Record<string, unknown> = {}) {
  return { paths, projectId: PROJECT, caller, principlesText: PRINCIPLES, now: "2026-06-24", ...over };
}

describe("validateCoherenceDecision", () => {
  const HEADS = new Set(["Solve the right problem", "As simple as possible"]);

  test("rejects unknown dedupe_keys and coerces fields", () => {
    const known = new Set(["a"]);
    expect(validateCoherenceDecision({ dedupe_key: "ghost", coherence: "uncovered" }, known, HEADS)).toBeNull();
    const d = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "covered", ladders_up_to: "Solve the right problem", human_confirmed: true },
      known,
      HEADS,
    );
    expect(d?.coherence).toBe("covered");
    expect(d?.ladders_up_to).toBe("Solve the right problem");
    expect(d?.wanted_principle).toBeNull();
    expect(d?.human_confirmed).toBe(true);
  });

  test("strips ladders_up_to when coherence is uncovered", () => {
    const d = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "uncovered", ladders_up_to: "Solve the right problem" },
      new Set(["a"]),
      HEADS,
    );
    expect(d?.ladders_up_to).toBeNull();
  });

  test("an INVENTED rung demotes to uncovered and is kept as wanted_principle", () => {
    // The failure this closes: `ladders_up_to` was free text, so TC minted rungs
    // ("Conservation of complexity", "Iterate") and reported `instantiates` for
    // everything — which is why tension never fired across 90 candidates.
    const d = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "covered", ladders_up_to: "Conservation of complexity" },
      new Set(["a"]),
      HEADS,
    );
    expect(d?.coherence).toBe("uncovered");
    expect(d?.ladders_up_to).toBeNull();
    expect(d?.wanted_principle).toBe("Conservation of complexity");
  });

  test("a claimed relation with no named principle also demotes to uncovered", () => {
    const d = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "extends", ladders_up_to: null },
      new Set(["a"]),
      HEADS,
    );
    expect(d?.coherence).toBe("uncovered");
    expect(d?.wanted_principle).toBeNull();
  });

  test("a contradiction must still name a real principle to count as one", () => {
    const bogus = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "contradicts", ladders_up_to: "Ship it fast", tension_note: "principle-too-broad" },
      new Set(["a"]),
      HEADS,
    );
    expect(bogus?.coherence).toBe("uncovered");
    expect(bogus?.tension_note).toBeNull();

    const real = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "contradicts", ladders_up_to: "As simple as possible", tension_note: "principle-too-broad: not here" },
      new Set(["a"]),
      HEADS,
    );
    expect(real?.coherence).toBe("contradicts");
    expect(real?.tension_note).toContain("principle-too-broad");
  });

  test("an unparseable coherence falls back to uncovered, never to a laddered class", () => {
    const d = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "instantiates", ladders_up_to: "Solve the right problem" },
      new Set(["a"]),
      HEADS,
    );
    expect(d?.coherence).toBe("uncovered");
  });
});

describe("deterministic partition", () => {
  test("session-noise is dropped, never written", async () => {
    const r = await runTasteConsolidate([candidate({ scope: { kind: "session-noise" }, dedupe_key: "noise" })], opts(stubCaller([])));
    expect(r.droppedNoise).toBe(1);
    expect(r.written).toBe(0);
    expect(r.decisions[0]!.routed).toBe("dropped-noise");
  });

  test("a previously-killed dedupe_key is dropped as a negative", async () => {
    await recordNegative(projectTasteDir(paths, PROJECT), "trace-all-read-paths");
    const r = await runTasteConsolidate([candidate()], opts(stubCaller([])));
    expect(r.droppedNegative).toBe(1);
    expect(r.written).toBe(0);
  });

  test("CONTEXTUAL candidates are handed back to the fact-candidates queue", async () => {
    const r = await runTasteConsolidate(
      [candidate({ tier: "CONTEXTUAL", dedupe_key: "repo-uses-x", reasoning: "This repo stores money in cents." })],
      opts(stubCaller([])),
    );
    expect(r.handoffsToFacts).toHaveLength(1);
    expect(r.decisions[0]!.routed).toBe("fact-candidates");
    expect(r.written).toBe(0);
    const candFile = join(home, "memory", "projects", PROJECT, "candidates.md");
    const text = await Bun.file(candFile).text();
    expect(text).toContain("This repo stores money in cents.");
    expect(text).toContain("taste-handoff");
  });
});

describe("recurrence gate", () => {
  test("a single-session first-sighting lands in holding, not review", async () => {
    const r = await runTasteConsolidate([candidate()], opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered" }])));
    expect(r.holding).toBe(1);
    expect(r.reviewEligible).toBe(0);
    const u = (await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!;
    expect(u.status).toBe("holding");
    expect(u.recurrence).toBe(1);
  });

  test("recurring across two distinct sessions in one run is review-eligible", async () => {
    const a = candidate(); // session s1
    const b = candidate({ evidence: [{ anchor: { sessionFile: "s2.jsonl", id: "u9", ts: null }, quote: "again", confidence: 0.8 }] });
    const r = await runTasteConsolidate([a, b], opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered" }])));
    expect(r.admitted).toBe(1);
    expect(r.reviewEligible).toBe(0);
    const u = (await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!;
    expect(u.status).toBe("active");
    expect(u.recurrence).toBe(2);
    // Evidence from both sessions merged onto the one unit.
    expect(u.evidence.map((e) => e.anchor.id).sort()).toEqual(["u1", "u9"]);
  });

  test("explicit human confirmation bypasses the recurrence gate", async () => {
    const r = await runTasteConsolidate(
      [candidate()],
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered", human_confirmed: true }])),
    );
    expect(r.admitted).toBe(1);
    expect((await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!.status).toBe("active");
  });
});

describe("coherence + conflict", () => {
  test("instantiates persists ladders_up_to onto the unit", async () => {
    const r = await runTasteConsolidate(
      [candidate()],
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "covered", ladders_up_to: "Solve the right problem" }])),
    );
    expect(r.decisions[0]!.ladders_up_to).toBe("Solve the right problem");
    const u = (await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!;
    expect(u.ladders_up_hint).toBe("Solve the right problem");
  });

  test("a conflict with an existing unit is surfaced with the resolved hash", async () => {
    // Seed an existing active unit to conflict against.
    const existing = candidate({ dedupe_key: "always-dedupe-in-one-place", reasoning: "Always dedupe in exactly one query." });
    await writeTasteUnit(projectTasteDir(paths, PROJECT), existing, { status: "active" });

    const r = await runTasteConsolidate(
      [candidate({ dedupe_key: "spread-dedupe", reasoning: "Spread dedupe across read paths." })],
      opts(stubCaller([{ dedupe_key: "spread-dedupe", coherence: "uncovered", conflict_with: "always-dedupe-in-one-place" }])),
    );
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.conflict_with).toBe(unitHash(existing));
  });

  test("a re-observed unit never conflicts with its own prior version", async () => {
    // Run 1: seed the unit (holding).
    await runTasteConsolidate([candidate()], opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered" }])));
    // Run 2: the model (mistakenly) points conflict_with at the same key.
    const r = await runTasteConsolidate(
      [candidate()],
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered", conflict_with: "trace-all-read-paths" }])),
    );
    expect(r.conflicts).toHaveLength(0);
    expect(r.decisions[0]!.conflict_with).toBeNull();
    // And the second observation still accrues recurrence → auto-admitted.
    expect(r.admitted).toBe(1);
    expect((await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!.recurrence).toBe(2);
  });

  test("tensions are collected for human adjudication", async () => {
    const r = await runTasteConsolidate(
      [candidate()],
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "contradicts", ladders_up_to: "As simple as possible", tension_note: "scoped-exception: only for hot paths" }])),
    );
    expect(r.tensions).toHaveLength(1);
    expect(r.tensions[0]!.tension_note).toContain("scoped-exception");
  });

  test("a gate-clearing CONTRADICTION holds at pending instead of auto-admitting", async () => {
    // Same recurrence as the auto-admit case above — only the coherence differs.
    // A unit that fights an apex principle would be retrieved alongside that
    // principle, which is injected into every session, so it waits for a human.
    const r = await runTasteConsolidate(
      recurringPair(),
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "contradicts", ladders_up_to: "As simple as possible", tension_note: "principle-too-broad: the guard is not theatre here" }])),
    );
    expect(r.admitted).toBe(0);
    expect(r.reviewEligible).toBe(1);
    expect(r.decisions[0]!.status).toBe("pending");

    const u = (await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!;
    expect(u.status).toBe("pending");
    expect(u.recurrence).toBe(2);
  });

  test("a held contradiction is never retrievable", async () => {
    await runTasteConsolidate(
      recurringPair({ scope: { kind: "general-taste" } }),
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "contradicts", ladders_up_to: "Solve the right problem", tension_note: "candidate-wrong" }])),
    );
    const hits = await searchTasteForWork(paths, PROJECT, "DESIGN");
    expect(hits).toHaveLength(0);
  });

  test("an admitted unit IS retrievable in the same nightly", async () => {
    await runTasteConsolidate(
      recurringPair({ scope: { kind: "general-taste" } }),
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "covered", ladders_up_to: "As simple as possible" }])),
    );
    const hits = await searchTasteForWork(paths, PROJECT, "DESIGN");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.unit.dedupe_key).toBe("trace-all-read-paths");
  });
});

describe("scope routing + resilience", () => {
  test("general-taste units land in the cross-project store", async () => {
    await runTasteConsolidate(
      [candidate({ scope: { kind: "general-taste" }, dedupe_key: "cross", reasoning: "Read the actual thing before reasoning about it." })],
      opts(stubCaller([{ dedupe_key: "cross", coherence: "uncovered" }])),
    );
    expect(await readTasteUnits(generalTasteDir(paths))).toHaveLength(1);
    expect(await readTasteUnits(projectTasteDir(paths, PROJECT))).toHaveLength(0);
  });

  test("a failed coherence call still routes and writes (enrichment, not a gate)", async () => {
    const boom: ModelCaller = async () => {
      throw new Error("model down");
    };
    const r = await runTasteConsolidate([candidate()], opts(boom));
    expect(r.errors.some((e) => e.includes("coherence call"))).toBe(true);
    expect(r.written).toBe(1);
    expect(r.decisions[0]!.coherence).toBeNull();
  });

  test("empty input is a clean no-op", async () => {
    const r = await runTasteConsolidate([], opts(stubCaller([])));
    expect(r.written).toBe(0);
    expect(r.decisions).toHaveLength(0);
    expect(r.usage).toBeNull();
  });
});

describe("replay gate (design §9)", () => {
  test("a recurring FUZZY candidate that PASSES replay is admitted", async () => {
    const r = await runTasteConsolidate(
      recurringPair(),
      opts(dualCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered" }], { "trace-all-read-paths": ["w0", "w1"] }), {
        replayCorpus: replayCorpus(),
        replayThresholds: REPLAY_T,
      }),
    );
    expect(r.admitted).toBe(1);
    expect(r.decisions[0]!.replay?.passed).toBe(true);
    expect(r.decisions[0]!.status).toBe("active");
    expect(r.replayUsage).not.toBeNull();
  });

  test("a recurring FUZZY candidate that FAILS replay stays in holding (recurrence alone is not enough)", async () => {
    const r = await runTasteConsolidate(
      recurringPair(),
      opts(dualCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered" }], { "trace-all-read-paths": ["w3"] }), {
        replayCorpus: replayCorpus(),
        replayThresholds: REPLAY_T,
      }),
    );
    expect(r.reviewEligible).toBe(0);
    expect(r.holding).toBe(1);
    expect(r.decisions[0]!.replay?.passed).toBe(false);
    expect(r.decisions[0]!.status).toBe("holding");
  });

  test("DETERMINISTIC candidates skip replay and promote on recurrence alone", async () => {
    const r = await runTasteConsolidate(
      recurringPair({ tier: "DETERMINISTIC", check_sketch: "grep for the thing" }),
      // A failing replay map is supplied; DETERMINISTIC must ignore it.
      opts(dualCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered" }], { "trace-all-read-paths": ["w3"] }), {
        replayCorpus: replayCorpus(),
        replayThresholds: REPLAY_T,
      }),
    );
    expect(r.admitted).toBe(1);
    expect(r.decisions[0]!.replay).toBeNull(); // never judged
    expect(r.replayUsage).toBeNull(); // no eligible FUZZY candidate → no judge call
  });

  test("humanConfirmed bypasses replay entirely", async () => {
    const r = await runTasteConsolidate(
      [candidate()],
      opts(dualCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered", human_confirmed: true }], { "trace-all-read-paths": ["w3"] }), {
        replayCorpus: replayCorpus(),
        replayThresholds: REPLAY_T,
      }),
    );
    expect(r.admitted).toBe(1);
    expect(r.decisions[0]!.replay).toBeNull();
    expect(r.replayUsage).toBeNull();
  });

  test("a thin replay corpus holds a recurring FUZZY candidate (inconclusive, never fail open)", async () => {
    const thin: ReplayCorpus = {
      windows: [
        { windowId: "w0", label: "correction", sessionFile: "h", events: [] },
        { windowId: "w1", label: "accepted", sessionFile: "h", events: [] },
      ],
      positives: 1,
      negatives: 1,
    };
    const r = await runTasteConsolidate(
      recurringPair(),
      opts(dualCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered" }], { "trace-all-read-paths": ["w0", "w1"] }), {
        replayCorpus: thin,
        replayThresholds: REPLAY_T,
      }),
    );
    expect(r.reviewEligible).toBe(0);
    expect(r.holding).toBe(1);
    expect(r.decisions[0]!.replay?.inconclusive).toBe(true);
  });

  test("replay disabled (no corpus) gates on recurrence alone — backward compatible", async () => {
    const r = await runTasteConsolidate(
      recurringPair(),
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "uncovered" }])),
    );
    expect(r.admitted).toBe(1);
    expect(r.decisions[0]!.replay).toBeNull();
    expect(r.replayUsage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeConsolidateResults — combine per-project TC results into one artifact
// ---------------------------------------------------------------------------

describe("mergeConsolidateResults", () => {
  function result(over: Partial<TasteConsolidateResult> = {}): TasteConsolidateResult {
    return {
      decisions: [],
      written: 0,
      admitted: 0,
      reviewEligible: 0,
      holding: 0,
      handoffsToFacts: [],
      conflicts: [],
      tensions: [],
      newPrincipleProposals: [],
      droppedNoise: 0,
      droppedNegative: 0,
      usage: null,
      replayUsage: null,
      errors: [],
      ...over,
    };
  }

  test("sums counts, concatenates lists, and folds usage across projects", () => {
    const a = result({
      written: 2,
      admitted: 1,
      reviewEligible: 1,
      holding: 1,
      droppedNoise: 1,
      newPrincipleProposals: ["alpha proposal"],
      errors: ["alpha: oops"],
      usage: { inputTokens: 100, outputTokens: 20, durationMs: 50, provider: "anthropic", model: "claude-opus-4-6", usd: 0.5 },
    });
    const b = result({
      written: 1,
      admitted: 1,
      holding: 1,
      droppedNegative: 2,
      newPrincipleProposals: ["bravo proposal"],
      usage: { inputTokens: 200, outputTokens: 30, durationMs: 70, provider: "anthropic", model: "claude-opus-4-6", usd: 0.75 },
    });

    const merged = mergeConsolidateResults([a, b]);
    expect(merged.written).toBe(3);
    expect(merged.admitted).toBe(2);
    expect(merged.reviewEligible).toBe(1);
    expect(merged.holding).toBe(2);
    expect(merged.droppedNoise).toBe(1);
    expect(merged.droppedNegative).toBe(2);
    expect(merged.newPrincipleProposals).toEqual(["alpha proposal", "bravo proposal"]);
    expect(merged.errors).toEqual(["alpha: oops"]);
    expect(merged.usage?.inputTokens).toBe(300);
    expect(merged.usage?.outputTokens).toBe(50);
    expect(merged.usage?.usd).toBeCloseTo(1.25, 5);
  });

  test("usage stays null when no project made a coherence call", () => {
    const merged = mergeConsolidateResults([result(), result()]);
    expect(merged.usage).toBeNull();
  });

  test("empty input yields a clean zero result", () => {
    const merged = mergeConsolidateResults([]);
    expect(merged.written).toBe(0);
    expect(merged.decisions).toHaveLength(0);
    expect(merged.usage).toBeNull();
  });
});
